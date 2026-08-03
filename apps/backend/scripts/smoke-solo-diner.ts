/**
 * Solo-diner capacity smoke (audit B14).
 *
 * `min_capacity` was a hard WHERE filter, so a restaurant whose smallest
 * table had min_capacity = 2 refused every party of one — at an empty
 * dining room — and told the caller the TIME was the problem ("No suitable
 * table is available near the requested time"), so no alternative could
 * ever surface. It is now a ranking preference: seat the solo diner at the
 * best-fitting table, preferring tables whose minimum is actually met.
 * `max_capacity` stays hard — a party of five cannot sit at a four-top.
 *
 *   npm run smoke:solo-diner
 */
import { pool } from "../src/db/pool";
import { createBooking } from "../src/services/bookingService";

let failures = 0;
function assert(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const SUFFIX = process.pid.toString(36);
const DATE = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function setupRestaurant(name: string): Promise<string> {
  const restaurant = await pool.query<{ id: string }>(
    `INSERT INTO restaurants (name, timezone, phone_number)
     VALUES ($1, 'Australia/Sydney', $2) RETURNING id`,
    [name, `+6125550${Math.floor(Math.random() * 900) + 100}`]
  );
  const restaurantId = restaurant.rows[0]!.id;
  const hours = JSON.stringify(
    Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
        d,
        [{ open: "10:00", close: "23:00" }]
      ])
    )
  );
  await pool.query(
    `INSERT INTO restaurant_settings (restaurant_id, booking_duration_minutes, opening_hours_json)
     VALUES ($1, 90, $2::jsonb)
     ON CONFLICT (restaurant_id) DO UPDATE
       SET booking_duration_minutes = EXCLUDED.booking_duration_minutes,
           opening_hours_json = EXCLUDED.opening_hours_json`,
    [restaurantId, hours]
  );
  return restaurantId;
}

async function addTable(
  restaurantId: string,
  label: string,
  minCapacity: number,
  maxCapacity: number
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, is_active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [restaurantId, label, minCapacity, maxCapacity]
  );
  return r.rows[0]!.id;
}

async function cleanup(restaurantId: string): Promise<void> {
  await pool.query("DELETE FROM reservations WHERE restaurant_id = $1", [restaurantId]);
  await pool.query("DELETE FROM customers WHERE restaurant_id = $1", [restaurantId]);
  await pool.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]);
}

function book(restaurantId: string, time: string, partySize: number, phone: string) {
  return createBooking({
    restaurantId,
    customerName: `Solo ${time}`,
    customerPhone: phone,
    date: DATE,
    time,
    partySize,
    source: "voice"
  });
}

async function main(): Promise<void> {
  // ---- 1: empty restaurant, only two-tops with min_capacity=2 ------------
  const strict = await setupRestaurant(`smoke-solo-strict-${SUFFIX}`);
  await addTable(strict, "T1", 2, 4);
  try {
    const solo = await book(strict, "12:00", 1, "+61255511021").then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e: (e as Error).message })
    );
    assert(
      "a solo diner is seated at an empty restaurant whose smallest table has min_capacity=2 (old code: refused)",
      solo.ok,
      solo.ok ? undefined : solo.e
    );

    // max_capacity stays a hard bound.
    const oversized = await book(strict, "15:00", 5, "+61255511022").then(
      () => true,
      () => false
    );
    assert("a party of five is still refused when the biggest table seats four", oversized === false);
  } finally {
    await cleanup(strict);
  }

  // ---- 2: preference — the min-satisfied table wins over the under-filled -
  const mixed = await setupRestaurant(`smoke-solo-mixed-${SUFFIX}`);
  // Insert the big-minimum table FIRST and with an earlier label so any
  // insertion-order or label-order accident would pick it — only the
  // min-satisfied ranking can choose T2.
  const bigMin = await addTable(mixed, "A-big", 2, 4);
  const soloFit = await addTable(mixed, "B-solo", 1, 2);
  try {
    const seated = await book(mixed, "12:00", 1, "+61255511023");
    const row = await pool.query<{ table_id: string }>(
      "SELECT table_id FROM reservations WHERE id = $1",
      [seated.bookingId]
    );
    assert(
      "the solo diner gets the table whose minimum is satisfied, not the under-filled two-top",
      row.rows[0]!.table_id === soloFit,
      { got: row.rows[0]!.table_id, want: soloFit, notWant: bigMin }
    );
  } finally {
    await cleanup(mixed);
  }

  await pool.end();

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll solo-diner capacity checks passed.");
}

void main().catch((error) => {
  console.error("smoke-solo-diner crashed:", error);
  process.exit(1);
});
