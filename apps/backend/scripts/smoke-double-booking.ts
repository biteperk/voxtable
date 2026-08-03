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
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_DATE as DATE,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

const DURATION_MINUTES = 90;

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
  // 10:00 → 02:00, i.e. a window that crosses midnight. This matters: the
  // late-night scenario books 23:00 for 90 minutes, ending at 00:30 the next
  // day. Under an all-day 00:00-23:59 window that booking would be refused by
  // the opening-hours guard, and the test would "pass" without ever exercising
  // the overlap check it exists to prove. Exactly ONE table, so any second
  // booking that survives is a double-booking.
  const { restaurantId, tableIds } = await createSmokeRestaurant({
    name: `smoke-double-booking-${SUFFIX}`,
    phoneNumber: "+61255500000",
    open: "10:00",
    close: "02:00",
    durationMinutes: DURATION_MINUTES,
    tables: [{ label: "T1", minCapacity: 1, maxCapacity: 4 }]
  });
  const tableId = tableIds[0]!;

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
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("double-booking");
}

main().catch(async (error) => {
  console.error("smoke-double-booking crashed:", error);
  process.exit(1);
});
