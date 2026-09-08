/**
 * Billing recoverable-pause smoke (migration 047).
 *
 * Proves the end-to-end ladder the webhook + sweep + voice gate implement:
 *   1. A payment failure sets billing_past_due_since and does NOT suspend — the
 *      venue stays 'live' and Bella keeps booking (the 3-day grace).
 *   2. The sweep pauses only venues past the grace window; a fresh failure is
 *      left alone, a backdated one is suspended.
 *   3. A suspended venue refuses every Retell tool (Bella stops), byte-identical
 *      to the global gate — the "suspended doesn't stop Bella" bug is closed.
 *   4. Recovery (subscription active) clears the flag and reactivates
 *      suspended -> live.
 *
 * Needs only a migrated database — no HTTP server, no Stripe credentials; the
 * webhook effects are exercised through the repository helpers the handler calls.
 *
 *   npm run smoke:billing-pause
 */

import { pool } from "../src/db/pool";
import {
  clearBillingPastDueSince,
  getOnboardingStatus,
  setBillingPastDueSince,
  setOnboardingStatus,
  suspendVenuesPastDueBeyond
} from "../src/repositories/restaurants";
import { handleRetellFunction, voiceBookingDisabledResponse } from "../src/services/retellService";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_DATE,
  SMOKE_SUFFIX
} from "./lib/smoke-harness";

async function pastDueSince(id: string): Promise<Date | null> {
  const r = await pool.query<{ billing_past_due_since: Date | null }>(
    "SELECT billing_past_due_since FROM restaurants WHERE id = $1",
    [id]
  );
  return r.rows[0]?.billing_past_due_since ?? null;
}

async function main(): Promise<void> {
  const number = `+6155502${(1000 + (process.pid % 900)).toString().slice(-4)}`;
  const { restaurantId } = await createSmokeRestaurant({
    name: `Billing Venue ${SMOKE_SUFFIX}`,
    phoneNumber: number,
    tables: [{ label: "T1", minCapacity: 1, maxCapacity: 4 }]
  });

  try {
    // The venue is live and paying.
    await setOnboardingStatus(restaurantId, "live");

    // 1. A payment fails: flag set, still live.
    await setBillingPastDueSince(restaurantId);
    assert("payment failure sets the grace clock", (await pastDueSince(restaurantId)) !== null);
    assert("a first failure does NOT suspend", (await getOnboardingStatus(restaurantId)) === "live");

    const firstSet = await pastDueSince(restaurantId);
    // A second failed retry must not reset the clock (grace runs from the first).
    await setBillingPastDueSince(restaurantId);
    assert(
      "a second failure does not reset the clock",
      (await pastDueSince(restaurantId))?.getTime() === firstSet?.getTime()
    );

    // 2a. Sweep with the clock fresh: nothing suspended (within grace).
    const sweptFresh = await suspendVenuesPastDueBeyond(3);
    assert("the sweep leaves a venue still in grace alone", !sweptFresh.includes(restaurantId));
    assert("and it is still live", (await getOnboardingStatus(restaurantId)) === "live");

    // 2b. Backdate the clock beyond the window, then sweep: suspended.
    await pool.query(
      "UPDATE restaurants SET billing_past_due_since = now() - interval '4 days' WHERE id = $1",
      [restaurantId]
    );
    const swept = await suspendVenuesPastDueBeyond(3);
    assert("the sweep suspends a venue past the grace window", swept.includes(restaurantId));
    assert("the venue is now suspended", (await getOnboardingStatus(restaurantId)) === "suspended");

    // 3. Bella refuses every tool while suspended — the closed bug.
    const refusal = JSON.stringify(voiceBookingDisabledResponse());
    for (const tool of ["check_availability", "create_booking"]) {
      const res = await handleRetellFunction({
        name: tool,
        args: {
          date: SMOKE_DATE,
          time: "19:00",
          party_size: 2,
          customer_name: "Billing Smoke",
          customer_phone: "+61255550200"
        },
        call: { metadata: { restaurant_id: restaurantId } }
      });
      assert(`suspended venue refuses ${tool}`, JSON.stringify(res) === refusal);
    }
    const reservations = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM reservations WHERE restaurant_id = $1",
      [restaurantId]
    );
    assert("no reservation was written while suspended", reservations.rows[0]?.n === "0");

    // 4. Recovery: clear the flag + reactivate.
    await clearBillingPastDueSince(restaurantId);
    await setOnboardingStatus(restaurantId, "live");
    assert("recovery clears the grace clock", (await pastDueSince(restaurantId)) === null);
    assert("recovery restores live", (await getOnboardingStatus(restaurantId)) === "live");
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
  }

  reportAndExit("smoke-billing-pause");
}

void main();
