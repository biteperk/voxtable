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
import { AppError } from "../domain/errors";
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
  findReservationByCalcomUid,
  updateReservationCalcomUid
} from "../repositories/reservations";
import { enqueueOutbox } from "../repositories/outbox";
import {
  OutboxExecutionResult,
  OutboxExecutorRow,
  setOutboxExecutor
} from "../workers/calcomOutboxWorker";
import { getRestaurantTimezone } from "../repositories/restaurants";
import { utcIsoToZonedWallClock, zonedWallClockToUtcISO } from "../utils/time";
import { normalizePhone } from "../utils/phone";
import { logger } from "../utils/logger";
import { createBooking } from "./bookingService";
import {
  extractUidFromCreateResponse,
  parseCalcomWebhookPayload
} from "./calcomSchemas";

// --- helpers -----------------------------------------------------------------

const SYNTH_EMAIL_DOMAIN = "bookings.vocotable.algorythmos.com.au";

/** Phone digits → `<digits>@bookings.vocotable.algorythmos.com.au`. Cal.com
 *  requires an attendee email; voice callers rarely have one. The domain has
 *  no MX record so bounces stay quiet. */
export function synthesizedEmail(phone: string | null | undefined): string {
  if (!phone) return `unknown@${SYNTH_EMAIL_DOMAIN}`;
  const digits = phone.replace(/\D+/g, "") || "unknown";
  return `${digits}@${SYNTH_EMAIL_DOMAIN}`;
}

/** Mask middle digits of an E.164 number for log output. `+61450011140` →
 *  `+6145****140`. Used so logs aren't a PII liability. */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return "unknown";
  const m = phone.match(/^(\+\d{2,3}\d{2})\d+(\d{3})$/);
  return m ? `${m[1]}****${m[2]}` : phone.slice(0, 6) + "***";
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
    eventTypeId: env.CALCOM_EVENT_TYPE_ID,
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
      vocotable_reservation_id: String(input.reservation.id),
      vocotable_source: String(input.reservation.source),
      vocotable_restaurant_id: String(input.reservation.restaurant_id),
      vocotable_suppress_email: suppressEmail ? "true" : "false"
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

// Cal.com response uid extraction goes through the validated schema in
// services/calcomSchemas.ts (imported at top) — replaces the prior untyped
// `as CalcomCreateResponse` cast that silently allowed schema drift.

async function executeCreate(row: OutboxExecutorRow, db: DbClient): Promise<OutboxExecutionResult> {
  // Loop guard: if the reservation already has a uid (an earlier attempt
  // succeeded on Cal.com but we crashed before COMMIT), treat as success
  // without re-pushing. The unique index on calcom_booking_uid means we
  // can't accidentally double-attach.
  const reservation = await loadReservationForPush(row.reservation_id, db);
  if (!reservation) {
    return {
      outcome: "permanent",
      error: `Reservation ${row.reservation_id} no longer exists; skipping push`
    };
  }
  if (reservation.calcom_booking_uid) {
    return { outcome: "succeeded" };
  }

  const restaurantTimezone = await getRestaurantTimezone(reservation.restaurant_id);
  const payload = buildCreatePayload({
    reservation,
    customerName: reservation.customer_name,
    customerPhone: reservation.customer_phone,
    customerEmail: reservation.customer_email,
    restaurantTimezone
  });

  try {
    const response = await calcomRequest<unknown>({
      method: "POST",
      path: "/bookings",
      body: payload,
      // Audit Sweep F: per-outbox-row idempotency key. If the worker crashes
      // mid-POST and another tick retries, Cal.com returns the SAME booking
      // (matched by this key) instead of creating a duplicate calendar event.
      idempotencyKey: `vocotable-outbox-${row.id}`
    });
    const uid = extractUidFromCreateResponse(response.data);
    if (!uid) {
      return {
        outcome: "permanent",
        error: `Cal.com create returned no uid (status=${response.status}); refusing to retry`
      };
    }
    await updateReservationCalcomUid(reservation.id, uid, db);
    logger.info({
      evt: "calcom_push_success",
      op: "create",
      reservation_id: reservation.id,
      calcom_uid: uid,
      latency_ms: response.durationMs,
      phone_redacted: redactPhone(reservation.customer_phone)
    });
    return { outcome: "succeeded" };
  } catch (error) {
    return classifyCalcomError(error, "create");
  }
}

