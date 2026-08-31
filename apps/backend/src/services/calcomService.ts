/**
 * Cal.com hybrid integration — high-level orchestration.
 *
 * Two halves:
 *   1. OUTBOUND (`executeOutboxRow`) — drains an outbox row into Cal.com.
 *      Called by `calcomOutboxWorker` inside its batch transaction. The
 *      executor runs the HTTP call and, on success, stamps the returned uid
 *      onto our reservation IN THE SAME TXN as the outbox markSucceeded —
 *      atomic so a crash never leaves us with an orphaned Cal.com booking.
 *
 *   2. INBOUND (`processInboxEvent`) — invoked by `routes/cal.ts` after the
 *      webhook is persisted to `inbox_calcom_events`. Handles loop detection
 *      (don't re-create a reservation for a booking we just pushed) and
 *      drives `bookingService.createBooking` for genuine web-channel bookings.
 *
 * Plus a couple of helpers (`buildCreatePayload`, `verifyCalcomSignature`,
 * `enqueueCreateForReservation`) that are exported for the booking service
 * and the webhook route.
 */

import crypto from "node:crypto";

import { env } from "../config/env";
import { AppError, PermanentInboxError } from "../domain/errors";
import { BookingSource } from "../domain/types";
import { DbClient, pool, readPool } from "../db/pool";
import {
  CalcomCircuitOpenError,
  CalcomPermanentError,
  CalcomTransientError,
  calcomRequest
} from "./calcomClient";
import {
  ReservationRow,
  cancelReservation,
  findReservationByCalcomUid,
  updateReservationCalcomUid
} from "../repositories/reservations";
import { enqueueOutbox } from "../repositories/outbox";
import {
  OutboxExecutionResult,
  OutboxExecutorRow,
  setOutboxExecutor
} from "../workers/calcomOutboxWorker";
import {
  getRestaurantCalcomEventTypeId,
  getRestaurantIdByCalcomEventTypeId,
  getRestaurantTimezone
} from "../repositories/restaurants";
import { utcIsoToZonedWallClock, zonedWallClockToUtcISO } from "../utils/time";
import { normalizePhone } from "../utils/phone";
import { logger } from "../utils/logger";
import { createBooking } from "./bookingService";
import {
  extractUidFromCreateResponse,
  parseCalcomWebhookPayload
} from "./calcomSchemas";

// --- helpers -----------------------------------------------------------------

const SYNTH_EMAIL_DOMAIN = "bookings.voxtable.biteperk.com.au";

/**
 * Domains we have ever minted synthetic attendee addresses under. Written: the
 * first. Recognised: all of them.
 *
 * The old domain carried another company's name, which is why it moved. It stays
 * readable because the addresses live in Cal.com's records, not ours — a booking
 * made under the old domain can be cancelled or rescheduled years later and will
 * arrive carrying it. Dropping this list would make those look like real customer
 * contact details.
 *
 * NAMES.md §4 called this identity immutable on the grounds that changing it
 * "orphans every existing Cal.com booking". It is four bookings, none of them in
 * our database — `customers` has no email column — and recognising both domains
 * orphans nothing.
 */
const SYNTH_EMAIL_DOMAINS = [
  SYNTH_EMAIL_DOMAIN,
  "bookings.vocotable.algorythmos.com.au"
] as const;

/** True when an address is one we minted for a caller who had no email. */
export function isSynthesizedEmail(value: string | null | undefined): boolean {
  if (!value) return false;
  return SYNTH_EMAIL_DOMAINS.some((domain) => value.includes(`@${domain}`));
}

/** Phone digits → `<digits>@bookings.voxtable.biteperk.com.au`. Cal.com requires
 *  an attendee email; voice callers rarely have one. The domain has no MX record
 *  so bounces stay quiet. */
export function synthesizedEmail(phone: string | null | undefined): string {
  if (!phone) return `unknown@${SYNTH_EMAIL_DOMAIN}`;
  const digits = phone.replace(/\D+/g, "") || "unknown";
  return `${digits}@${SYNTH_EMAIL_DOMAIN}`;
}

/** Mask middle digits of an E.164 number for log output. `+61450011140` →
 *  `+6145****140`. Used so logs aren't a PII liability. */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return "unknown";
  // Shape check + slicing instead of an ambiguous regex: the input arrives
  // from webhooks, so masking must stay linear-time.
  const digits = /^\+\d{8,15}$/.test(phone) ? phone.slice(1) : null;
  if (!digits) return phone.slice(0, 6) + "***";
  const prefix = digits.slice(0, digits.length === 8 ? 4 : 5);
  return `+${prefix}****${digits.slice(-3)}`;
}

// --- create payload builder --------------------------------------------------

export interface CreatePayloadInput {
  /** Reservation row (id, date, time, party_size, restaurant_id, source). */
  reservation: ReservationRow;
  /** Customer's display name. */
  customerName: string;
  /** E.164 phone or whatever the caller gave us; normalised before send. */
  customerPhone: string | null | undefined;
  /** Real email if the caller supplied one (web channel); otherwise synthesised. */
  customerEmail?: string | null;
  /** Restaurant tz, e.g. "Australia/Sydney". Resolved by caller. */
  restaurantTimezone: string;
  /**
   * The VENUE's Cal.com event type (restaurants.calcom_event_type_id), resolved
   * by the caller. Passed in rather than read from env here: a single global
   * event type meant every venue's bookings landed on one venue's public
   * calendar, which is correct with exactly one venue and a cross-tenant bug
   * with two.
   */
  eventTypeId: number;
}

/**
 * Shape the payload Cal.com's v2 `POST /bookings` expects. Conservative:
 * only fields Cal.com documents are included. `bookingFieldsResponses` is
 * keyed by the custom field slug we set on the event type (`party-size`).
 *
 * `metadata.noEmail = true` for voice/dashboard bookings — Bella/Staff
 * already confirmed verbally, no need for Cal.com to email a duplicate.
 * Web bookings keep email confirmations on (set caller-side, not here).
 */
