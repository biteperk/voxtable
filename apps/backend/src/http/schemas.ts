import { z } from "zod";

import { isValidAbn } from "../utils/abn";

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidClockTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);

  if (!match) {
    return false;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.")
  .refine(isValidCalendarDate, "Expected a valid calendar date.");

export const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "Expected HH:mm.")
  .refine(isValidClockTime, "Expected a valid 24-hour time.");
const partySizeSchema = z.coerce.number().int().min(1).max(50);
const uuidSchema = z.string().uuid();

export const availabilityRequestSchema = z.object({
  restaurant_id: uuidSchema.optional(),
  restaurantId: uuidSchema.optional(),
  date: dateSchema,
  time: timeSchema,
  party_size: partySizeSchema.optional(),
  partySize: partySizeSchema.optional(),
  seating_preference: z.string().max(120).optional(),
  seatingPreference: z.string().max(120).optional()
});

export const tableAvailabilityQuerySchema = z.object({
  date: dateSchema,
  time: timeSchema,
  party_size: partySizeSchema.optional(),
  partySize: partySizeSchema.optional(),
  exclude_reservation_id: uuidSchema.optional(),
  excludeReservationId: uuidSchema.optional()
});

export const createBookingRequestSchema = z.object({
  restaurant_id: uuidSchema.optional(),
  restaurantId: uuidSchema.optional(),
  customer_name: z.string().min(1).max(120).optional(),
  customerName: z.string().min(1).max(120).optional(),
  customer_phone: z.string().min(5).max(40).optional(),
  customerPhone: z.string().min(5).max(40).optional(),
  date: dateSchema,
  time: timeSchema,
  party_size: partySizeSchema.optional(),
  partySize: partySizeSchema.optional(),
  table_id: uuidSchema.optional(),
  tableId: uuidSchema.optional(),
  source: z.enum(["voice", "dashboard"]).default("voice"),
  notes: z.string().max(1000).optional(),
  // Stopgap (A) for seating requests: the voice agent passes a free-text seating
  // preference ("window", "patio", "quiet corner"). For now it's folded into the
  // booking notes so staff can honour it manually; the full zone-aware allocation
  // (B) will reuse this same field once the real floor plan is known.
  seating_preference: z.string().max(120).optional(),
  seatingPreference: z.string().max(120).optional(),
  call_log_id: uuidSchema.optional(),
  callLogId: uuidSchema.optional(),
  provider_call_id: z.string().max(200).optional(),
  providerCallId: z.string().max(200).optional()
});

export const updateBookingRequestSchema = z.object({
  date: dateSchema.optional(),
  time: timeSchema.optional(),
  party_size: partySizeSchema.optional(),
  partySize: partySizeSchema.optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(["pending", "confirmed", "cancelled", "no_show", "completed"]).optional()
});

export const cancelBookingRequestSchema = z.object({
  reason: z.string().max(500).optional(),
  source: z.enum(["voice", "dashboard"]).optional()
});

/**
 * Schema for the Retell `modify_booking` tool. Required: booking_id (the
 * UUID returned by a prior create_booking in the same conversation). All
 * other fields are partial — Bella sends only what changed. Dual-key for
 * LLM tolerance.
 */
export const modifyBookingRequestSchema = z.object({
  booking_id: uuidSchema.optional(),
  bookingId: uuidSchema.optional(),
  customer_name: z.string().min(1).max(120).optional(),
  customerName: z.string().min(1).max(120).optional(),
  date: dateSchema.optional(),
  time: timeSchema.optional(),
  party_size: partySizeSchema.optional(),
  partySize: partySizeSchema.optional(),
  notes: z.string().max(1000).optional()
}).refine(
  (v) => Boolean(v.booking_id ?? v.bookingId),
  { message: "booking_id is required.", path: ["booking_id"] }
);

export type ModifyBookingArgs = z.infer<typeof modifyBookingRequestSchema>;

export function normalizeModifyBookingArgs(args: ModifyBookingArgs) {
  return {
    bookingId: (args.booking_id ?? args.bookingId)!,
    customerName: args.customer_name ?? args.customerName,
    date: args.date,
    time: args.time,
    partySize: args.party_size ?? args.partySize,
    notes: args.notes
  };
}

