/**
 * Zod schemas for every external Cal.com payload we read. Replaces the
 * untyped `as CalcomCreateResponse` / `as Record<string, unknown>` casts that
 * have already let three "silly" production bugs through.
 *
 * Schemas are deliberately PERMISSIVE on extra fields (`.passthrough()` is
 * implicit in Zod by default — `.strict()` would reject) but STRICT on the
 * specific keys we depend on. This way:
 *   * If Cal.com adds a new field, we still parse fine.
 *   * If Cal.com renames/removes a field we depend on, we fail loud with a
 *     structured log, not a silent undefined-access.
 *
 * Boot-time fixture verification (called from server.ts at startup) parses
 * one known-good payload per schema. If a real prod payload no longer matches
 * the schema, the api fails to boot — caught at deploy, not in production.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Cal.com v2: POST /bookings response
// ---------------------------------------------------------------------------
// Real shape observed 2026-05-26 (Drew's successful push):
//   { "status": "success", "data": { "uid": "i9VjQumMpdQfuvURCjtkot", "id": 12345, ... } }
//
// We only depend on `data.uid` (occasionally falling back to `data.id` or a
// top-level `uid` for older shapes). Everything else is just stored as
// metadata in our DB for audit.

export const calcomCreateBookingResponseSchema = z
  .object({
    status: z.string().optional(),
    data: z
      .object({
        uid: z.string().min(1).optional(),
        id: z.union([z.string(), z.number()]).optional()
      })
      .optional(),
    uid: z.string().min(1).optional()
  })
  // Defence-in-depth: at least ONE of the uid-bearing fields must exist on a
  // 200 response. If Cal.com ever returns 200 with no uid, that's a bug
  // worth alarming on.
  .refine(
    (v) => Boolean(v.data?.uid ?? v.uid ?? v.data?.id),
    { message: "Cal.com 200 response contained no booking uid/id." }
  );

export type CalcomCreateBookingResponse = z.infer<typeof calcomCreateBookingResponseSchema>;

export function extractUidFromCreateResponse(response: unknown): string | null {
  const parsed = calcomCreateBookingResponseSchema.safeParse(response);
  if (!parsed.success) return null;
  const v = parsed.data;
  return v.data?.uid ?? v.uid ?? (v.data?.id != null ? String(v.data.id) : null);
}

// ---------------------------------------------------------------------------
// Cal.com v2: webhook payloads
// ---------------------------------------------------------------------------
// Envelope shape (all trigger types):
//   { triggerEvent: "BOOKING_CREATED", createdAt: "...", payload: { ... } }
//
// Inner `payload` varies by triggerEvent. We schematise the keys we actually
// use; unknown keys pass through.

// Common nested types
const calcomAttendeeSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    phoneNumber: z.string().optional(),
    timeZone: z.string().optional(),
    language: z.union([z.string(), z.object({ locale: z.string().optional() })]).optional()
  })
  .passthrough();

// `eventTypeId` is how an inbound booking finds its venue — the Cal.com
// equivalent of the dialed number. It is deliberately OPTIONAL here even though
// the handler cannot proceed without it.
//
// Required would be worse. A required field that Cal.com stops sending makes
// parseCalcomWebhookPayload return "invalid", which throws, which routes/cal.ts
// converts to a 200 — so Cal.com never retries and every web booking is lost
// with nothing but a failed inbox row to show for it. Optional lets the payload
// through to the resolution site, which fails closed loudly, names the event
// type, and cancels the booking back so the guest is not left holding a
// confirmation for a table nobody knows about.
//
// Cal.com has already changed this payload's shape once without a version bump
// (calcom/cal.diy#28508 — the root `attendeeSeatId` was removed), so "the field
// is documented" is not a reason to make parsing depend on it.
const calcomBookingCreatedPayloadSchema = z
  .object({
    uid: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().optional(),
    eventTypeId: z.number().int().positive().optional(),
    attendees: z.array(calcomAttendeeSchema).optional(),
    responses: z.record(z.unknown()).optional(),
    bookingFieldsResponses: z.record(z.unknown()).optional(),
    eventType: z.unknown().optional(),
    organizer: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .passthrough();

const calcomBookingCancelledPayloadSchema = z
  .object({
    uid: z.string().min(1),
    startTime: z.string().optional(),
    eventTypeId: z.number().int().positive().optional(),
    cancellationReason: z.string().optional()
  })
  .passthrough();

const calcomBookingRescheduledPayloadSchema = z
  .object({
    uid: z.string().min(1),
    rescheduleUid: z.string().optional(),
    startTime: z.string().optional(),
    eventTypeId: z.number().int().positive().optional()
  })
  .passthrough();

/**
 * The webhook envelope — every Cal.com webhook is this shape. We discriminate
 * inner payload by triggerEvent; for events we don't handle (PING,
 * BOOKING_REQUESTED, etc.) we accept any shape and the inbox handler ignores
 * them downstream.
 */