export function buildCreatePayload(input: CreatePayloadInput): Record<string, unknown> {
  const startIso = zonedWallClockToUtcISO(
    input.reservation.reservation_date,
    input.reservation.start_time.slice(0, 5),
    input.restaurantTimezone
  );
  const normalisedPhone = normalizePhone(input.customerPhone ?? "") ?? null;
  const email = input.customerEmail || synthesizedEmail(normalisedPhone ?? input.customerPhone);

  const suppressEmail = input.reservation.source !== "web";

  return {
    eventTypeId: input.eventTypeId,
    start: startIso,
    attendee: {
      name: input.customerName,
      email,
      phoneNumber: normalisedPhone ?? undefined,
      timeZone: input.restaurantTimezone,
      language: "en"
    },
    bookingFieldsResponses: {
      // The Cal.com event type must have a number field with slug "party-size".
      "party-size": String(input.reservation.party_size)
    },
    // Cal.com v2 metadata validator requires ALL values to be strings — a
    // boolean (e.g. noEmail: true) returns 400 BAD_REQUEST. Real email
    // suppression for voice bookings should be configured on the Cal.com
    // event type itself (Notifications → "Don't send confirmation emails
    // to attendees"); metadata is purely an audit trail for our DB ↔ Cal.com
    // reconciliation.
    metadata: {
      voxtable_reservation_id: String(input.reservation.id),
      voxtable_source: String(input.reservation.source),
      voxtable_restaurant_id: String(input.reservation.restaurant_id),
      voxtable_suppress_email: suppressEmail ? "true" : "false"
    }
  };
}

// --- outbox executor (worker calls this) -------------------------------------

interface ReservationWithCustomer extends ReservationRow {
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
}

async function loadReservationForPush(
  reservationId: string,
  db: DbClient
): Promise<ReservationWithCustomer | null> {
  const result = await db.query<ReservationWithCustomer>(
    `
    SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, NULL::text AS customer_email
      FROM reservations r
      JOIN customers c ON c.id = r.customer_id
     WHERE r.id = $1
    `,
    [reservationId]
  );
  return result.rows[0] ?? null;
}

/**
 * Shared prologue of create and reschedule: load the reservation fresh, or
 * dead-letter the row if it no longer exists. Callers discriminate with
 * `"outcome" in result`.
 */
async function loadReservationOrDeadLetter(
  row: OutboxExecutorRow,
  op: "push" | "reschedule",
  db: DbClient
): Promise<ReservationWithCustomer | OutboxExecutionResult> {
  const reservation = await loadReservationForPush(row.reservation_id, db);
  if (!reservation) {
    return {
      outcome: "permanent",
      error: `Reservation ${row.reservation_id} no longer exists; skipping ${op}`
    };
  }
  return reservation;
}

// Cal.com response uid extraction goes through the validated schema in
// services/calcomSchemas.ts (imported at top) — replaces the prior untyped
// `as CalcomCreateResponse` cast that silently allowed schema drift.

/**
 * Shared tail of every push that yields a booking uid (create AND
 * reschedule — Cal.com's reschedule creates a NEW booking with a new uid).
 * Extract the uid, stamp it on the reservation inside the worker's txn, log,
 * and report the outcome. A response we can't extract a uid from is a loud
 * dead-letter, not a success: a lost uid is what makes later cancels
 * silently miss and leave a ghost booking.
 */
async function recordPushedUid(
  reservation: ReservationWithCustomer,
  response: { data: unknown; status: number; durationMs: number },
  op: "create" | "reschedule",
  db: DbClient,
  extraLog: Record<string, unknown> = {}
): Promise<OutboxExecutionResult> {
  const uid = extractUidFromCreateResponse(response.data);
  if (!uid) {
    return {
      outcome: "permanent",
      error: `Cal.com ${op} returned no uid (status=${response.status}); refusing to retry`
    };
  }
  if (uid !== reservation.calcom_booking_uid) {
    await updateReservationCalcomUid(reservation.id, uid, db);
  }
  logger.info({
    evt: "calcom_push_success",
    op,
    reservation_id: reservation.id,
    calcom_uid: uid,
    latency_ms: response.durationMs,
    ...extraLog
  });
  return { outcome: "succeeded" };
}

async function executeCreate(row: OutboxExecutorRow, db: DbClient): Promise<OutboxExecutionResult> {
  const loaded = await loadReservationOrDeadLetter(row, "push", db);
  if ("outcome" in loaded) return loaded;
  const reservation = loaded;
  // Loop guard: if the reservation already has a uid (an earlier attempt
  // succeeded on Cal.com but we crashed before COMMIT), treat as success
  // without re-pushing. The unique index on calcom_booking_uid means we
  // can't accidentally double-attach.
  if (reservation.calcom_booking_uid) {
    return { outcome: "succeeded" };
  }
  // Cancelled before this create ever pushed (a cancel within one worker tick
  // of the create). Pushing anyway would put a booking on Cal.com that
  // nothing will ever cancel — the cancel op sees no uid and, once this row
  // is terminal, correctly concludes nothing reached Cal.com.
  if (reservation.status === "cancelled") {
    logger.info({
      evt: "calcom_push_skipped_cancelled",
      op: "create",
      reservation_id: reservation.id
    });
    return { outcome: "succeeded" };
  }

  // Belt and braces. The enqueue gate should already have prevented a row
  // existing for a venue with no Cal.com event type, but a venue can also be
  // UNBOUND between enqueue and push. Pushing regardless would send
  // `eventTypeId: undefined`, which JSON.stringify drops, which Cal.com 400s,
  // which classifies as permanent — so every booking at an unbound venue would
  // dead-letter, and healthAlerter pages Slack at a dead-letter threshold of
  // zero. "This venue does not use Cal.com" must not read as an incident.
  const eventTypeId = await getRestaurantCalcomEventTypeId(reservation.restaurant_id, db);
  if (!eventTypeId) {
    logger.info({
      evt: "calcom_push_skipped_unbound_venue",
      op: "create",
      reservation_id: reservation.id,
      restaurant_id: reservation.restaurant_id
    });
    return { outcome: "succeeded" };
  }

  const restaurantTimezone = await getRestaurantTimezone(reservation.restaurant_id);
  const payload = buildCreatePayload({
    reservation,
    customerName: reservation.customer_name,
    customerPhone: reservation.customer_phone,
    customerEmail: reservation.customer_email,
    restaurantTimezone,
    eventTypeId
  });

  try {
    const response = await pushWithRowIdempotency("/bookings", payload, row);
    return await recordPushedUid(reservation, response, "create", db, {
      phone_redacted: redactPhone(reservation.customer_phone)
    });
  } catch (error) {
    return classifyCalcomError(error, "create");
  }
}

