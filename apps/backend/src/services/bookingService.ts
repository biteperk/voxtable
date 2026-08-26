import { AppError } from "../domain/errors";
import { BookingResult, BookingSource, CreateBookingInput, ReservationStatus } from "../domain/types";
import type { PoolClient } from "pg";
import { DbClient, pool, withTransaction } from "../db/pool";
import {
  attachReservationToCallLog,
  getCallLogIdByProviderCallId,
  upsertCallLog
} from "../repositories/callLogs";
import {
  cancelReservation,
  createReservation,
  getReservationById,
  getReservationByCallLogId,
  getReservationForTenant,
  ReservationRow,
  updateReservation,
  upsertCustomer
} from "../repositories/reservations";
import { getRestaurantName, getRestaurantSettings, getRestaurantTimezone } from "../repositories/restaurants";
import { enqueueNotification } from "../repositories/notifications";
import { isSmsEnabled } from "./notificationService";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { listAvailableTables } from "../repositories/availability";
import { checkAvailability, requireAvailableTable } from "./availabilityService";
import {
  enqueueCancelForReservation,
  enqueueCreateForReservation,
  enqueueRescheduleForReservation
} from "./calcomService";
import { formatSmsDate, formatVoiceTime, isWithinOpeningHours, todayInTz } from "../utils/time";
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

// A retried create_booking must return the FIRST reservation, never make a
// second one. Shared by the pre-lock fast path and the re-check inside the
// lock so the two can never word the confirmation differently.
function replayResult(existing: ReservationRow, customerName: string): BookingResult {
  return {
    bookingId: existing.id,
    status: existing.status,
    confirmationMessage: `Confirmed. ${customerName} has a table for ${existing.party_size} on ${existing.reservation_date} at ${formatVoiceTime(existing.start_time.slice(0, 5))}.`
  };
}

// Guest-facing booking SMS. Copy is deliberately GSM-7 only (no em-dash, no
// smart quotes) so each message stays a single 160-char segment — buildPaymentSms
// pays the UCS-2/70-char price for its "—" and these must not repeat that.
// Alphanumeric senders can't receive replies, hence "Do not reply".
export function buildBookingConfirmationSms(input: {
  venueName: string;
  customerName: string;
  partySize: number;
  date: string;
  time: string;
}): string {
  return `${input.venueName}: booking confirmed. ${input.customerName}, party of ${input.partySize}, ${formatSmsDate(input.date)}, ${formatVoiceTime(input.time)}. To change or cancel, call the venue. Do not reply.`;
}

export function buildBookingModifiedSms(input: {
  venueName: string;
  customerName: string;
  partySize: number;
  date: string;
  time: string;
}): string {
  return `${input.venueName}: booking updated. ${input.customerName}, party of ${input.partySize}, ${formatSmsDate(input.date)}, ${formatVoiceTime(input.time)}. Questions? Call the venue. Do not reply.`;
}

export function buildBookingCancelledSms(input: {
  venueName: string;
  date: string;
  time: string;
}): string {
  return `${input.venueName}: your booking for ${formatSmsDate(input.date)}, ${formatVoiceTime(input.time)} has been cancelled. Questions? Call the venue. Do not reply.`;
}

/**
 * Enqueue one guest-facing booking SMS inside the caller's open transaction, or
 * do nothing. Gated on the feature flag AND isSmsEnabled() so rows are only
 * written when the worker can actually drain the SMS channel — a row enqueued
 * with no sender configured would sit pending forever.
 *
 * The recipient must be E.164. Voice bookings always are (createBooking rejects
 * anything normalizePhone can't parse), but web-created bookings can store a
 * "web:<uid>" sentinel via allowUnparseablePhone — Twilio would reject that
 * with a permanent 4xx, so the "+" check makes enqueueing one structurally
 * impossible rather than relying on every caller remembering.
 */
