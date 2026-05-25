import { AppError } from "../domain/errors";
import { RestaurantSettings } from "../domain/types";
import { DbClient, pool } from "../db/pool";

interface RestaurantSettingsRow {
  restaurant_id: string;
  booking_duration_minutes: number;
  opening_hours_json: Record<string, unknown>;
  faq_json: Record<string, unknown>;
  voice_config_json: Record<string, unknown>;
}

export async function getRestaurantSettings(
  restaurantId: string,
  db: DbClient = pool
): Promise<RestaurantSettings> {
  const result = await db.query<RestaurantSettingsRow>(
    `
    SELECT
      restaurant_id,
      booking_duration_minutes,
      opening_hours_json,
      faq_json,
      voice_config_json
    FROM restaurant_settings
    WHERE restaurant_id = $1
    `,
    [restaurantId]
  );

  const row = result.rows[0];

  if (!row) {
    throw new AppError(404, "RESTAURANT_SETTINGS_NOT_FOUND", "Restaurant settings were not found.");
  }

  return {
    restaurantId: row.restaurant_id,
    bookingDurationMinutes: row.booking_duration_minutes,
    openingHours: row.opening_hours_json as RestaurantSettings["openingHours"],
    faq: row.faq_json,
    voiceConfig: row.voice_config_json
  };
}

export async function getTransferPhoneNumber(restaurantId: string): Promise<string | null> {
  const result = await pool.query<{ transfer_phone_number: string | null }>(
    "SELECT transfer_phone_number FROM restaurants WHERE id = $1",
    [restaurantId]
  );

  return result.rows[0]?.transfer_phone_number ?? null;
}

const timezoneCache = new Map<string, string>();

export async function getRestaurantTimezone(restaurantId: string): Promise<string> {
  const cached = timezoneCache.get(restaurantId);
  if (cached) return cached;

  const result = await pool.query<{ timezone: string }>(
    "SELECT timezone FROM restaurants WHERE id = $1",
    [restaurantId]
  );

  const tz = result.rows[0]?.timezone ?? "Australia/Sydney";
  timezoneCache.set(restaurantId, tz);
  return tz;
}

export async function getRestaurantName(restaurantId: string): Promise<string> {
  const result = await pool.query<{ name: string }>(
    "SELECT name FROM restaurants WHERE id = $1",
    [restaurantId]
  );
  return result.rows[0]?.name ?? "the restaurant";
}
