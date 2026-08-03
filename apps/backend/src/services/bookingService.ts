import { AppError } from "../domain/errors";
import { BookingResult, CreateBookingInput, ReservationStatus } from "../domain/types";
import { pool, withTransaction } from "../db/pool";
import { attachReservationToCallLog, upsertCallLog } from "../repositories/callLogs";
import {
  cancelReservation,
  createReservation,
  getReservationById,
  getReservationByCallLogId,
  getReservationForTenant,
  updateReservation,
  upsertCustomer
} from "../repositories/reservations";
import { getRestaurantSettings, getRestaurantTimezone } from "../repositories/restaurants";
import { listAvailableTables } from "../repositories/availability";
import { checkAvailability, requireAvailableTable } from "./availabilityService";
import {
  enqueueCancelForReservation,
  enqueueCreateForReservation,
  enqueueRescheduleForReservation
} from "./calcomService";
import { formatVoiceTime, isWithinOpeningHours, todayInTz } from "../utils/time";
import { normalizePhone } from "../utils/phone";

// The DB-level safety net catches double-booking races that bypass application
// logic. Surface as a clean availability message rather than a generic 500;
// pass anything else through.
//
// `reservations_no_overlap` (migration 025) is the real guard: a gist exclusion
// constraint over the booking's timestamp range, so it rejects any overlap, not
// just two bookings starting at the same minute. The older
// `idx_reservations_no_double_book` name is still matched so this keeps working
// during a rollback to an image built before that migration.
function rethrowAsDoubleBookConflict(error: unknown): never {
  if (error instanceof Error && /reservations_no_overlap|idx_reservations_no_double_book/.test(error.message)) {
    throw new AppError(
      409,
      "TABLE_JUST_TAKEN",
      "That time just got booked by another caller. Please pick another time."
    );
  }
  throw error;
}

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

  // Audit M1: if libphonenumber can't parse what Retell transcribed, reject
  // explicitly rather than silently storing the raw string. Message is
  // LLM-readable so Bella re-prompts the caller instead of dumping a 500.
  let normalizedPhone = normalizePhone(input.customerPhone);
  if (!normalizedPhone) {
    if (input.allowUnparseablePhone && input.customerPhone) {
      // Web booking with no usable phone — keep the sentinel/raw value so the
      // reservation still lands (the guest already has a Cal.com confirmation);
      // the caller has flagged it for staff review.
      normalizedPhone = input.customerPhone;
    } else {
      throw new AppError(
        400,
        "CUSTOMER_PHONE_INVALID",
        "That phone number didn't quite come through. Could you read it back digit by digit?"
      );
    }
  }

  const lockClient = await pool.connect();

  try {
    await lockClient.query("BEGIN");
    // Per-DAY advisory lock. This was per-slot (restaurant:date:time), which
    // looked more granular but could not serialise the bookings that actually
    // conflict: a 19:00 booking lasting 90 minutes and a 19:30 booking on the
    // same table took different lock keys, ran concurrently, and both committed.
    // Bookings overlap across start times, so the lock has to span the day.
    // At ~10 calls/day the reduced concurrency costs nothing; the exclusion
    // constraint in migration 025 is the real guarantee either way.
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
      `${input.restaurantId}:${input.date}`
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

    let tableId: string;

    // Loaded once, before the branch, because the duration is now stored ON the
    // reservation. Snapshotting it means a later change to the restaurant's
    // booking duration cannot retroactively re-length or re-shorten bookings
    // that were already taken — which would silently open or close overlap
    // windows against them.
    const settings = await getRestaurantSettings(input.restaurantId, lockClient);
    const durationMinutes = settings.bookingDurationMinutes;

    if (input.tableId) {
      if (!isWithinOpeningHours(input.date, input.time, settings.bookingDurationMinutes, settings.openingHours)) {
        throw new AppError(
          409,
          "BOOKING_NOT_AVAILABLE",
          "The restaurant is not open for bookings at the selected time."
        );
      }

      const availableTables = await listAvailableTables(
        {
          restaurantId: input.restaurantId,
          date: input.date,
          time: input.time,
          partySize: input.partySize,
          durationMinutes: settings.bookingDurationMinutes
        },
        lockClient
      );
      const selectedTable = availableTables.find((table) => table.id === input.tableId);

      if (!selectedTable) {
        throw new AppError(
          409,
          "TABLE_NOT_AVAILABLE",
          "That table is no longer available at the selected time. Please choose another table.",
          { selectedTableId: input.tableId }
        );
      }

      tableId = selectedTable.id;
    } else {
      // Re-check inside the locked transaction. The earlier check_availability
      // tool call ran without a lock; in the time it took the caller to confirm,
      // the slot may have been taken.
      const availability = await checkAvailability(
        {
          restaurantId: input.restaurantId,
          date: input.date,
          time: input.time,
          partySize: input.partySize,
          seatingPreference: input.seatingPreference
        },
        lockClient
      );
      tableId = requireAvailableTable(availability);
    }

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
        callLogId,
        durationMinutes
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
    rethrowAsDoubleBookConflict(error);
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
  // Tenant guard: when set, the booking is looked up + updated scoped to this
  // restaurant, so a cross-tenant booking id resolves to 404. Dashboard and
  // voice callers pass it; omitted only by trusted internal callers.
  restaurantId?: string;
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
      const current = input.restaurantId
        ? await getReservationForTenant(input.bookingId, input.restaurantId, db)
        : await getReservationById(input.bookingId, db);

      if (!current) {
        throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
      }

      const nextDate = input.date ?? current.reservation_date;
      const nextTime = input.time ?? current.start_time.slice(0, 5);
      const nextPartySize = input.partySize ?? current.party_size;
      const shouldRecheckAvailability =
        input.date !== undefined || input.time !== undefined || input.partySize !== undefined;

      // Lock the DESTINATION DAY whenever the slot is changing, so a concurrent
      // createBooking on that day blocks until we commit (or rolls back if it
      // lost the race). Keyed on the day rather than the exact time for the same
      // reason as createBooking: overlapping bookings have different start
      // times, so a per-time key never made the conflicting writers meet.
      // Only the destination needs locking — vacating the old slot can only free
      // capacity, never create an overlap.
      if (shouldRecheckAvailability) {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `${current.restaurant_id}:${nextDate}`
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
          status: input.status,
          restaurantId: input.restaurantId
        },
        db
      );

      // Cal.com mirror — inside the same transaction, like create and cancel.
      // Until this existed, a moved booking NEVER propagated: the calendar
      // kept the old time forever, and a dashboard cancel via PATCH status
      // skipped the mirror entirely (only POST /bookings/:id/cancel enqueued).
      const becameCancelled =
        input.status === "cancelled" && current.status !== "cancelled";
      const dateOrTimeChanged =
        (input.date !== undefined && input.date !== current.reservation_date) ||
        (input.time !== undefined && input.time !== current.start_time.slice(0, 5));
      if (becameCancelled) {
        await enqueueCancelForReservation(
          current.id,
          current.calcom_booking_uid,
          "Cancelled via VoxTable",
          db
        );
      } else if (dateOrTimeChanged) {
        await enqueueRescheduleForReservation(current.id, db);
      }

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
    rethrowAsDoubleBookConflict(error);
  }
}