async function enqueueBookingSms(
  input: {
    restaurantId: string;
    recipient: string;
    kind: "booking_confirmation" | "booking_modified" | "booking_cancelled";
    // Lazy so the venue-name lookup only happens once the gates have passed.
    body: () => Promise<string>;
    reservationId: string;
  },
  db: DbClient
): Promise<void> {
  if (!env.BOOKING_CONFIRMATION_SMS_ENABLED || !isSmsEnabled()) return;
  if (!input.recipient.startsWith("+")) return;
  const notificationId = await enqueueNotification(
    {
      restaurantId: input.restaurantId,
      channel: "sms",
      recipient: input.recipient,
      kind: input.kind,
      body: await input.body()
    },
    db
  );
  // Never the body or recipient — the guest's phone number is PII.
  logger.info({
    evt: "booking_sms_enqueued",
    kind: input.kind,
    reservation_id: input.reservationId,
    notification_id: notificationId
  });
}

/**
 * Resolve the call_logs.id this booking should be de-duplicated against.
 *
 * It has to come from provider_call_id, NOT from the tool arguments.
 * `input.callLogId` arrives from the LLM — normalizeBookingArgs reads
 * `parsed.call_log_id` — and Bella has no way to know that UUID, so on a real
 * Retell retry it is always undefined. That made the idempotency guard dead on
 * the only path that needed it: the retry took the day lock, found a DIFFERENT
 * free table (the first booking now occupied the original), and inserted a
 * second confirmed reservation. `reservations_no_overlap` cannot catch that —
 * the table_id differs, so there is no overlap to reject. One caller ended up
 * holding two tables and the dashboard showed only one of them, because
 * attachReservationToCallLog overwrote call_logs.reservation_id.
 */
async function resolveReplayCallLogId(
  input: CreateBookingInput,
  db?: DbClient
): Promise<string | null> {
  if (input.callLogId) return input.callLogId;
  if (!input.providerCallId) return null;
  return getCallLogIdByProviderCallId(
    input.provider ?? "retell",
    input.providerCallId,
    input.restaurantId,
    db
  );
}

