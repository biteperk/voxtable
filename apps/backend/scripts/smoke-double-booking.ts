/**
 * Double-booking smoke test — the guarantee the whole product rests on.
 *
 * Two bugs made this necessary (both found 2 Aug 2026, both verified against a
 * real Postgres before being fixed):
 *
 *   1. The overlap check used bare TIME arithmetic, and Postgres wraps it:
 *      '23:00'::time + interval '90 minutes' = '00:30' the SAME day. A late
 *      booking therefore looked like it ended before it started, and every
 *      overlap test returned false. No concurrency needed — it double-booked
 *      every single time.
 *
 *   2. The advisory lock and the unique index both keyed on the exact start
 *      time, so a 19:00 booking lasting 90 minutes and a concurrent 19:30
 *      booking took different lock keys, never serialised, and both committed.
 *
 * This test exercises the REAL createBooking service, so it covers the lock,
 * the availability query and the database constraint together. It builds its
 * own restaurant/table/settings so it does not depend on seed data, and it
 * removes them again at the end.
 *
 * Needs only a migrated database — no HTTP server, no vendor credentials — so
 * it runs in CI against the Postgres service container.
 *
 *   npm run smoke:double-booking
 */
import { pool } from "../src/db/pool";
import { createBooking } from "../src/services/bookingService";

let failures = 0;
function assert(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const SUFFIX = process.pid.toString(36);
const DURATION_MINUTES = 90;
// Computed rather than hard-coded: comfortably in the future so it clears the
// "date in the past" guard, but inside createBooking's one-year-ahead limit —
// and it can never go stale the way a literal date would. Collision with real
// data is impossible regardless, since this test books against a restaurant it
// creates itself.
const DATE = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function setup(): Promise<{ restaurantId: string; tableId: string }> {
  const restaurant = await pool.query<{ id: string }>(
    `INSERT INTO restaurants (name, timezone, phone_number)
     VALUES ($1, 'Australia/Sydney', '+61255500000')
     RETURNING id`,
    [`smoke-double-booking-${SUFFIX}`]
  );
  const restaurantId = restaurant.rows[0]!.id;

  // 10:00 → 02:00, i.e. a window that crosses midnight. This matters: the
  // late-night scenario books 23:00 for 90 minutes, ending at 00:30 the next
  // day. Under an all-day 00:00–23:59 window that booking would be refused by
  // the opening-hours guard, and the test would "pass" without ever exercising
  // the overlap check it exists to prove.
  const hours = JSON.stringify(
    Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
        d,
        [{ open: "10:00", close: "02:00" }]
      ])
    )
  );
  await pool.query(
    `INSERT INTO restaurant_settings (restaurant_id, booking_duration_minutes, opening_hours_json)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (restaurant_id) DO UPDATE
       SET booking_duration_minutes = EXCLUDED.booking_duration_minutes,
           opening_hours_json = EXCLUDED.opening_hours_json`,
    [restaurantId, DURATION_MINUTES, hours]
  );

  // Exactly ONE table, so any second booking that survives is a double-booking.
  const table = await pool.query<{ id: string }>(
    `INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, is_active)
     VALUES ($1, 'T1', 1, 4, true)
     RETURNING id`,
    [restaurantId]
  );

  return { restaurantId, tableId: table.rows[0]!.id };
}

async function cleanup(restaurantId: string): Promise<void> {
  // reservations/tables/settings cascade from restaurants; customers do not.
  await pool.query(`DELETE FROM reservations WHERE restaurant_id = $1`, [restaurantId]);
  await pool.query(`DELETE FROM customers WHERE restaurant_id = $1`, [restaurantId]);
  await pool.query(`DELETE FROM restaurants WHERE id = $1`, [restaurantId]);
}

function book(restaurantId: string, time: string, phone: string) {
  return createBooking({
    restaurantId,
    customerName: `Smoke ${time}`,
    customerPhone: phone,
    date: DATE,
    time,
    partySize: 2,
    source: "voice"
  });
}

async function activeCount(restaurantId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM reservations
      WHERE restaurant_id = $1 AND status NOT IN ('cancelled', 'no_show', 'completed')`,
    [restaurantId]
  );
  return Number(result.rows[0]!.count);
}

async function main(): Promise<void> {
  const { restaurantId, tableId } = await setup();

  try {
    // ---- Scenario 1: late-night overlap, sequential. No race required. ----
    // 23:00 + 90 minutes runs to 00:30 the NEXT day. 23:30 falls inside it.
    // Before the fix this succeeded every time.
    await book(restaurantId, "23:00", "+61400000001");
    let rejected = false;
    try {
      await book(restaurantId, "23:30", "+61400000002");
    } catch {
      rejected = true;
    }
    assert("late-night overlap (23:00 +90m vs 23:30) is rejected", rejected);
    assert("only one late-night booking exists", (await activeCount(restaurantId)) === 1, {
      count: await activeCount(restaurantId)
    });

    await pool.query(`DELETE FROM reservations WHERE restaurant_id = $1`, [restaurantId]);

    // ---- Scenario 2: overlapping starts, concurrent. The original race. ----
    // 19:00 (+90m → 20:30) and 19:30 overlap but start at different times, so
    // the old per-slot lock key never made these two transactions meet.
    const results = await Promise.allSettled([
      book(restaurantId, "19:00", "+61400000003"),
      book(restaurantId, "19:30", "+61400000004")
    ]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    assert("exactly one of two concurrent overlapping bookings wins", won === 1, {
      fulfilled: won,
      rejected: results.filter((r) => r.status === "rejected").length
    });
    assert("database holds exactly one active reservation", (await activeCount(restaurantId)) === 1, {
      count: await activeCount(restaurantId)
    });

    // ---- Scenario 3: the constraint itself, bypassing all application code. ----
    // Proves the guarantee survives any future code path that forgets the lock.
    let constraintHeld = false;
    try {
      await pool.query(
        `INSERT INTO reservations
           (restaurant_id, customer_id, table_id, reservation_date, start_time,
            party_size, status, source, duration_minutes)
         SELECT $1, customer_id, $2, $3::date, '19:45'::time, 2, 'confirmed', 'voice', $4
           FROM reservations WHERE restaurant_id = $1 LIMIT 1`,
        [restaurantId, tableId, DATE, DURATION_MINUTES]
      );
    } catch (error) {
      constraintHeld = /reservations_no_overlap/.test(String(error));
    }
    assert("direct INSERT of an overlapping row is refused by the database", constraintHeld);

    // ---- Scenario 4: a non-overlapping booking still succeeds. ----
    // Guards against "fixed it by rejecting everything".
    let laterAccepted = true;
    try {
      await book(restaurantId, "21:00", "+61400000005");
    } catch (error) {
      laterAccepted = false;
      console.log(`  (unexpected rejection: ${String(error)})`);
    }
    assert("a genuinely free later slot is still bookable", laterAccepted);
  } finally {
    await cleanup(restaurantId);
    await pool.end();
  }

  console.log(failures === 0 ? "\nAll double-booking checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("smoke-double-booking crashed:", error);
  process.exit(1);
});