/**
 * POST to Cal.com under this outbox row's idempotency key (Audit Sweep F):
 * if the worker crashes mid-POST and another tick retries, Cal.com returns
 * the SAME booking (matched by the key) instead of creating a duplicate
 * calendar event. Shared by create and reschedule — both are booking-minting
 * calls with the same crash-retry hazard.
 */
function pushWithRowIdempotency(
  path: string,
  body: Record<string, unknown>,
  row: OutboxExecutorRow
): Promise<{ data: unknown; status: number; durationMs: number }> {
  return calcomRequest<unknown>({
    method: "POST",
    path,
    body,
    idempotencyKey: `vocotable-outbox-${row.id}`
  });
}

async function executeCancel(row: OutboxExecutorRow, db: DbClient): Promise<OutboxExecutionResult> {
  // Re-read the uid at push time. The enqueue-time snapshot in the payload is
  // NULL whenever the cancel landed within one worker tick of the create (the
  // create hadn't pushed yet) — and treating that as "nothing to cancel"
  // marked the intent succeeded while the create went on to push anyway: a
  // permanent ghost booking on Cal.com. The payload uid is kept only as a
  // fallback for a reservation row that has since been deleted.
  const fresh = await db.query<{ calcom_booking_uid: string | null }>(
    "SELECT calcom_booking_uid FROM reservations WHERE id = $1",
    [row.reservation_id]
  );
  const uid =
    fresh.rows[0]?.calcom_booking_uid ??
    (row.payload as { calcom_booking_uid?: string }).calcom_booking_uid;
  if (!uid) {
    const pendingCreate = await db.query(
      `
      SELECT 1 FROM outbox_calcom
       WHERE reservation_id = $1 AND op = 'create'
         AND succeeded_at IS NULL AND failed_at IS NULL
       LIMIT 1
      `,
      [row.reservation_id]
    );
    if (pendingCreate.rowCount) {
      // The create hasn't resolved yet. It will see status='cancelled' and
      // no-op (or, if it already pushed, stamp the uid) — either way the next
      // attempt of this row sees the truth. "Hasn't reached Cal.com YET" must
      // not be conflated with "never will".
      return {
        outcome: "transient",
        error: "create op for this reservation still pending; retrying cancel until it resolves"
      };
    }
    // No uid and no pending create — the reservation never reached Cal.com.
    return { outcome: "succeeded" };
  }
  try {
    await calcomRequest({
      method: "POST",
      path: `/bookings/${encodeURIComponent(uid)}/cancel`,
      body: {
        cancellationReason: (row.payload as { reason?: string }).reason ?? "Cancelled via VoxTable"
      }
    });
    logger.info({ evt: "calcom_push_success", op: "cancel", reservation_id: row.reservation_id, calcom_uid: uid });
    return { outcome: "succeeded" };
  } catch (error) {
    if (error instanceof CalcomPermanentError && error.status === 404) {
      // Already gone — fine.
      return { outcome: "succeeded" };
    }
    return classifyCalcomError(error, "cancel");
  }
}

async function executeReschedule(row: OutboxExecutorRow, db: DbClient): Promise<OutboxExecutionResult> {
  // Loads the reservation FRESH, like executeCreate — the row carries intent
  // ("this reservation moved"), not a time snapshot. If the booking moved
  // twice before this row was processed, one push lands the latest truth and
  // the enqueue-time de-dup means there was only ever one pending row.
  const loaded = await loadReservationOrDeadLetter(row, "reschedule", db);
  if ("outcome" in loaded) return loaded;
  const reservation = loaded;
  if (reservation.status === "cancelled") {
    // The cancel op owns the mirror from here.
    return { outcome: "succeeded" };
  }
  if (!reservation.calcom_booking_uid) {
    // The create hasn't pushed yet. When it does, executeCreate reads the
    // CURRENT row — which already holds the new time — so there is nothing
    // separate to reschedule. And if no create row exists at all, this
    // reservation was never mirrored.
    return { outcome: "succeeded" };
  }

  const restaurantTimezone = await getRestaurantTimezone(reservation.restaurant_id);
  const startIso = zonedWallClockToUtcISO(
    reservation.reservation_date,
    reservation.start_time.slice(0, 5),
    restaurantTimezone
  );

  try {
    const response = await pushWithRowIdempotency(
      `/bookings/${encodeURIComponent(reservation.calcom_booking_uid)}/reschedule`,
      { start: startIso, reschedulingReason: "Rescheduled via VoxTable" },
      row
    );
    // Cal.com's reschedule creates a NEW booking (new uid) and retires the
    // old one. recordPushedUid stamps the new uid — without that, every later
    // cancel re-reads a stale uid, Cal.com 404s it, we shrug "already gone",
    // and the ghost is back.
    return await recordPushedUid(reservation, response, "reschedule", db);
  } catch (error) {
    if (error instanceof CalcomPermanentError && error.status === 404) {
      // The uid no longer exists on Cal.com (cancelled there out-of-band).
      // The inbox cancel handler owns that state change; nothing to move.
      return { outcome: "succeeded" };
    }
    return classifyCalcomError(error, "reschedule");
  }
}

function classifyCalcomError(error: unknown, op: string): OutboxExecutionResult {
  if (error instanceof CalcomCircuitOpenError) {
    // Never reached the network — don't count it against the retry budget.
    logger.warn({ evt: "calcom_push_skipped_breaker_open", op });
    return { outcome: "skipped", error: error.message };
  }
  if (error instanceof CalcomTransientError) {
    logger.warn({ evt: "calcom_push_transient", op, error: error.message, status: error.status });
    return { outcome: "transient", error: error.message };
  }
  if (error instanceof CalcomPermanentError) {
    logger.error({ evt: "calcom_push_permanent", op, error });
    return { outcome: "permanent", error: error.message };
  }
  const message = (error as Error).message ?? String(error);
  logger.error({ evt: "calcom_push_unknown", op, error });
  return { outcome: "transient", error: message };
}