export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  // Fast path: an obvious replay returns without taking the day lock at all.
  const replayCallLogId = await resolveReplayCallLogId(input);
  if (replayCallLogId) {
    const existing = await getReservationByCallLogId(replayCallLogId);
    if (existing) {
      return replayResult(existing, input.customerName);
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

  // Connect INSIDE the try. `connectionTimeoutMillis` is 5 s (db/pool.ts) and a
  // burst of concurrent web webhooks each holds a write connection for the
  // length of the day lock below, so exhaustion here is a real failure mode —
  // not a theoretical one. Outside the try it rejected past every handler that
  // knows what to do about it.
  let lockClient: PoolClient | undefined;
  try {
    lockClient = await pool.connect();
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

    // resolveReplayCallLogId already returned the id when the call log exists,
    // so only create one when it genuinely does not. Skipping the redundant
    // upsert also stops the booking path rewinding an already-'completed' call
    // log back to 'in_progress'.
    const callLogId =
      replayCallLogId ??
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

    // Re-check for a replay now that we hold the day lock. The fast path at the
    // top of createBooking runs BEFORE the lock, so two retries arriving
    // together can both miss it; only this check is serialised against a
    // concurrent first insert. Without it the second retry would book a
    // different table for the same caller.
    if (callLogId) {
      const alreadyBooked = await getReservationByCallLogId(callLogId, lockClient);
      if (alreadyBooked) {
        await lockClient.query("ROLLBACK");
        return replayResult(alreadyBooked, input.customerName);
      }
    }

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
    // tests / dev), and also when this venue holds no Cal.com event type,
    // which is the per-venue opt-in.
    await enqueueCreateForReservation(reservation.id, input.restaurantId, lockClient);

    // Guest confirmation SMS — voice bookings only. Web bookings already carry a
    // Cal.com confirmation email, and dashboard creates are staff acting for a
    // guest they're already talking to. Same transaction as the reservation, so
    // there is exactly one SMS row per committed reservation: a Retell tool
    // retry takes the replay paths above and never reaches this line, which is
    // why no dedupe column or migration is needed.
    if (input.source === "voice") {
      await enqueueBookingSms(
        {
          restaurantId: input.restaurantId,
          recipient: normalizedPhone,
          kind: "booking_confirmation",
          body: async () =>
            buildBookingConfirmationSms({
              venueName: await getRestaurantName(input.restaurantId),
              customerName: input.customerName,
              partySize: input.partySize,
              date: input.date,
              time: input.time
            }),
          reservationId: reservation.id
        },
        lockClient
      );
    }

    await lockClient.query("COMMIT");

    return {
      bookingId: reservation.id,
      status: reservation.status,
      confirmationMessage: `Confirmed. ${input.customerName} has a table for ${input.partySize} on ${input.date} at ${formatVoiceTime(input.time)}.`
    };
  } catch (error) {
    // ROLLBACK itself throws on a terminated connection (statement-timeout
    // kill, pool eviction). Unguarded, that rejection REPLACES the real error
    // and rethrowAsDoubleBookConflict never runs — turning a clean 409
    // TABLE_JUST_TAKEN into an opaque 500 mid-call. withTransaction and
    // cancelBooking already guard theirs; this one did not.
    // Guarded because lockClient is undefined when the failure WAS the connect.
    await lockClient?.query("ROLLBACK").catch(() => {});
    return rethrowAsDoubleBookConflict(error);
  } finally {
    lockClient?.release();
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
  // Who initiated the change. "voice" and "dashboard" notify the guest by SMS
  // (when the feature is on); unset or anything else stays silent. Cal.com
  // inbound never calls this function, so web-origin changes are excluded
  // structurally — the guest already gets Cal.com's own email there.
  source?: BookingSource;
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

      // Guest SMS on a real change from a caller- or staff-initiated action.
      // Notes-only edits are internal and stay silent. The updated ReservationRow
      // carries the final date/time/party, so the text always states the booking
      // as it now stands, not the delta.
      const partySizeChanged =
        input.partySize !== undefined && input.partySize !== current.party_size;
      const guestVisibleChange =
        becameCancelled || dateOrTimeChanged || partySizeChanged || nameChanged;
      if ((input.source === "voice" || input.source === "dashboard") && guestVisibleChange) {
        const customerResult = await db.query<{ name: string; phone: string }>(
          "SELECT name, phone FROM customers WHERE id = $1",
          [current.customer_id]
        );
        const customer = customerResult.rows[0];
        if (customer) {
          await enqueueBookingSms(
            {
              restaurantId: current.restaurant_id,
              recipient: customer.phone,
              kind: becameCancelled ? "booking_cancelled" : "booking_modified",
              body: async () => {
                const venueName = await getRestaurantName(current.restaurant_id);
                const date = reservation.reservation_date;
                const time = reservation.start_time.slice(0, 5);
                return becameCancelled
                  ? buildBookingCancelledSms({ venueName, date, time })
                  : buildBookingModifiedSms({
                      venueName,
                      customerName: nameChanged ? input.customerName!.trim() : customer.name,
                      partySize: reservation.party_size,
                      date,
                      time
                    });
              },
              reservationId: reservation.id
            },
            db
          );
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
  // Who initiated the cancel — see modifyBooking. Guest SMS fires only for
  // "voice" and "dashboard".
  source?: BookingSource;
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

      // Guest cancellation SMS — only when this call actually flipped the row
      // (the loser of a concurrent-cancel race gets reservation=null above and
      // must not text the guest a second time).
      if (input.source === "voice" || input.source === "dashboard") {
        const customerResult = await client.query<{ phone: string }>(
          "SELECT phone FROM customers WHERE id = $1",
          [reservation.customer_id]
        );
        const phone = customerResult.rows[0]?.phone;
        if (phone) {
          await enqueueBookingSms(
            {
              restaurantId: reservation.restaurant_id,
              recipient: phone,
              kind: "booking_cancelled",
              body: async () =>
                buildBookingCancelledSms({
                  venueName: await getRestaurantName(reservation.restaurant_id),
                  date: reservation.reservation_date,
                  time: reservation.start_time.slice(0, 5)
                }),
              reservationId: reservation.id
            },
            client
          );
        }
      }
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
