import { AppError } from "../domain/errors";
import { BookingResult, CreateBookingInput, ReservationStatus } from "../domain/types";
import { pool, withTransaction } from "../db/pool";
import { attachReservationToCallLog, upsertCallLog } from "../repositories/callLogs";
import {
  cancelReservation,
  createReservation,
  getReservationById,
  getReservationByCallLogId,
  updateReservation,
  upsertCustomer
} from "../repositories/reservations";
import { getRestaurantTimezone } from "../repositories/restaurants";
import { checkAvailability, requireAvailableTable } from "./availabilityService";
import {
  enqueueCancelForReservation,
  enqueueCreateForReservation
} from "./calcomService";
import { formatVoiceTime, todayInTz } from "../utils/time";
import { normalizePhone } from "../utils/phone";

export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  // Idempotency: if Retell retries the create_booking tool call, return the
  // already-created reservation rather than inserting a duplicate.
  if (input.callLogId) {
    const existing = await getReservationByCallLogId(input.callLogId);
    if (existing) {
      return {
        bookingId: existing.id,
        status: existing.status,
        confirmationMessage: `Confirmed. ${input.customerName} has a table for ${existing.party_size} on ${existing.reservation_date} at ${formatVoiceTime(existing.start_time.slice(0, 5))}.`
      };
    }
  }

  // Defence-in-depth date sanity check (audit Sweep B). The Retell prompt now
  // has a Time anchor rule (PR #15) telling Bella to never pass a past year,
  // but a prompt edge case + LLM hallucination could still slip a 2024 date
  // through. Reject it here before we burn a DB row + an outbox push that
  // Cal.com would reject anyway. Error messages are LLM-friendly so the
  // agent reads them and re-prompts the caller.
  const restaurantTz = await getRestaurantTimezone(input.restaurantId);
  const todayIso = todayInTz(restaurantTz);
  if (input.date < todayIso) {
    throw new AppError(
      400,
      "BOOKING_DATE_IN_PAST",
      `I can't book a date in the past. Today is ${todayIso}; you asked for ${input.date}. What date did you mean?`
    );
  }
  const oneYearOutDate = new Date(`${todayIso}T00:00:00Z`);
  oneYearOutDate.setUTCFullYear(oneYearOutDate.getUTCFullYear() + 1);
  const oneYearOutIso = oneYearOutDate.toISOString().slice(0, 10);
  if (input.date > oneYearOutIso) {
    throw new AppError(
      400,
      "BOOKING_DATE_TOO_FAR",
      `I can only book up to a year ahead (so by ${oneYearOutIso}). You asked for ${input.date}. What date did you mean?`
    );
  }

  const normalizedPhone = normalizePhone(input.customerPhone) ?? input.customerPhone;

  const lockClient = await pool.connect();

  try {
    await lockClient.query("BEGIN");
    // Per-slot advisory lock (was per-day). Two callers booking different
    // times on the same day no longer block each other.
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
      `${input.restaurantId}:${input.date}:${input.time}`
    ]);

    const callLogId =
      input.callLogId ??
      (input.providerCallId
        ? await upsertCallLog({
            restaurantId: input.restaurantId,
            provider: input.provider ?? "retell",
            providerCallId: input.providerCallId,
            callerPhone: normalizedPhone,
            status: "in_progress",
            startedAt: new Date().toISOString()
          }, lockClient)
        : undefined);

    // Re-check inside the locked transaction. The earlier check_availability
    // tool call ran without a lock; in the time it took the caller to confirm,
    // the slot may have been taken.
    const availability = await checkAvailability(
      {
        restaurantId: input.restaurantId,
        date: input.date,
        time: input.time,
        partySize: input.partySize
      },
      lockClient
    );
    const tableId = requireAvailableTable(availability);

    const customerId = await upsertCustomer(
      {
        restaurantId: input.restaurantId,
        name: input.customerName,
        phone: normalizedPhone
      },
      lockClient
    );

    const reservation = await createReservation(
      {
        restaurantId: input.restaurantId,
        customerId,
        tableId,
        date: input.date,
        time: input.time,
        partySize: input.partySize,
        source: input.source,
        notes: input.notes,
        callLogId
      },
      lockClient
    );

    if (callLogId) {
      await attachReservationToCallLog(callLogId, reservation.id, lockClient);
    }

    // Cal.com mirror — enqueue OUTSIDE the advisory-lock-held critical query
    // ordering but still INSIDE the transaction, so atomicity holds. No-op
    // when CALCOM_SYNC_ENABLED=false (defensive — no Cal.com side-effects in
    // tests / dev).
    await enqueueCreateForReservation(reservation.id, lockClient);

    await lockClient.query("COMMIT");

    return {
      bookingId: reservation.id,
      status: reservation.status,
      confirmationMessage: `Confirmed. ${input.customerName} has a table for ${input.partySize} on ${input.date} at ${formatVoiceTime(input.time)}.`
    };
  } catch (error) {
    await lockClient.query("ROLLBACK");
    // The DB-level safety-net unique index (migration 003) catches double-booking races
    // that bypass application logic. Surface as a clean availability message.
    if (error instanceof Error && /idx_reservations_no_double_book/.test(error.message)) {
      throw new AppError(
        409,
        "TABLE_JUST_TAKEN",
        "That time just got booked by another caller. Please pick another time."
      );
    }
    throw error;
  } finally {
    lockClient.release();
  }
}