async function executeCancel(row: OutboxExecutorRow, db: DbClient): Promise<OutboxExecutionResult> {
  const uid = (row.payload as { calcom_booking_uid?: string }).calcom_booking_uid;
  if (!uid) {
    // Nothing to cancel — the reservation never made it to Cal.com.
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

async function executeReschedule(_row: OutboxExecutorRow, _db: DbClient): Promise<OutboxExecutionResult> {
  // Reschedule is implemented as cancel + create at the bookingService layer;
  // by the time we reach the worker we'll be processing those two ops
  // independently. If a 'reschedule' op ever lands here directly, dead-letter
  // it loudly so we notice.
  return {
    outcome: "permanent",
    error: "Direct 'reschedule' ops are not implemented; reschedule via cancel + create."
  };
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

const realExecutor = {
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
  setOutboxExecutor(realExecutor);
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
 */
export async function enqueueCreateForReservation(
  reservationId: string,
  db: DbClient
): Promise<void> {
  if (!env.CALCOM_SYNC_ENABLED) return;
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
      payload: { calcom_booking_uid: calcomUid ?? undefined, reason }
    },
    db
  );
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
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
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

interface CalcomWebhookPayload {
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
    throw new AppError(
      400,
      "CALCOM_PAYLOAD_INVALID",
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

  // Reconcile: did the outbox push succeed but Cal.com webhook beat the
  // commit? Scan pending outbox rows matching this booking's start time.
  // (We rely on the unique index to ensure uid uniqueness — if we find a
  // match here, we're stamping our own row.)
  const reconciled = await tryReconcileOutboxRow(uid);
  if (reconciled) return;

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

  // A "real" phone is anything non-empty that isn't the @bookings.vocotable
  // synthetic email Cal.com gives us when the customer didn't provide one.
  const normalizedPhone = normalizePhone(phone);
  const phoneIsSynthetic =
    !phone ||
    phone.includes(`@${SYNTH_EMAIL_DOMAIN}`) ||
    (customerEmail && customerEmail.includes(`@${SYNTH_EMAIL_DOMAIN}`) && !normalizedPhone);
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

  // NOT the same class of bug as the Twilio call-log leak that was fixed
  // alongside this. Cal.com is configured with a SINGLE global
  // CALCOM_EVENT_TYPE_ID and there is no per-restaurant Cal.com config in the
  // schema, so today every inbound web booking genuinely does belong to the
  // default restaurant — there is nothing to resolve against.
  //
  // This becomes a real cross-tenant bug the moment Cal.com config goes
  // per-restaurant. At that point resolve the tenant from the event type on the
  // webhook payload, the way twilioService resolves from the dialed number.
  const restaurantTimezone = await getRestaurantTimezone(env.DEFAULT_RESTAURANT_ID);
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
      restaurantId: env.DEFAULT_RESTAURANT_ID,
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
    logger.error({ evt: "calcom_inbox_web_booking_rejected", uid, error });
    try {
      await calcomRequest({
        method: "POST",
        path: `/bookings/${encodeURIComponent(uid)}/cancel`,
        body: { cancellationReason: `VoxTable rejected: ${message}` }
      });
    } catch (cancelError) {
      logger.error({ evt: "calcom_inbox_undo_cancel_failed", uid, error: cancelError });
    }
    throw error;
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
  if (existing.status === "cancelled") {
    return; // already cancelled — likely our own echo
  }
  // Cancel in our DB. Don't push back to Cal.com (it already happened there).
  await pool.query(
    "UPDATE reservations SET status = 'cancelled', cancellation_reason = $2, cancelled_at = now() WHERE id = $1",
    [existing.id, "Cancelled via Cal.com"]
  );
  logger.info({ evt: "calcom_inbox_cancel_applied", uid, reservation_id: existing.id });
}

/**
 * Reconciler: a BOOKING_CREATED arrived for a uid we don't have. Maybe our
 * own outbox push succeeded but the commit hasn't landed yet OR a worker
 * mis-stamping bug. Look for pending create-ops whose stored payload-implied
 * (date,time) matches the webhook. If exactly one matches, attach the uid.
 *
 * Returns true if reconciled (caller should NOT create a new reservation).
 */
async function tryReconcileOutboxRow(uid: string): Promise<boolean> {
  // Pessimistic scan — the outbox is usually small, and this only runs for
  // unmatched BOOKING_CREATED events. If the table gets huge we'll add an
  // index on (op, succeeded_at).
  const result = await readPool.query<{ reservation_id: string }>(
    `
    SELECT o.reservation_id
      FROM outbox_calcom o
      JOIN reservations r ON r.id = o.reservation_id
     WHERE o.op = 'create'
       AND o.succeeded_at IS NULL
       AND o.failed_at IS NULL
       AND r.calcom_booking_uid IS NULL
     ORDER BY o.created_at DESC
     LIMIT 5
    `
  );
  if (result.rows.length !== 1) return false;
  const reservationId = result.rows[0]!.reservation_id;
  await updateReservationCalcomUid(reservationId, uid);
  logger.info({ evt: "calcom_inbox_reconciled", uid, reservation_id: reservationId });
  return true;
}
