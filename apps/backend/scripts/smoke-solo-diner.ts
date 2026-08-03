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
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_DATE as DATE,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

// Deterministic per-run phone digits (Sonar S2245 flags Math.random even in
// scripts; pid-derived digits are also traceable back to a run).
let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+61255${String(10000 + ((process.pid * 10 + phoneSeq) % 90000)).padStart(5, "0")}`;
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
  const { restaurantId: strict } = await createSmokeRestaurant({
    name: `smoke-solo-strict-${SUFFIX}`,
    phoneNumber: nextPhone(),
    tables: [{ label: "T1", minCapacity: 2, maxCapacity: 4 }]
  });
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
    await cleanupSmokeRestaurant(strict);
  }

  // ---- 2: preference — the min-satisfied table wins over the under-filled -
  // The big-minimum table comes FIRST and with an earlier label so any
  // insertion-order or label-order accident would pick it — only the
  // min-satisfied ranking can choose the solo-fit table.
  const { restaurantId: mixed, tableIds } = await createSmokeRestaurant({
    name: `smoke-solo-mixed-${SUFFIX}`,
    phoneNumber: nextPhone(),
    tables: [
      { label: "A-big", minCapacity: 2, maxCapacity: 4 },
      { label: "B-solo", minCapacity: 1, maxCapacity: 2 }
    ]
  });
  const [bigMin, soloFit] = [tableIds[0]!, tableIds[1]!];
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
    await cleanupSmokeRestaurant(mixed);
  }

  await pool.end();

  reportAndExit("solo-diner capacity");
}

void main().catch((error) => {
  console.error("smoke-solo-diner crashed:", error);
  process.exit(1);
});