export function normalizePartySize(body: { party_size?: number; partySize?: number }): number {
  return body.party_size ?? body.partySize ?? 0;
}

export function normalizeRestaurantId(
  _body: { restaurant_id?: string; restaurantId?: string },
  fallbackRestaurantId: string
): string {
  // SECURITY: single-tenant v1. Caller-supplied restaurant_id is ignored to
  // prevent a malicious prompt or HTTP client from booking at a different
  // restaurant. Remove this lockdown when multi-tenant lands.
  return fallbackRestaurantId;
}

// ===== KDS (Kitchen Display System) schemas =====

const priceCentsSchema = z.coerce.number().int().min(0).max(1_000_000);
const signedDeltaCentsSchema = z.coerce.number().int().min(-1_000_000).max(1_000_000);

const variantInputSchema = z.object({
  name: z.string().min(1).max(80),
  price_delta_cents: signedDeltaCentsSchema.optional(),
  priceDeltaCents: signedDeltaCentsSchema.optional(),
  display_order: z.number().int().min(0).max(1000).optional(),
  displayOrder: z.number().int().min(0).max(1000).optional()
});

const modifierOptionInputSchema = z.object({
  name: z.string().min(1).max(80),
  price_delta_cents: signedDeltaCentsSchema.optional(),
  priceDeltaCents: signedDeltaCentsSchema.optional(),
  is_default: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  display_order: z.number().int().min(0).max(1000).optional(),
  displayOrder: z.number().int().min(0).max(1000).optional()
});

const modifierGroupInputSchema = z.object({
  group_name: z.string().min(1).max(60).optional(),
  groupName: z.string().min(1).max(60).optional(),
  group_min_select: z.number().int().min(0).max(20).optional(),
  groupMinSelect: z.number().int().min(0).max(20).optional(),
  group_max_select: z.number().int().min(1).max(20).optional(),
  groupMaxSelect: z.number().int().min(1).max(20).optional(),
  options: z.array(modifierOptionInputSchema).min(1).max(20)
}).refine((v) => Boolean(v.group_name ?? v.groupName), {
  message: "group_name required",
  path: ["group_name"]
});

export const menuCategoryRequestSchema = z.object({
  name: z.string().min(1).max(80),
  display_order: z.number().int().min(0).max(1000).optional(),
  displayOrder: z.number().int().min(0).max(1000).optional(),
  is_active: z.boolean().optional(),
  isActive: z.boolean().optional()
});

export const menuItemRequestSchema = z.object({
  category_id: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  base_price_cents: priceCentsSchema.optional(),
  basePriceCents: priceCentsSchema.optional(),
  image_url: z.string().url().max(1000).optional().nullable(),
  imageUrl: z.string().url().max(1000).optional().nullable(),
  image_blurhash: z.string().max(200).optional().nullable(),
  imageBlurhash: z.string().max(200).optional().nullable(),
  display_order: z.number().int().min(0).max(1000).optional(),
  displayOrder: z.number().int().min(0).max(1000).optional(),
  is_available: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  variants: z.array(variantInputSchema).max(10).optional(),
  modifier_groups: z.array(modifierGroupInputSchema).max(10).optional(),
  modifierGroups: z.array(modifierGroupInputSchema).max(10).optional()
});

const orderItemInputSchema = z.object({
  menu_item_id: uuidSchema.optional(),
  menuItemId: uuidSchema.optional(),
  variant_id: uuidSchema.optional(),
  variantId: uuidSchema.optional(),
  quantity: z.coerce.number().int().min(1).max(50),
  modifier_ids: z.array(uuidSchema).max(20).optional(),
  modifierIds: z.array(uuidSchema).max(20).optional(),
  special_requests: z.string().max(500).optional(),
  specialRequests: z.string().max(500).optional()
}).refine((v) => Boolean(v.menu_item_id ?? v.menuItemId), {
  message: "menu_item_id required",
  path: ["menu_item_id"]
});