// Exported so the calcom-mirror smoke test can drive the REAL op handlers
// against a live Postgres — the B5 short-circuit paths (cancel-before-create,
// create-after-cancel) resolve before any network call, so they are testable
// without a Cal.com stub.
export const calcomOutboxExecutor = {
  async execute(row: OutboxExecutorRow, db: DbClient): Promise<OutboxExecutionResult> {
    switch (row.op) {
      case "create":
        return executeCreate(row, db);
      case "cancel":
        return executeCancel(row, db);
      case "reschedule":
        return executeReschedule(row, db);
      default:
        return { outcome: "permanent", error: `Unknown op: ${row.op as string}` };
    }
  }
};

/**
 * Register the real executor with the outbox worker. Called once at boot
 * (after env is parsed) — only when `CALCOM_SYNC_ENABLED=true`, otherwise the
 * worker isn't running and there's no point.
 */
export function installCalcomExecutor(): void {
  if (!env.CALCOM_SYNC_ENABLED) return;
  setOutboxExecutor(calcomOutboxExecutor);
  logger.info({ evt: "calcom_executor_installed" });
}

// --- bookingService convenience ---------------------------------------------

/**
 * Called by `bookingService.createBooking` after the reservation INSERT.
 * Enqueues an outbox row INSIDE the booking's transaction so atomicity is
 * preserved — if the booking commits, the push will eventually happen; if
 * it rolls back, no orphan push.
 *
 * No-op when `CALCOM_SYNC_ENABLED=false` so PR 1 keeps deploying cleanly.
 *
 * Also a no-op when the venue holds no Cal.com event type. That is the
 * per-venue opt-in, and it has to be checked HERE rather than at push time: an
 * outbox row for an unbound venue can only ever dead-letter, healthAlerter
 * pages Slack at a dead-letter threshold of zero, and those `failed_at` rows
 * are never swept by the cleanup worker — so a venue that simply doesn't use
 * Cal.com would look like a permanent, growing incident.
 *
 * ⚠️ Deliberately asymmetric with cancel/reschedule below, which are NOT gated
 * this way. They gate on the reservation already holding a Cal.com uid. If
 * they gated on the venue's binding instead, unbinding a venue — the per-venue
 * kill switch — would strand every booking already live on Cal.com as an
 * uncancellable ghost, still holding public availability nobody can release.
 * Stopping new mirroring and abandoning existing bookings are different things.
 */
export async function enqueueCreateForReservation(
  reservationId: string,
  restaurantId: string,
  db: DbClient
): Promise<void> {
  if (!env.CALCOM_SYNC_ENABLED) return;
  // On the caller's client, not the pool. This runs inside createBooking's
  // advisory-lock transaction, so a second connection here would be held
  // simultaneously with the first for every booking.
  const eventTypeId = await getRestaurantCalcomEventTypeId(restaurantId, db);
  if (!eventTypeId) return;
  await enqueueOutbox(
    {
      reservationId,
      op: "create",
      payload: {} // executor loads fresh reservation row at push time
    },
    db
  );
}

/**
 * Enqueue a cancel — used by `bookingService.cancelBooking` AFTER the
 * reservation is marked cancelled. Caller passes the reservation's existing
 * calcom_booking_uid; if null, the outbox row is still inserted but the
 * executor short-circuits to success.
 */
export async function enqueueCancelForReservation(
  reservationId: string,
  calcomUid: string | null,
  reason: string | undefined,
  db: DbClient
): Promise<void> {
  if (!env.CALCOM_SYNC_ENABLED) return;
  await enqueueOutbox(
    {
      reservationId,
      op: "cancel",
      // The uid here is only a fallback for a reservation row deleted before
      // the push — the executor re-reads the live uid at push time, because
      // this snapshot is NULL whenever the cancel lands before the create op
      // has pushed (see executeCancel).
      payload: { calcom_booking_uid: calcomUid ?? undefined, reason }
    },
    db
  );
}

/**
 * Enqueue a reschedule — used by `bookingService.modifyBooking` INSIDE its
 * transaction whenever the reservation's date or time changed. Payload is
 * empty by design: the executor loads the reservation fresh at push time, so
 * the row is pure intent and self-heals across multiple moves.
 */
export async function enqueueRescheduleForReservation(
  reservationId: string,
  db: DbClient
): Promise<void> {
  if (!env.CALCOM_SYNC_ENABLED) return;
  await enqueueOutbox(
    {
      reservationId,
      op: "reschedule",
      payload: {}
    },
    db
  );
}

// --- admin bind verification --------------------------------------------------

export interface CalcomEventTypeVerdict {
  title: string | null;
  /** Non-null and > 0 means the event type is configured for seats. */
  seatsPerTimeSlot: number | null;
  /** The event type asks the booker how many people — see buildCreatePayload. */
  hasPartySizeField: boolean;
  /** Loose name match against the venue, same spirit as verifyAgentForVenue. */
  matchesVenue: boolean;
}

/**
 * Prove a Cal.com event type before storing it on a venue.
 *
 * `restaurants.calcom_event_type_id` is a bare integer that decides which venue
 * an inbound web booking belongs to, so a typo here silently seats one
 * restaurant's diners at another's tables — the Cal.com-shaped version of the
 * incident migration 034 was written for.
 *
 * Throws CalcomTransientError / CalcomPermanentError; the caller decides how a
 * 404 versus an outage should be reported.
 */