export async function cancelBooking(input: {
  bookingId: string;
  reason?: string;
  // Tenant guard — see modifyBooking. A cross-tenant id becomes a 404.
  restaurantId?: string;
}): Promise<BookingResult> {
  // Cancel and Cal.com-outbox-enqueue in one transaction so a row is never
  // marked cancelled in our DB while the calendar mirror remains "confirmed".
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = input.restaurantId
      ? await client.query<{
          id: string;
          status: string;
          calcom_booking_uid: string | null;
        }>(
          "SELECT id, status, calcom_booking_uid FROM reservations WHERE id = $1 AND restaurant_id = $2",
          [input.bookingId, input.restaurantId]
        )
      : await client.query<{
          id: string;
          status: string;
          calcom_booking_uid: string | null;
        }>("SELECT id, status, calcom_booking_uid FROM reservations WHERE id = $1", [
          input.bookingId
        ]);
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
    }
    const calcomUid = current.rows[0]!.calcom_booking_uid;

    // Audit M3: cancelReservation now returns null when the row was already
    // cancelled (atomic `WHERE status <> 'cancelled'`). Two concurrent cancel
    // calls — only the winner enqueues Cal.com; the loser is a silent no-op
    // returning the already-cancelled state.
    const reservation = await cancelReservation(
      { id: input.bookingId, reason: input.reason, restaurantId: input.restaurantId },
      client
    );

    if (reservation) {
      await enqueueCancelForReservation(reservation.id, calcomUid, input.reason, client);
    }

    await client.query("COMMIT");

    return {
      bookingId: input.bookingId,
      status: "cancelled",
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
