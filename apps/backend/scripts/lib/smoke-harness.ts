/**
 * Shared harness for DB-backed smoke scripts: the assert/report pattern and
 * the build-your-own-restaurant fixtures every smoke was copy-pasting from
 * smoke-double-booking (SonarCloud's duplication gate finally objected).
 *
 * Each smoke still owns its scenario logic — this is only the scaffolding:
 * a restaurant with settings and tables that exists for one run and is
 * removed afterwards, so no smoke depends on seed data or leaves residue.
 */
import { pool } from "../../src/db/pool";
import { assertSafeSmokeDatabase } from "./smokeTarget";

assertSafeSmokeDatabase();

let failures = 0;

export function assert(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

/** Exit non-zero if any assert failed; call once at the end of the smoke. */
export function reportAndExit(suiteName: string): void {
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nAll ${suiteName} checks passed.`);
}

export const SMOKE_SUFFIX = process.pid.toString(36);

// Comfortably in the future so it clears the "date in the past" guard but
// stays inside createBooking's one-year-ahead limit; can never go stale the
// way a literal date would.
export const SMOKE_DATE = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

export interface SmokeTableSpec {
  label: string;
  minCapacity: number;
  maxCapacity: number;
}

export async function createSmokeRestaurant(opts: {
  name: string;
  phoneNumber: string;
  open?: string;
  close?: string;
  durationMinutes?: number;
  tables: SmokeTableSpec[];
}): Promise<{ restaurantId: string; tableIds: string[] }> {
  const restaurant = await pool.query<{ id: string }>(
    `INSERT INTO restaurants (name, timezone, phone_number)
     VALUES ($1, 'Australia/Sydney', $2)
     RETURNING id`,
    [opts.name, opts.phoneNumber]
  );
  const restaurantId = restaurant.rows[0]!.id;

  const hours = JSON.stringify(
    Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
        d,
        [{ open: opts.open ?? "10:00", close: opts.close ?? "23:00" }]
      ])
    )
  );
  await pool.query(
    `INSERT INTO restaurant_settings (restaurant_id, booking_duration_minutes, opening_hours_json)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (restaurant_id) DO UPDATE
       SET booking_duration_minutes = EXCLUDED.booking_duration_minutes,
           opening_hours_json = EXCLUDED.opening_hours_json`,
    [restaurantId, opts.durationMinutes ?? 90, hours]
  );

  const tableIds: string[] = [];
  for (const table of opts.tables) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [restaurantId, table.label, table.minCapacity, table.maxCapacity]
    );
    tableIds.push(inserted.rows[0]!.id);
  }

  return { restaurantId, tableIds };
}

/** reservations/tables/settings cascade from restaurants; customers do not. */
export async function cleanupSmokeRestaurant(restaurantId: string): Promise<void> {
  await pool.query(`DELETE FROM reservations WHERE restaurant_id = $1`, [restaurantId]);
  await pool.query(`DELETE FROM customers WHERE restaurant_id = $1`, [restaurantId]);
  await pool.query(`DELETE FROM restaurants WHERE id = $1`, [restaurantId]);
}