export async function verifyCalcomEventTypeForVenue(
  eventTypeId: number,
  venueName: string
): Promise<CalcomEventTypeVerdict> {
  let data: unknown;
  try {
    const response = await calcomRequest<unknown>({
      method: "GET",
      // /event-types is documented at its own API version — the bookings
      // default would not necessarily resolve here.
      apiVersion: "2024-06-14",
      path: `/event-types/${eventTypeId}`
    });
    data = response.data;
  } catch (error) {
    // A 404 and an outage are both "we could not prove this event type exists",
    // and neither may be stored — an unverifiable binding is the exact state
    // this function exists to prevent. Same treatment as verifyAgentForVenue:
    // one 409, the underlying error to the log (redacted there) and never into
    // the HTTP response. Without this a Cal.com blip would surface as a 500 and
    // read as our bug rather than as a binding that was correctly refused.
    logger.error({
      evt: "calcom_event_type_verify_failed",
      event_type_id: eventTypeId,
      error
    });
    throw new AppError(
      409,
      "CALCOM_EVENT_TYPE_NOT_FOUND",
      `Cal.com has no event type ${eventTypeId}, or it could not be reached. ` +
        `The binding was not saved.`
    );
  }

  const record = (data as { data?: Record<string, unknown> })?.data ?? (data as Record<string, unknown>);
  const title = typeof record?.["title"] === "string" ? (record["title"] as string) : null;

  // Seats has lived at two shapes across versions: a `seats` object and a flat
  // `seatsPerTimeSlot`. Read both — guessing one would let a seated event type
  // through the refusal below, which is the whole point of the check.
  const seatsObject = record?.["seats"] as { seatsPerTimeSlot?: unknown } | undefined;
  const rawSeats = seatsObject?.seatsPerTimeSlot ?? record?.["seatsPerTimeSlot"];
  const seatsPerTimeSlot = typeof rawSeats === "number" && rawSeats > 0 ? rawSeats : null;

  const bookingFields = Array.isArray(record?.["bookingFields"])
    ? (record["bookingFields"] as Array<Record<string, unknown>>)
    : [];
  const hasPartySizeField = bookingFields.some((field) => field?.["slug"] === "party-size");

  return {
    title,
    seatsPerTimeSlot,
    hasPartySizeField,
    matchesVenue: looksLikeSameVenue(title, venueName)
  };
}

/**
 * Loose containment either way, lowercased and stripped of punctuation, so
 * "Mazcina" matches "Mazcina — Online Bookings" without matching an unrelated
 * venue. Deliberately permissive: the name check is the overridable one, while
 * the uniqueness and existence checks are not.
 */