export const calcomWebhookEnvelopeSchema = z
  .object({
    triggerEvent: z.string().min(1),
    createdAt: z.string().min(1).optional(),
    payload: z.record(z.unknown()).optional()
  })
  .passthrough();

export type CalcomWebhookEnvelope = z.infer<typeof calcomWebhookEnvelopeSchema>;

/**
 * Narrow + validate the inner payload for a specific known trigger. Returns
 * null if the trigger isn't one we model — caller should ignore those.
 */
export function parseCalcomWebhookPayload(
  trigger: string,
  payload: unknown
): { kind: "created"; data: z.infer<typeof calcomBookingCreatedPayloadSchema> }
  | { kind: "cancelled"; data: z.infer<typeof calcomBookingCancelledPayloadSchema> }
  | { kind: "rescheduled"; data: z.infer<typeof calcomBookingRescheduledPayloadSchema> }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid"; error: string } {
  try {
    switch (trigger) {
      case "BOOKING_CREATED":
      case "BOOKING_CONFIRMED": {
        const result = calcomBookingCreatedPayloadSchema.safeParse(payload);
        if (!result.success) {
          return { kind: "invalid", error: result.error.issues.map((i) => i.message).join("; ") };
        }
        return { kind: "created", data: result.data };
      }
      case "BOOKING_CANCELLED":
      case "BOOKING_CANCELED": {
        const result = calcomBookingCancelledPayloadSchema.safeParse(payload);
        if (!result.success) {
          return { kind: "invalid", error: result.error.issues.map((i) => i.message).join("; ") };
        }
        return { kind: "cancelled", data: result.data };
      }
      case "BOOKING_RESCHEDULED": {
        const result = calcomBookingRescheduledPayloadSchema.safeParse(payload);
        if (!result.success) {
          return { kind: "invalid", error: result.error.issues.map((i) => i.message).join("; ") };
        }
        return { kind: "rescheduled", data: result.data };
      }
      default:
        return { kind: "ignored", reason: `Unhandled trigger: ${trigger}` };
    }
  } catch (err) {
    return { kind: "invalid", error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Boot-time fixture verification
// ---------------------------------------------------------------------------
// Called from server.ts at startup. Validates a small set of known-good
// payloads against the schemas above. If any fixture fails, the api fails to
// boot — that means a schema regression caught BEFORE prod traffic, not after.

const CREATE_RESPONSE_FIXTURE: unknown = {
  status: "success",
  data: {
    uid: "i9VjQumMpdQfuvURCjtkot",
    id: 4242,
    start: "2026-05-30T09:30:00.000Z"
  }
};

// `eventTypeId` and `bookingId` mirror the field names and nesting in the real
// Cal.com payload published in calcom/cal.diy#28508 — not invented shapes.
// `eventTypeId` matters most: it is what resolves a booking to a venue, and a
// fixture that omits it would let a schema regression through to production.
const WEBHOOK_CREATED_FIXTURE: unknown = {
  triggerEvent: "BOOKING_CREATED",
  createdAt: "2026-05-26T08:06:19.740Z",
  payload: {
    uid: "i9VjQumMpdQfuvURCjtkot",
    bookingId: 12345,
    eventTypeId: 3414737,
    startTime: "2026-05-30T09:30:00.000Z",
    endTime: "2026-05-30T11:00:00.000Z",
    attendees: [
      { name: "Drew", email: "61450011130@bookings.vocotable.algorythmos.com.au", phoneNumber: "+61450011130", timeZone: "Australia/Sydney" }
    ],
    responses: { "party-size": "2", name: "Drew" }
  }
};

const WEBHOOK_CANCELLED_FIXTURE: unknown = {
  triggerEvent: "BOOKING_CANCELLED",
  createdAt: "2026-05-26T09:00:00.000Z",
  payload: {
    uid: "i9VjQumMpdQfuvURCjtkot",
    eventTypeId: 3414737,
    cancellationReason: "Guest requested"
  }
};

// Deliberately no eventTypeId. Proves the schema still parses a payload without
// it, which is the whole reason the field is optional: a Cal.com change that
// drops it must degrade to a loud, handled fail-closed at the resolution site,
// never to an "invalid payload" that routes/cal.ts turns into a silent 200.
const WEBHOOK_CREATED_NO_EVENT_TYPE_FIXTURE: unknown = {
  triggerEvent: "BOOKING_CREATED",
  createdAt: "2026-05-26T08:06:19.740Z",
  payload: {
    uid: "i9VjQumMpdQfuvURCjtkot",
    startTime: "2026-05-30T09:30:00.000Z",
    attendees: [{ name: "Drew", email: "drew@example.com" }],
    responses: { "party-size": "2" }
  }
};

/**
 * Throws if any fixture rejects its schema. Call at boot. Log success quietly,
 * fail loud.
 */
export function verifyCalcomSchemasAgainstFixtures(): void {
  const checks: Array<[string, () => void]> = [
    [
      "calcomCreateBookingResponseSchema",
      () => calcomCreateBookingResponseSchema.parse(CREATE_RESPONSE_FIXTURE)
    ],
    [
      "calcomWebhookEnvelopeSchema(BOOKING_CREATED without eventTypeId)",
      () => {
        const env = calcomWebhookEnvelopeSchema.parse(WEBHOOK_CREATED_NO_EVENT_TYPE_FIXTURE);
        const inner = parseCalcomWebhookPayload(env.triggerEvent, env.payload);
        if (inner.kind !== "created") {
          throw new Error(`expected kind=created, got ${inner.kind}`);
        }
      }
    ],
    [
      "calcomWebhookEnvelopeSchema(BOOKING_CREATED)",
      () => {
        const env = calcomWebhookEnvelopeSchema.parse(WEBHOOK_CREATED_FIXTURE);
        const inner = parseCalcomWebhookPayload(env.triggerEvent, env.payload);
        if (inner.kind !== "created") {
          throw new Error(
            `Fixture parsed envelope but inner payload kind=${inner.kind} (expected 'created')`
          );
        }
      }
    ],
    [
      "calcomWebhookEnvelopeSchema(BOOKING_CANCELLED)",
      () => {
        const env = calcomWebhookEnvelopeSchema.parse(WEBHOOK_CANCELLED_FIXTURE);
        const inner = parseCalcomWebhookPayload(env.triggerEvent, env.payload);
        if (inner.kind !== "cancelled") {
          throw new Error(
            `Fixture parsed envelope but inner payload kind=${inner.kind} (expected 'cancelled')`
          );
        }
      }
    ]
  ];

  for (const [name, check] of checks) {
    try {
      check();
    } catch (err) {
      // Fail loud — caller (server.ts) should rethrow so the container restart
      // policy surfaces a CrashLoop, which is a much louder signal than a
      // silent schema drift.
      throw new Error(
        `[calcom-schemas] fixture check '${name}' failed: ${(err as Error).message}`
      );
    }
  }
}