export const createOrderRequestSchema = z.object({
  restaurant_id: uuidSchema.optional(),
  restaurantId: uuidSchema.optional(),
  reservation_id: uuidSchema.optional(),
  reservationId: uuidSchema.optional(),
  table_id: uuidSchema.optional(),
  tableId: uuidSchema.optional(),
  source: z.enum(["voice", "waiter", "qr", "dashboard"]).default("dashboard"),
  items: z.array(orderItemInputSchema).min(1).max(50),
  special_instructions: z.string().max(1000).optional(),
  specialInstructions: z.string().max(1000).optional()
});

export const updateOrderStatusRequestSchema = z.object({
  status: z.enum(["pending", "preparing", "ready", "served", "cancelled"]),
  cancellation_reason: z.string().max(500).optional(),
  cancellationReason: z.string().max(500).optional()
});

export const updateOrderItemStatusRequestSchema = z.object({
  status: z.enum(["queued", "preparing", "ready", "served"])
});

export const updatePaymentStatusRequestSchema = z.object({
  payment_status: z.enum(["unpaid", "paid", "refunded"]).optional(),
  paymentStatus: z.enum(["unpaid", "paid", "refunded"]).optional()
}).refine((v) => Boolean(v.payment_status ?? v.paymentStatus), {
  message: "payment_status required",
  path: ["payment_status"]
});

export const createOrderRetellSchema = z.object({
  // Retell sends call_id; we use it as the idempotency key.
  call_id: z.string().min(1).max(200).optional(),
  callId: z.string().min(1).max(200).optional(),
  reservation_id: uuidSchema.optional(),
  reservationId: uuidSchema.optional(),
  items: z.array(
    z.object({
      name: z.string().min(1).max(120),
      variant_name: z.string().max(80).optional(),
      variantName: z.string().max(80).optional(),
      quantity: z.coerce.number().int().min(1).max(20).default(1),
      modifier_choices: z.record(z.union([z.string(), z.array(z.string())])).optional(),
      modifierChoices: z.record(z.union([z.string(), z.array(z.string())])).optional(),
      special_requests: z.string().max(300).optional(),
      specialRequests: z.string().max(300).optional()
    })
  ).min(1).max(20),
  special_instructions: z.string().max(500).optional(),
  specialInstructions: z.string().max(500).optional()
});

export const sendPaymentLinkRetellSchema = z.object({
  call_id: z.string().min(1).max(200).optional(),
  callId: z.string().min(1).max(200).optional(),
  order_id: uuidSchema.optional(),
  orderId: uuidSchema.optional(),
  // Optional recipient the caller read out; defaults to the caller's own
  // number from the call log when absent. Free-form here — normalizePhone
  // decides what's textable.
  phone: z.string().max(32).optional(),
  phone_number: z.string().max(32).optional(),
  phoneNumber: z.string().max(32).optional()
});

export const menuLookupRetellSchema = z.object({
  query: z.string().max(100).optional(),
  category: z.string().max(60).optional()
});

// --- Onboarding & restaurant profile (Phase 1) -----------------------------

export const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;

// Controlled cuisine list so the value is categorisable (drives future search /
// agent prompt hints). "Other" is the escape hatch.
export const CUISINE_OPTIONS = [
  "Italian",
  "Chinese",
  "Japanese",
  "Thai",
  "Indian",
  "Vietnamese",
  "Greek",
  "Lebanese",
  "Mexican",
  "French",
  "Modern Australian",
  "Cafe",
  "Steakhouse",
  "Seafood",
  "Pizza",
  "Burgers",
  "Vegan",
  "Other"
] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// day -> intervals. Overnight (close < open) is allowed (e.g. 18:00–02:00), so
// only the HH:MM format is validated, not ordering.
const openingHoursSchema = z
  .record(
    z.string(),
    z
      .array(
        z.object({
          open: z.string().regex(HHMM, "open must be HH:MM"),
          close: z.string().regex(HHMM, "close must be HH:MM")
        })
      )
      .max(4)
  )
  .optional();

export const createRestaurantSchema = z.object({
  name: z.string().trim().min(2).max(120)
});

