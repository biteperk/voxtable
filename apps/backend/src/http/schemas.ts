import { z } from "zod";

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
  partySize: partySizeSchema.optional()
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
  source: z.enum(["voice", "dashboard"]).default("voice"),
  notes: z.string().max(1000).optional(),
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

export const menuLookupRetellSchema = z.object({
  query: z.string().max(100).optional(),
  category: z.string().max(60).optional()
});
