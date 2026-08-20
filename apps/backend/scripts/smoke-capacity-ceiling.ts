/**
 * What a caller hears when no table can seat them.
 *
 * The bug this exists to prevent: `findAvailableTable` filters
 * `max_capacity >= party_size` as its only hard bound, and when nothing matched
 * `checkAvailability` returned ONE message for two very different situations —
 * "we're busy at that time" and "we could never seat you". A party of twelve was
 * told the requested TIME was unavailable and offered nine alternative slots,
 * none of which could ever help, because there is no table-combining anywhere in
 * the system: one party must fit one table.
 *
 * This became live rather than theoretical when Mazcina's real floor plan went
 * in — the largest table dropped from 8 seats to 6, so a party of 8 at a venue
 * that sells $74-79 sharing boards is a plausible first phone call.
 *
 * Needs only a migrated database — no HTTP server, no Retell credentials.
 *
 *   npm run smoke:capacity-ceiling
 */
import { pool } from "../src/db/pool";
import { checkAvailability } from "../src/services/availabilityService";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_DATE,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

async function main(): Promise<void> {
  // Mirrors Mazcina's shape in miniature: a small table and a six-top ceiling.
  const { restaurantId } = await createSmokeRestaurant({
    name: `Capacity Smoke ${SUFFIX}`,
    phoneNumber: `+6129006${String(process.pid % 10000).padStart(4, "0")}`,
    tables: [
      { label: "C1", minCapacity: 1, maxCapacity: 2 },
      { label: "C2", minCapacity: 4, maxCapacity: 6 }
    ]
  });

  // A venue with no tables at all — a misconfiguration, not a party-size
  // problem, and it must not produce "our largest table seats null".
  const { restaurantId: emptyVenue } = await createSmokeRestaurant({
    name: `Capacity Smoke Empty ${SUFFIX}`,
    phoneNumber: `+6129005${String(process.pid % 10000).padStart(4, "0")}`,
    tables: []
  });

  try {
    const fits = await checkAvailability({
      restaurantId,
      date: SMOKE_DATE,
      time: "19:00",
      partySize: 6
    });
    assert("a party that fits the largest table is offered it", fits.available, {
      reason: fits.reason,
      table: fits.tableLabel
    });
    assert("...and is reported as available", fits.reason === "available", { reason: fits.reason });

    const tooBig = await checkAvailability({
      restaurantId,
      date: SMOKE_DATE,
      time: "19:00",
      partySize: 8
    });
    assert("a party larger than every table is refused", !tooBig.available, tooBig);
    // THE assertion. Before the fix this was "no_availability" and the caller
    // was invited to try a different time.
    assert(
      "...and the reason is the party size, not the time",
      tooBig.reason === "party_too_large",
      { reason: tooBig.reason, message: tooBig.message }
    );
    assert(
      "...and the caller is told the real ceiling, not blamed on the clock",
      /largest table seats 6/.test(tooBig.message) && !/near the requested time/.test(tooBig.message),
      { message: tooBig.message }
    );
    assert(
      "...and is offered a callback rather than a slot",
      tooBig.suggestedTime === null && tooBig.naturalAlternativesMessage === null,
      { suggestedTime: tooBig.suggestedTime, alternatives: tooBig.naturalAlternativesMessage }
    );

    // A closed day is a third answer, not a variant of "we're full". Quoting a
    // table ceiling to someone asking about a day the venue is shut would be a
    // non-sequitur, so closed is checked before capacity.
    const closedDay = await checkAvailability({
      restaurantId,
      date: SMOKE_DATE,
      time: "04:00", // outside any plausible opening hours, and ±2h stays outside
      partySize: 8 // deliberately also too large: closed must win
    });
    assert("a closed time is reported as closed, not as a capacity problem", closedDay.reason === "closed", {
      reason: closedDay.reason,
      message: closedDay.message
    });
    assert(
      "...and says so, rather than blaming tables or the clock",
      /closed/i.test(closedDay.message) && !/largest table/.test(closedDay.message),
      { message: closedDay.message }
    );

    const noTables = await checkAvailability({
      restaurantId: emptyVenue,
      date: SMOKE_DATE,
      time: "19:00",
      partySize: 2
    });
    assert(
      "a venue with no active tables falls back to the generic message",
      noTables.reason === "no_availability" && !/null/.test(noTables.message),
      { reason: noTables.reason, message: noTables.message }
    );
  } finally {
    await cleanupSmokeRestaurant(restaurantId);
    await cleanupSmokeRestaurant(emptyVenue);
    await pool.end();
  }

  reportAndExit("capacity-ceiling");
}

main().catch(async (error) => {
  console.error("smoke-capacity-ceiling crashed:", error);
  process.exit(1);
});