export const restaurantProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  address: z.string().trim().max(200).optional(),
  suburb: z.string().trim().max(80).optional(),
  state: z.enum(AU_STATES).optional(),
  postcode: z
    .string()
    .regex(/^\d{4}$/, "postcode must be 4 digits")
    .optional(),
  cuisine_type: z.array(z.enum(CUISINE_OPTIONS)).min(1).max(5).optional(),
  contact_email: z.string().email().max(160).optional(),
  owner_name: z.string().trim().max(120).optional(),
  logo_url: z.string().url().max(500).optional(),
  existing_phone_number: z.string().trim().max(32).optional(),
  booking_duration_minutes: z.coerce.number().int().min(15).max(360).optional(),
  opening_hours: openingHoursSchema
});

export const supportRequestSchema = z.object({
  category: z.enum(["account", "billing", "booking", "technical", "other"]).default("technical"),
  subject: z.string().trim().min(3).max(120),
  message: z.string().trim().min(10).max(2000)
});

// Owner-driven onboarding transitions only. Subscription/provisioning events
// are server-internal (Stripe webhook / admin), and agreement_completed only
// fires from POST /api/onboarding/agreement (the transition must carry the
// consent + acceptance-ledger write) — none of those are accepted here.
export const onboardingAdvanceSchema = z.object({
  event: z.enum(["profile_completed", "menu_completed", "trial_started"])
});

// --- Legal layer: the Order Form as a form (agreement wizard step) ----------

// Sellable services. voxconcierge ships dark behind SERVICES_VOXCONCIERGE_ENABLED
// (checked at the route — schemas stay env-free). voxdrive is deliberately
// absent: it is a concept product and its absence from this enum IS the
// enforcement that it can never be sold.
export const AGREEMENT_SERVICES = ["voxtable", "voxorder", "voxconcierge"] as const;

// en-AU only until multilingual genuinely ships (decision D2, 29 Jul 2026):
// the CSA is narrowed to English rather than promising languages the agent
// cannot announce itself in. Deliberately not a client-supplied field.
export const AGREEMENT_LANGUAGES = ["en-AU"] as const;

export const agreementSchema = z.object({
  client_legal_name: z.string().trim().min(2).max(200),
  client_abn: z
    .string()
    .trim()
    .transform((s) => s.replace(/\s+/g, ""))
    .pipe(
      z
        .string()
        .regex(/^\d{11}$/, "ABN must be 11 digits")
        .refine(isValidAbn, "That ABN fails the ATO checksum — please re-check it.")
    ),
  services: z.array(z.enum(AGREEMENT_SERVICES)).nonempty("Select at least one service."),
  phone_mode: z.enum(["forward_existing", "new_dedicated"]),
  delivery_targets: z
    .object({
      emails: z.array(z.string().email().max(160)).max(5).default([]),
      dashboard: z.boolean().default(true)
    })
    .default({ emails: [], dashboard: true }),
  // 30 or 90 days (Privacy & Data Handling Schedule §8). There is
  // intentionally no "keep forever" option.
  retention_days: z.union([z.literal(30), z.literal(90)]),
  storage_tier: z.enum(["everything", "everything_except_pii"]),
  pii_redaction: z.boolean().default(false),
  service_start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "start date must be YYYY-MM-DD")
    .optional(),
  // Three SEPARATE consents doing three different legal jobs: contract
  // acceptance (CSA + Schedule), the APP 8 overseas-processing acknowledgement
  // (CSA 6.4), and the mandatory caller-disclosure warranty (CSA 4.3).
  // z.literal(true): absent or false both fail validation.
  consent_terms: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Client Services Agreement to continue." })
  }),
  consent_overseas: z.literal(true, {
    errorMap: () => ({ message: "You must acknowledge the overseas-processing disclosure." })
  }),
  consent_disclosure: z.literal(true, {
    errorMap: () => ({ message: "You must acknowledge the mandatory caller disclosure." })
  })
});

// Admin provisioning bind (Phase 4a) — all optional so an admin can fill in
// pieces as they're provisioned.
export const adminProvisioningSchema = z.object({
  twilio_phone_number: z.string().min(3).max(32).optional(),
  retell_phone_number: z.string().min(3).max(32).optional(),
  retell_agent_id: z.string().min(3).max(120).optional()
});

// --- Menu OCR ingestion (Phase 2) ------------------------------------------

// Prices are integer cents (never floats). Cap at $10,000 to reject obvious
// parse blunders (e.g. a phone number read as a price).
const draftPriceCentsSchema = z.number().int().min(0).max(1_000_000);