export async function modifyBooking(input: {
  bookingId: string;
  customerName?: string;
  date?: string;
  time?: string;
  partySize?: number;
  notes?: string;
  status?: ReservationStatus;
}): Promise<BookingResult> {
  // Audit Sweep B fix: the previous implementation ran updateReservation and
  // the customers UPDATE on TWO separate pool connections — a race window
  // where step 1 commits and step 2 fails leaves a partial mutation visible.
  // Wrap everything in a single transaction so it's all-or-nothing.
  //
  // Also fixes the dead conditional that compared `input.customerName` (a
  // string) to `current.customer_id` (a UUID) — those are never equal, so
  // the UPDATE used to run even when the name was unchanged. Now we fetch
  // the actual current customer name and skip the UPDATE iff it matches.
  //
  // Audit H3: take the same per-slot advisory lock that createBooking uses
  // when date/time is changing, so a concurrent create on the destination
  // slot can't race past our availability re-check. Catch the partial-unique
  // index violation as a friendly 409 (the DB safety net used to surface as a
  // raw 500 from modifyBooking).
  try {
    return await withTransaction(async (db) => {
      const current = await getReservationById(input.bookingId, db);

      if (!current) {
        throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
      }

      const nextDate = input.date ?? current.reservation_date;
      const nextTime = input.time ?? current.start_time.slice(0, 5);
      const nextPartySize = input.partySize ?? current.party_size;
      const shouldRecheckAvailability =
        input.date !== undefined || input.time !== undefined || input.partySize !== undefined;

      // Lock the DESTINATION slot whenever the slot is changing, so a
      // concurrent createBooking on (restaurant, nextDate, nextTime) blocks
      // until we commit (or rolls back if it lost the race).
      if (shouldRecheckAvailability) {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `${current.restaurant_id}:${nextDate}:${nextTime}`
        ]);
      }

      let tableId: string | undefined;

      if (shouldRecheckAvailability && (input.status ?? current.status) !== "cancelled") {
        const availability = await checkAvailability(
          {
            restaurantId: current.restaurant_id,
            date: nextDate,
            time: nextTime,
            partySize: nextPartySize,
            excludeReservationId: current.id
          },
          db
        );
        tableId = requireAvailableTable(availability);
      }

      const reservation = await updateReservation(
        {
          id: current.id,
          tableId,
          date: input.date,
          time: input.time,
          partySize: input.partySize,
          notes: input.notes,
          status: input.status
        },
        db
      );

      // Name correction — only fire the UPDATE if the name actually changed.
      // Fetch current customer name inside the txn so it shares the snapshot.
      let nameChanged = false;
      if (input.customerName && input.customerName.trim()) {
        const newName = input.customerName.trim();
        const currentNameResult = await db.query<{ name: string }>(
          "SELECT name FROM customers WHERE id = $1",
          [current.customer_id]
        );
        const currentName = currentNameResult.rows[0]?.name ?? "";
        if (currentName !== newName) {
          await db.query("UPDATE customers SET name = $1 WHERE id = $2", [
            newName,
            current.customer_id
          ]);
          nameChanged = true;
        }
      }

      return {
        bookingId: reservation.id,
        status: reservation.status,
        confirmationMessage: nameChanged
          ? `Updated. The booking is under ${input.customerName!.trim()} now.`
          : `Updated. The booking is now ${reservation.status}.`
      };
    });
  } catch (error) {
    if (error instanceof Error && /idx_reservations_no_double_book/.test(error.message)) {
      throw new AppError(
        409,
        "TABLE_JUST_TAKEN",
        "That time just got booked by another caller. Please pick another time."
      );
    }
    throw error;
  }
}

export async function cancelBooking(input: {
  bookingId: string;
  reason?: string;
}): Promise<BookingResult> {
  // Cancel and Cal.com-outbox-enqueue in one transaction so a row is never
  // marked cancelled in our DB while the calendar mirror remains "confirmed".
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query<{
      id: string;
      calcom_booking_uid: string | null;
    }>("SELECT id, calcom_booking_uid FROM reservations WHERE id = $1", [input.bookingId]);
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
    }
    const calcomUid = current.rows[0]!.calcom_booking_uid;

    const reservation = await cancelReservation({ id: input.bookingId, reason: input.reason }, client);

    await enqueueCancelForReservation(reservation.id, calcomUid, input.reason, client);

    await client.query("COMMIT");

    return {
      bookingId: reservation.id,
      status: reservation.status,
      confirmationMessage: "Cancelled. The reservation has been cancelled."
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* already in error path */
    }
    throw error;
  } finally {
    client.release();
  }
}
