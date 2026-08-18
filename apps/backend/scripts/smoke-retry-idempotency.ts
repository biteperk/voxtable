/**
 * Retried-tool-call smoke test — proves a Retell retry cannot book twice.
 *
 * The bug this exists for: createBooking's idempotency guard keyed on
 * `input.callLogId`, which arrives from the LLM (normalizeBookingArgs reads
 * `parsed.call_log_id`). Bella has no way to know that UUID, so on a real
 * retry it was always undefined and the guard never ran. The retry then took
 * the day lock, found a DIFFERENT free table — the first booking now occupied
 * the original — and inserted a second confirmed reservation.
 *
 * `reservations_no_overlap` cannot catch that: the table_id differs, so there
 * is no overlap to reject. One caller silently held two tables, and the
 * dashboard showed only one of them because attachReservationToCallLog
 * overwrote call_logs.reservation_id.
 *
 * TWO tables are created deliberately. With one table the exclusion constraint
 * would mask the bug and this test would pass without proving anything.
 *
 * Needs only a migrated database — no HTTP server, no vendor credentials — so
 * it runs in CI against the Postgres service container.
 *
 *   npm run smoke:retry-idempotency
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

const PROVIDER = "retell";

function book(restaurantId: string, providerCallId: string) {
  // No callLogId — exactly what the Retell tool path sends. The id must be
  // resolved from providerCallId or the replay guard is dead.
  return createBooking({
    restaurantId,
    customerName: "Retry Smoke",
    customerPhone: "+61400000123",
    date: DATE,
    time: "19:00",
    partySize: 2,
    source: "voice",
    provider: PROVIDER,
    providerCallId
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
  const { restaurantId } = await createSmokeRestaurant({
    name: `smoke-retry-idempotency-${SUFFIX}`,
    phoneNumber: "+61255500001",
    open: "10:00",
    close: "23:00",
    durationMinutes: 90,
    // TWO tables that both fit the party: without the fix the retry lands on
    // the second one and commits.
    tables: [
      { label: "R1", minCapacity: 1, maxCapacity: 4 },
      { label: "R2", minCapacity: 1, maxCapacity: 4 }
    ]
  });

  try {
    // ---- Scenario 1: sequential retry, the common case ----
    const callId = `call_smoke_seq_${SUFFIX}`;
    const first = await book(restaurantId, callId);
    const retry = await book(restaurantId, callId);

    assert("sequential retry returns the SAME booking id", first.bookingId === retry.bookingId, {
      first: first.bookingId,
      retry: retry.bookingId
    });
    assert("sequential retry created no second reservation", (await activeCount(restaurantId)) === 1, {
      active: await activeCount(restaurantId)
    });

    // ---- Scenario 2: two retries racing, which only the in-lock re-check catches ----
    // The pre-lock fast path runs before the advisory lock, so both callers can
    // miss it. Only the re-check inside the lock is serialised.
    const raceRestaurant = await createSmokeRestaurant({
      name: `smoke-retry-race-${SUFFIX}`,
      phoneNumber: "+61255500002",
      open: "10:00",
      close: "23:00",
      durationMinutes: 90,
      tables: [
        { label: "C1", minCapacity: 1, maxCapacity: 4 },
        { label: "C2", minCapacity: 1, maxCapacity: 4 }
      ]
    });

    try {
      const raceCallId = `call_smoke_race_${SUFFIX}`;
      const settled = await Promise.allSettled([
        book(raceRestaurant.restaurantId, raceCallId),
        book(raceRestaurant.restaurantId, raceCallId)
      ]);
      const ids = settled
        .filter((r): r is PromiseFulfilledResult<{ bookingId: string }> => r.status === "fulfilled")
        .map((r) => r.value.bookingId);

      assert("concurrent retries produced exactly one reservation",
        (await activeCount(raceRestaurant.restaurantId)) === 1,
        { active: await activeCount(raceRestaurant.restaurantId), ids });
      assert("every concurrent caller that succeeded got the same booking id",
        new Set(ids).size <= 1, { ids });
    } finally {
      await cleanupSmokeRestaurant(raceRestaurant.restaurantId);
    }
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("smoke-retry-idempotency");
}

main().catch((error) => {
  console.error("retry-idempotency smoke crashed:", error);
  process.exit(1);
});