/**
 * A variant/option price DIFFERENCE, which may be negative — a kids or entrée
 * portion is priced below the dish it belongs to. `menu_item_variants
 * .price_delta_cents` is signed for exactly this reason (006_kds_schema.sql),
 * and the manual editing API has always allowed it via signedDeltaCentsSchema.
 *
 * Only the OCR draft required deltas to be >= 0, so a model that correctly read
 * "Kids portion -$3.00" failed the ENTIRE menu with "the menu parser returned an
 * unexpected shape" — the one row it got right poisoning every row it got right.
 */
const draftDeltaCentsSchema = z.number().int().min(-1_000_000).max(1_000_000);

const draftVariantSchema = z.object({
  name: z.string().min(1).max(80),
  price_delta_cents: draftDeltaCentsSchema.default(0)
});

const draftModifierOptionSchema = z.object({
  name: z.string().min(1).max(80),
  price_delta_cents: draftDeltaCentsSchema.default(0),
  is_default: z.boolean().optional()
});

const draftModifierGroupSchema = z.object({
  group_name: z.string().min(1).max(80),
  min_select: z.number().int().min(0).max(20).default(0),
  max_select: z.number().int().min(1).max(20).default(1),
  options: z.array(draftModifierOptionSchema).max(40)
});

const draftItemSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  price_cents: draftPriceCentsSchema,
  // Per-item OCR confidence (0–1) so the review UI can flag uncertain rows.
  confidence: z.number().min(0).max(1).optional(),
  variants: z.array(draftVariantSchema).max(20).optional(),
  modifier_groups: z.array(draftModifierGroupSchema).max(10).optional()
});

const draftCategorySchema = z.object({
  name: z.string().min(1).max(80),
  items: z.array(draftItemSchema).max(120)
});

// The structured menu draft — produced by the vision LLM, edited by the owner,
// then committed to menu_items. Same shape end-to-end.
export const menuDraftSchema = z.object({
  categories: z.array(draftCategorySchema).max(40)
});

export type MenuDraft = z.infer<typeof menuDraftSchema>;

/** Product cap on pages per import. */
export const MENU_INGEST_MAX_PAGES = 48;

// --- What ONE vision call returns ------------------------------------------
//
// Deliberately a different type from MenuDraft. The draft is what we persist
// and what the owner edits; this is only ever the model's answer, and the two
// must be free to diverge. Page attribution in particular lives here and is
// never written to the draft — `PATCH /api/menu/ingest/:jobId/draft` re-parses
// the owner's edits through menuDraftSchema, so anything not in that schema is
// stripped on their first save.

/**
 * One page's worth of an answer.
 *
 * Every field fails SOFT. A batch is an expensive, already-paid-for vision
 * call, and rejecting the whole thing because the model mislabelled one page
 * number would turn a small slip into a total loss — the exact shape of the bug
 * that made a negative variant price fail an entire menu (see
 * draftDeltaCentsSchema above). Out-of-range page numbers become 0 here and are
 * treated as "unattributed" downstream, never clamped onto a real page.
 */
const ocrPageSchema = z.object({
  page: z.number().int().catch(0),
  page_kind: z.enum(["items", "cover", "contact", "hours", "photos", "other"]).optional().catch(undefined),
  categories: z.array(draftCategorySchema).max(40).catch([])
});

/**
 * Page-grouped output, with the old flat shape still accepted.
 *
 * The envelope makes "page 3 produced nothing" structural rather than inferred:
 * the model must emit an entry per page it was given, so an omission is as
 * informative as a zero. The union is not optional politeness — a model that
 * ignores the envelope has to degrade to "attribution unknown" (which forces
 * verification) rather than to a failed batch.
 */
export const menuOcrBatchSchema = z.union([
  z.object({ pages: z.array(ocrPageSchema).min(1).max(MENU_INGEST_MAX_PAGES) }),
  menuDraftSchema
]);

export type MenuOcrBatch = z.infer<typeof menuOcrBatchSchema>;

/**
 * The single-page recovery call. `price_text` is the price exactly as printed,
 * so a pure parse of it can be checked against the cents the model computed —
 * the one place we can catch a conversion slip without a human.
 */