function looksLikeSameVenue(title: string | null, venueName: string): boolean {
  if (!title) return false;
  const normalise = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = normalise(title);
  const b = normalise(venueName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// --- inbox: HMAC verify + event processing -----------------------------------

/**
 * Cal.com signs every webhook with HMAC-SHA256 over the raw body. Header
 * name is `X-Cal-Signature-256`. Constant-time compare to prevent timing
 * attacks. Returns true only if the secret is configured AND the signature
 * matches.
 */
export function verifyCalcomSignature(rawBody: string, header: string | undefined): boolean {
  if (!env.CALCOM_WEBHOOK_SECRET) return false;
  if (!header) return false;
  const expected = crypto
    .createHmac("sha256", env.CALCOM_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const provided = header.replace(/^sha256=/, "").trim();

  // Reject anything that isn't hex before decoding. This used to length-check
  // the STRINGS and then timingSafeEqual the BUFFERS, and Buffer.from(s, "hex")
  // stops at the first character that isn't a hex digit — so a 64-character
  // signature of garbage decoded to 0 bytes, timingSafeEqual threw RangeError
  // on the length mismatch, and an unauthenticated caller got a 500 out of the
  // webhook endpoint for the price of one request.
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;
  if (expected.length !== provided.length) return false;

  const expectedBytes = Buffer.from(expected, "hex");
  const providedBytes = Buffer.from(provided, "hex");
  // Belt and braces: equal hex length already implies equal byte length, but
  // timingSafeEqual throws rather than returning false if that ever stops
  // holding, and this function must never be the thing that raises.
  if (expectedBytes.length !== providedBytes.length) return false;
  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * Deterministic id for a Cal.com webhook payload — the inbox PK that gives us
 * idempotency on retries. The hash includes `createdAt` (Audit Sweep F fix):
 * without it, two LEGITIMATE webhook deliveries for the same booking-uid
 * (e.g. admin clicks "resend" in Cal.com UI, or a reschedule re-emits) hash
 * the same and the second is silently dropped as a "replay".
 *
 * Retries within Cal.com's automatic 5xx-retry loop ship the SAME createdAt
 * → still hash the same → still dedup correctly. Re-sends from admin UI
 * ship a NEW createdAt → unique hash → processed. Both cases handled.
 */
export function computeInboxEventId(payload: Record<string, unknown>): string {
  const uid = (payload.payload as Record<string, unknown> | undefined)?.uid ?? payload.uid ?? "";
  const startTime = (payload.payload as Record<string, unknown> | undefined)?.startTime ?? "";
  const trigger = payload.triggerEvent ?? "";
  const createdAt = payload.createdAt ?? "";
  const raw = `${String(trigger)}|${String(uid)}|${String(startTime)}|${String(createdAt)}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export interface CalcomWebhookPayload {
  triggerEvent: string;
  createdAt: string;
  payload: Record<string, any>;
}

/**
 * Process a verified, deduplicated Cal.com webhook event. Called from the
 * inbox handler after `recordInboxEvent` confirms this is a NEW event.
 *
 * Returns void on success; throws on unrecoverable errors so the caller can
 * mark the inbox row failed.
 */
export async function processInboxEvent(event: CalcomWebhookPayload): Promise<void> {
  // Schema-validate the inner payload by trigger type. Replaces the previous
  // untyped `event.payload?.attendees?.[0]?.name` chains that silently fell
  // through to defaults when Cal.com shape drifted (next-class-of-bug risk).
  const parsed = parseCalcomWebhookPayload(event.triggerEvent, event.payload);

  if (parsed.kind === "invalid") {
    // Shape regression — log loud and throw so the inbox row is marked failed
    // and ops can investigate. Don't silently swallow.
    logger.error({
      evt: "calcom_inbox_payload_invalid",
      trigger: event.triggerEvent,
      error: parsed.error
    });
    // Permanent: the stored payload is immutable, so it will fail the same
    // schema on every attempt. Retrying it would burn the ceiling and delay the
    // dead-letter alert that tells someone Cal.com changed shape on us.
    throw new PermanentInboxError(
      `Cal.com ${event.triggerEvent} payload failed schema: ${parsed.error}`
    );
  }

  if (parsed.kind === "ignored") {
    logger.info({ evt: "calcom_inbox_event_ignored", trigger: event.triggerEvent });
    return;
  }

  if (parsed.kind === "created") {
    await handleBookingCreated(parsed.data);
    return;
  }
  if (parsed.kind === "cancelled") {
    await handleBookingCancelled(parsed.data);
    return;
  }
  if (parsed.kind === "rescheduled") {
    // Conservative for v1: treat as cancel + ignore. Staff can manually
    // re-book if Cal.com reschedules. Documented limitation.
    logger.info({
      evt: "calcom_inbox_reschedule_ignored",
      uid: parsed.data.uid,
      message: "Reschedule not yet handled"
    });
    return;
  }
}

/**
 * `data` is the schema-validated BOOKING_CREATED payload — `uid` and
 * `startTime` are guaranteed non-empty strings by the schema's `.min(1)`
 * constraints. Everything else is still defensively narrowed because
 * Cal.com's attendees array may legitimately be empty (server-side bookings)
 * and responses are keyed by event-type custom fields.
 */
/**
 * The venue key off an inbound payload.
 *
 * Cal.com ships this top-level as `eventTypeId` — confirmed against a real
 * payload — but the same schema also carries a nested `eventType` object, and
 * Cal.com has already changed this payload's shape once without a version bump
 * (calcom/cal.diy#28508). Reading both costs nothing and is the difference
 * between "one field moved" and "every online booking is refused".
 */
function readEventTypeId(data: { eventTypeId?: number; eventType?: unknown }): number | null {
  if (typeof data.eventTypeId === "number" && data.eventTypeId > 0) return data.eventTypeId;
  const nested = (data.eventType as { id?: unknown } | undefined)?.id;
  if (typeof nested === "number" && nested > 0) return nested;
  return null;
}

async function handleBookingCreated(
  data: ReturnType<typeof parseCalcomWebhookPayload> extends infer R
    ? R extends { kind: "created"; data: infer D }
      ? D
      : never
    : never
): Promise<void> {
  const uid = data.uid;
  const startTime = data.startTime;

  // Loop check — did WE create this booking via the outbox?
  const existing = await findReservationByCalcomUid(uid, readPool);
  if (existing) {
    logger.info({ evt: "calcom_inbox_loop_skipped", uid, reservation_id: existing.id });
    return;
  }

  // Reconcile by the metadata WE stamped on every outbound push
  // (buildCreatePayload stamps our reservation id). If the key is
  // present, this webhook is the echo of our own push — the outbox worker's
  // commit may simply not have landed yet — so attach the uid and stop.
  // Absence of the key positively identifies a genuine web booking. The old
  // reconciler matched on nothing but "exactly one pending create row", so a
  // stranger's web booking arriving while a voice push was in flight got its
  // uid stamped onto the voice reservation — and the stranger's later
  // cancellation cancelled the voice caller's table.
  //
  // Resolved here rather than at the web-booking path below so the reconciler
  // can cross-check it. Note it is NOT fail-closed at this point: our own echo
  // must still reconcile even if the venue has since been unbound from Cal.com,
  // otherwise unbinding a venue would make us cancel our own voice bookings.
  // Fail-closed applies only to the genuine web-booking path further down.
  const resolvedRestaurantId =
    (await getRestaurantIdByCalcomEventTypeId(readEventTypeId(data))) ??
    (env.APP_ENV !== "production" ? env.DEFAULT_RESTAURANT_ID : null);

  const reconciled = await reconcileMirroredBooking(data.metadata, uid, resolvedRestaurantId);
  if (reconciled) return;

  // Resolve the venue from the event type the webhook carries, the way
  // twilioService resolves one from the dialed number. This block used to
  // hardcode env.DEFAULT_RESTAURANT_ID with a comment admitting it would become
  // a cross-tenant bug the moment Cal.com config went per-restaurant. Migration
  // 035 is that moment.
  //
  // Fails closed in production, matching resolveAgentId in retellService: an
  // unresolved venue must never fall back to a default. "Fail closed" means
  // something different here than on a phone call, though — a caller who
  // reaches silence simply rings back, whereas this guest is already holding a
  // Cal.com confirmation email. Dropping the booking quietly sends them to a
  // restaurant that has never heard of them, so we cancel it back on Cal.com
  // and let them find out now rather than at the door.
  if (!resolvedRestaurantId) {
    const eventTypeId = readEventTypeId(data);

    // These two look alike and must not be treated alike.
    //
    // An event type that IS present but matches no venue is OUR misconfiguration.
    // Nobody is going to seat this guest, so telling them now — by cancelling on
    // Cal.com — beats letting them arrive to blank faces.
    //
    // An event type that is ABSENT is a shape change on Cal.com's side. We
    // cannot tell a real booking from anything else, and cancelling on a field
    // we failed to read would mean that the first hour after they rename a field
    // we silently cancel every online booking, irreversibly, because the booking
    // no longer exists to replay. So: refuse, shout, and leave the guest's
    // booking standing for a human.
    logger.error({
      evt: "calcom_inbox_unmapped_event_type",
      uid,
      event_type_id: eventTypeId,
      cancelled_on_calcom: eventTypeId !== null,
      reason: eventTypeId
        ? "no restaurant holds this Cal.com event type"
        : "webhook payload carried no eventTypeId — possible Cal.com payload change"
    });

    if (eventTypeId !== null) {
      await cancelOnCalcomBestEffort(
        uid,
        "VoxTable could not match this booking to a venue. Please call the restaurant directly."
      );
    }

    // Permanent either way. A misconfiguration is not a blip, and where the
    // cancel-back did fire it has already told the guest their booking is off —
    // so a retry that later succeeded would create a reservation for a booking
    // the guest believes is cancelled. The row stays as durable evidence.
    throw new PermanentInboxError(
      `Cal.com event type ${eventTypeId ?? "(absent from payload)"} is not bound to any restaurant`
    );
  }

  // Genuine web-channel booking. Funnel through bookingService so capacity
  // rules and double-booking guards still run. Defensive narrowing on the
  // attendee/responses since both may be empty / shape-variant.
  const firstAttendee = data.attendees?.[0];
  const responses = (data.responses ?? {}) as Record<string, unknown>;
  const customerName =
    (typeof firstAttendee?.name === "string" && firstAttendee.name) ||
    (typeof responses.name === "string" && responses.name) ||
    "Guest";
  const customerEmail =
    (typeof firstAttendee?.email === "string" && firstAttendee.email) || "";
  const phone =
    (typeof firstAttendee?.phoneNumber === "string" && firstAttendee.phoneNumber) ||
    (typeof responses["attendeePhoneNumber"] === "string"
      ? (responses["attendeePhoneNumber"] as string)
      : "");

  // -- Data-quality review flags ------------------------------------------
  // The Cal.com event type SHOULD ask "How many people?" + collect a real
  // phone number. When the dashboard config is missing those questions, the
  // webhook still arrives — silent defaults (partySize=2, synthetic email
  // as phone) used to mask the problem. Now we flag for review so staff
  // call the customer back before they show up to the wrong-size table.
  const reviewFlags: string[] = [];

  const partySizeRaw = responses["party-size"] ?? responses["partySize"];
  const partySizeNum = Number(partySizeRaw);
  const partySizeValid =
    partySizeRaw !== undefined &&
    partySizeRaw !== null &&
    partySizeRaw !== "" &&
    Number.isFinite(partySizeNum) &&
    partySizeNum >= 1 &&
    partySizeNum <= 20;
  const partySize = partySizeValid ? Math.floor(partySizeNum) : 2;
  if (!partySizeValid) reviewFlags.push("party_size_missing");

  // A "real" phone is anything non-empty that isn't one of the synthetic
  // addresses we mint when the caller has no email — either domain, see
  // SYNTH_EMAIL_DOMAINS.
  const normalizedPhone = normalizePhone(phone);
  const phoneIsSynthetic =
    !phone ||
    isSynthesizedEmail(phone) ||
    (isSynthesizedEmail(customerEmail) && !normalizedPhone);
  if (!normalizedPhone) reviewFlags.push(phoneIsSynthetic ? "phone_synthetic" : "phone_invalid");

  if (reviewFlags.length > 0) {
    // Loud, structured, grep-able. Keep this evt name stable — healthAlerter
    // / future Slack alert can subscribe on the literal string.
    logger.warn({
      evt: "calcom_inbox_web_booking_needs_review",
      uid,
      flags: reviewFlags,
      party_size_raw: typeof partySizeRaw === "string" || typeof partySizeRaw === "number"
        ? partySizeRaw
        : null,
      phone_present: Boolean(normalizedPhone),
      customer_email_present: Boolean(customerEmail)
    });
  }

  const restaurantTimezone = await getRestaurantTimezone(resolvedRestaurantId);
  const { date, time } = utcIsoToZonedWallClock(startTime, restaurantTimezone);

  // Booking goes through. We don't refuse it — the customer already has a
  // Cal.com confirmation email and refusing would leave them stranded. The
  // reviewFlags get prepended to `notes` so staff see them at a glance on
  // the dashboard's booking-log row.
  const notesPrefix = reviewFlags.length > 0
    ? `[NEEDS REVIEW: ${reviewFlags.join(", ")}] `
    : "";
  const notes = `${notesPrefix}Web booking via Cal.com (uid ${uid}); email ${customerEmail}`;

  try {
    // No parseable phone → per-booking sentinel, never the email (a shared
    // email-as-phone both violates the review-flag design and can collide on
    // the customers (restaurant_id, phone) unique key across guests).
    const booking = await createBooking({
      restaurantId: resolvedRestaurantId,
      customerName,
      customerPhone: normalizedPhone ?? `web:${uid}`,
      allowUnparseablePhone: !normalizedPhone,
      date,
      time,
      partySize,
      source: "web" as BookingSource,
      notes
    });
    // Stamp the uid onto the just-created reservation so future webhooks
    // (e.g. BOOKING_CANCELLED for this uid) can find it.
    await updateReservationCalcomUid(booking.bookingId, uid);
    logger.info({
      evt: "calcom_inbox_web_booking_accepted",
      uid,
      reservation_id: booking.bookingId,
      phone_redacted: redactPhone(normalizedPhone || phone),
      review_flags: reviewFlags.length > 0 ? reviewFlags : undefined
    });
  } catch (error) {
    // Conflict or other failure — cancel on Cal.com side so the guest gets
    // told. Best-effort; if Cal.com is unreachable we log and continue (the
    // outbox/inbox audit gives ops the info to handle manually).
    const message = (error as Error).message ?? String(error);

    // Two very different failures arrive here and they must not be treated
    // alike. A 4xx from bookingService is a decision — no table, a date in the
    // past, a party we cannot seat — and it will be the same decision on every
    // retry, so the guest is told now and the row is terminal. Anything else
    // (a day-lock wait outliving statement_timeout, an exhausted pool, a
    // Postgres blip) is infrastructure: it says nothing about the booking, it
    // will very likely succeed on the next attempt, and cancelling the guest's
    // booking over it would be plainly wrong.
    //
    // The old code cancelled back on every failure, which turned a five-second
    // lock wait into a cancelled reservation.
    const isRefusal = isTerminalBookingRefusal(error);

    if (!isRefusal) {
      logger.error({ evt: "calcom_inbox_web_booking_deferred", uid, error });
      throw error;
    }

    logger.error({ evt: "calcom_inbox_web_booking_rejected", uid, error });
    await cancelOnCalcomBestEffort(uid, `VoxTable rejected: ${message}`);
    throw new PermanentInboxError(message);
  }
}

/**
 * Codes that mean "we have decided we cannot seat this booking, and we will
 * decide the same on every retry".
 *
 * Keyed on `code`, not on `statusCode`, because 4xx is an HTTP shape and not a
 * semantic one. The case that forced this: `TABLE_JUST_TAKEN` is a 409, but it
 * is raised ONLY by the overlap constraint firing — i.e. it means a concurrent
 * writer beat us, which is contention, not a decision. Its own message says
 * "just got booked by another caller". Treating it as a refusal cancelled the
 * guest's Cal.com booking over a lost race, and the concurrent writer could even
 * be us processing the same webhook twice.
 *
 * Anything not listed here is treated as transient and retried. That is the safe
 * default: a retry costs a little work, whereas a wrong refusal cancels a real
 * guest's table.
 */
const TERMINAL_BOOKING_REFUSAL_CODES = new Set([
  "BOOKING_NOT_AVAILABLE",
  "TABLE_NOT_AVAILABLE",
  "BOOKING_DATE_IN_PAST",
  "BOOKING_DATE_TOO_FAR",
  "PARTY_SIZE_UNSUPPORTED",
  "CUSTOMER_PHONE_INVALID"
]);

export function isTerminalBookingRefusal(error: unknown): boolean {
  return error instanceof AppError && TERMINAL_BOOKING_REFUSAL_CODES.has(error.code);
}

/**
 * Cancel a booking back on Cal.com, best effort.
 *
 * Used on the two paths where we have accepted a webhook but cannot honour the
 * booking: the venue could not be resolved, and our own capacity check refused
 * it. In both cases the guest already holds a Cal.com confirmation email, so
 * leaving the booking standing is worse than failing — they would arrive at a
 * restaurant with no record of them.
 *
 * Never throws. A Cal.com outage here must not mask the original failure, and
 * the inbox row plus these logs are what an operator works from.
 */
async function cancelOnCalcomBestEffort(uid: string, reason: string): Promise<void> {
  try {
    await calcomRequest({
      method: "POST",
      path: `/bookings/${encodeURIComponent(uid)}/cancel`,
      body: { cancellationReason: reason }
    });
  } catch (cancelError) {
    logger.error({ evt: "calcom_inbox_undo_cancel_failed", uid, error: cancelError });
  }
}

async function handleBookingCancelled(
  data: ReturnType<typeof parseCalcomWebhookPayload> extends infer R
    ? R extends { kind: "cancelled"; data: infer D }
      ? D
      : never
    : never
): Promise<void> {
  const uid = data.uid;
  const existing = await findReservationByCalcomUid(uid, readPool);
  if (!existing) {
    logger.info({ evt: "calcom_inbox_cancel_no_match", uid });
    return;
  }
  // Cancel in our DB. Don't push back to Cal.com — it already happened there.
  //
  // Via cancelReservation rather than a raw UPDATE: the guard belongs in the
  // WHERE clause. The previous shape read the status, decided, then wrote, and
  // two deliveries of the same cancellation could interleave between the two —
  // the audit-M3 race that function was written to close. Returning null means
  // somebody else got there first, which for a webhook is the common case (our
  // own echo), not an error.
  const cancelled = await cancelReservation(
    { id: existing.id, reason: "Cancelled via Cal.com" },
    pool
  );
  if (!cancelled) {
    logger.info({ evt: "calcom_inbox_cancel_already_applied", uid, reservation_id: existing.id });
    return;
  }
  logger.info({ evt: "calcom_inbox_cancel_applied", uid, reservation_id: existing.id });
}

/**
 * The reservation id we stamped on an outbound push, under either key.
 *
 * The keys moved from `vocotable_*` to `voxtable_*` when BitePerk separated from
 * Algorythmos. Reading BOTH is not tidiness, it is the difference between a
 * correct no-op and a phantom booking: `reconcileMirroredBooking` treats this id
 * as positive proof that a webhook is our own push echoing back, and a booking
 * created before the rename can be cancelled or rescheduled at any point in the
 * future. Miss it and the event falls through to the genuine-web-booking path,
 * which creates a duplicate reservation occupying a real table.
 *
 * So the legacy key is read FOREVER. There is no date after which it is safe to
 * drop — only a date after which no such booking exists, which nothing tracks.
 */
export function ourReservationId(metadata: Record<string, unknown> | undefined): string | null {
  for (const key of ["voxtable_reservation_id", "vocotable_reservation_id"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Reconciler: a BOOKING_CREATED arrived for a uid we don't hold. If the
 * webhook's metadata carries the reservation id we stamp on every
 * outbound push, it is OUR booking echoed back (typically the webhook beating
 * the outbox worker's commit) — attach the uid to exactly that reservation.
 *
 * Returns true if this event is ours (caller must NOT create a reservation) —
 * including when the target row is already stamped or has vanished, because
 * a metadata-bearing event is never a genuine web booking.
 *
 * Exported for the calcom-mirror smoke test.
 */
export async function reconcileMirroredBooking(
  metadata: Record<string, unknown> | undefined,
  uid: string,
  expectedRestaurantId?: string | null
): Promise<boolean> {
  const reservationId = ourReservationId(metadata);
  if (!reservationId) return false;

  const result = await pool.query<{
    id: string;
    restaurant_id: string;
    calcom_booking_uid: string | null;
  }>(
    "SELECT id, restaurant_id, calcom_booking_uid FROM reservations WHERE id = $1",
    [reservationId]
  );
  const row = result.rows[0];
  if (row && expectedRestaurantId && row.restaurant_id !== expectedRestaurantId) {
    // The event type resolved to one venue while the reservation our own
    // metadata points at belongs to another. In practice that means the event
    // type was rebound from venue A to venue B while a push for an A booking
    // was in flight.
    //
    // This used to `return false`, which fell through to the genuine-web-booking
    // path and created a PHANTOM reservation at venue B — carrying the voice
    // caller's name and party size, occupying one of B's tables — while A's
    // reservation never got its uid, so its cancel and reschedule never
    // mirrored. Exactly the uncancellable ghost the rest of this file works to
    // avoid.
    //
    // The presence of our reservation id is positive proof this is our own
    // push echoing back; a genuine web booking can never carry it. So the answer
    // is never "treat it as a web booking" — it is "stop, loudly". Terminal
    // rather than retried, because a rebind does not un-happen, and no cancel
    // back to Cal.com: the reservation at venue A is real and the guest keeps it.
    //
    // Note this does NOT fire for a cross-environment echo: a staging push
    // carries a restaurant UUID production has never seen, so `row` is undefined
    // and the `!row` branch below claims it instead. That case is handled, just
    // not here.
    logger.error({
      evt: "calcom_inbox_tenant_mismatch",
      uid,
      reservation_id: row.id,
      metadata_restaurant_id: row.restaurant_id,
      resolved_restaurant_id: expectedRestaurantId
    });
    throw new PermanentInboxError(
      `Cal.com uid ${uid} carries reservation ${row.id} at restaurant ` +
        `${row.restaurant_id}, but its event type resolves to ${expectedRestaurantId}. ` +
        `Refusing to book; the event type binding likely changed under an in-flight push.`
    );
  }
  if (!row) {
    // Ours, but the reservation is gone (deleted between push and webhook).
    // Still not a web booking — swallow rather than double-create.
    logger.warn({ evt: "calcom_inbox_reconcile_missing_reservation", uid, reservation_id: reservationId });
    return true;
  }
  if (row.calcom_booking_uid) {
    // Already stamped (the worker's commit won the race, or a reschedule
    // echo). Idempotent skip.
    logger.info({ evt: "calcom_inbox_reconcile_already_stamped", uid, reservation_id: row.id });
    return true;
  }
  await updateReservationCalcomUid(row.id, uid);
  logger.info({ evt: "calcom_inbox_reconciled", uid, reservation_id: row.id });
  return true;
}
