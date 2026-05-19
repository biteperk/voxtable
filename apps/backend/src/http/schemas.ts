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

export function normalizePartySize(body: { party_size?: number; partySize?: number }): number {
  return body.party_size ?? body.partySize ?? 0;
}

export function normalizeRestaurantId(
  body: { restaurant_id?: string; restaurantId?: string },
  fallbackRestaurantId: string
): string {
  return body.restaurant_id ?? body.restaurantId ?? fallbackRestaurantId;
}