const verifyItemSchema = draftItemSchema.extend({
  price_text: z.string().max(40).optional()
});

export const menuOcrVerifySchema = z.object({
  has_priced_items: z.boolean().catch(false),
  page_note: z.string().max(160).optional().catch(undefined),
  categories: z
    .array(z.object({ name: z.string().min(1).max(80), items: z.array(verifyItemSchema).max(120) }))
    .max(40)
    .catch([])
});

export type MenuOcrVerify = z.infer<typeof menuOcrVerifySchema>;

/**
 * Start a menu import.
 *
 * `source_urls` is the current shape — one entry per rendered page, in order.
 * `source_url` is the original single-page shape and is still accepted, because
 * the frontend and backend deploy independently and an older client must keep
 * working. Exactly one of the two is required; the transform collapses them so
 * everything downstream only ever deals with an array.
 *
 * The page cap is enforced here AND by a CHECK constraint in migration 023 —
 * this is the friendly rejection, that one is the guarantee.
 */
export const startIngestionSchema = z
  .object({
    source_url: z.string().url().max(2000).optional(),
    source_urls: z.array(z.string().url().max(2000)).min(1).max(MENU_INGEST_MAX_PAGES).optional(),
    source_kind: z.enum(["image", "pdf"]),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, "sha256 must be 64 hex chars")
      .optional()
  })
  .refine((v) => Boolean(v.source_urls?.length) || Boolean(v.source_url), {
    message: "Provide the uploaded menu page(s).",
    path: ["source_urls"]
  })
  .transform((v) => ({
    source_kind: v.source_kind,
    sha256: v.sha256,
    source_urls: v.source_urls?.length ? v.source_urls : [v.source_url as string]
  }));

const tableAttributeSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, "Use letters, numbers, spaces, hyphens or underscores.");

export const tablePayloadSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    min_capacity: z.coerce.number().int().min(1).max(50).optional(),
    minCapacity: z.coerce.number().int().min(1).max(50).optional(),
    max_capacity: z.coerce.number().int().min(1).max(50).optional(),
    maxCapacity: z.coerce.number().int().min(1).max(50).optional(),
    zone: z.string().trim().min(1).max(40).nullable().optional(),
    description: z.string().trim().max(200).nullable().optional(),
    attributes: z.array(tableAttributeSchema).max(12).optional()
  })
  .refine((value) => Boolean(value.max_capacity ?? value.maxCapacity), {
    message: "max_capacity is required.",
    path: ["max_capacity"]
  })
  .refine((value) => (value.min_capacity ?? value.minCapacity ?? 1) <= (value.max_capacity ?? value.maxCapacity ?? 0), {
    message: "min_capacity must be less than or equal to max_capacity.",
    path: ["min_capacity"]
  });

// Manager edit of table map metadata. Both camelCase and snake_case capacity
// keys are accepted to match the existing dashboard API style.
export const updateTableMetadataSchema = z
  .object({
    label: z.string().trim().min(1).max(40).optional(),
    min_capacity: z.coerce.number().int().min(1).max(50).optional(),
    minCapacity: z.coerce.number().int().min(1).max(50).optional(),
    max_capacity: z.coerce.number().int().min(1).max(50).optional(),
    maxCapacity: z.coerce.number().int().min(1).max(50).optional(),
    zone: z.string().trim().min(1).max(40).nullable().optional(),
    description: z.string().trim().max(200).nullable().optional(),
    attributes: z.array(tableAttributeSchema).max(12).optional()
  })
  .refine(
    (value) =>
      value.label !== undefined ||
      value.min_capacity !== undefined ||
      value.minCapacity !== undefined ||
      value.max_capacity !== undefined ||
      value.maxCapacity !== undefined ||
      value.zone !== undefined ||
      value.description !== undefined ||
      value.attributes !== undefined,
    { message: "Provide at least one field to update." }
  )
  .refine((value) => {
    const min = value.min_capacity ?? value.minCapacity;
    const max = value.max_capacity ?? value.maxCapacity;
    return min === undefined || max === undefined || min <= max;
  }, {
    message: "min_capacity must be less than or equal to max_capacity.",
    path: ["min_capacity"]
  });
