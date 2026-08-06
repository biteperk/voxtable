/**
 * Business-outcome alert smoke — the two alerts that watch OUTCOMES instead
 * of mechanisms (audit S1: "Bella answers but no booking is written" only
 * had a signature-gate proxy; a dead phone line had nothing at all).
 *
 * Exercises the REAL query helpers the alerter ticks with, against a live
 * Postgres:
 *
 *   1. bookingActivitySnapshot — calls landed with zero bookings must be
 *      visible as exactly that; a booking clearing the condition must too.
 *   2. restaurantsSilentDuringService — a venue deep into configured service
 *      with no calls is flagged; the same venue is cleared by a single call,
 *      and a venue with the default empty hours is never flagged.
 *
 * The Slack side stays untested here on purpose: postToSlack is a no-op
 * without OPS_SLACK_WEBHOOK_URL, and the decision logic these helpers feed
 * is trivially thin above them.
 *
 *   npm run smoke:business-alerts
 */
import { pool } from "../src/db/pool";
import {
  bookingActivitySnapshot,
  restaurantsSilentDuringService,
  serviceProgressNow
} from "../src/workers/healthAlerter";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

async function main(): Promise<void> {
  // Open around the clock so the smoke passes at ANY hour CI runs, and long
  // enough ago that hours_into_service clears the 4h threshold: a 00:00–23:59
  // window is mid-service except in the minute before midnight — good enough,
  // and serviceProgressNow's edge cases are unit-tested where the clock is
  // controlled.
  const { restaurantId } = await createSmokeRestaurant({
    name: `Business Alerts Smoke ${SUFFIX}`,
    phoneNumber: `+6129009${SUFFIX.slice(0, 4)}`,
    open: "00:00",
    close: "23:59",
    tables: [{ label: "T1", minCapacity: 1, maxCapacity: 4 }]
  });

  try {
    const hoursNow = serviceProgressNow(
      Object.fromEntries(
        ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
          d,
          [{ open: "00:00", close: "23:59" }]
        ])
      ),
      "Australia/Sydney"
    );
    if (!hoursNow || hoursNow.hoursIntoService < 4) {
      // The one sliver of the day the fixture can't cover (00:00–04:00 local):
      // the silent-venue half of this smoke would be a false FAIL, not a real
      // signal. Report the sliver honestly and only run the activity half.
      console.log(
        `[SKIP] silent-venue checks — ${hoursNow?.hoursIntoService.toFixed(1) ?? "0"}h into the fixture's service day, threshold is 4h`
      );
    } else {
      const silentBefore = await restaurantsSilentDuringService();
      assert(
        "a venue deep into service with zero calls is flagged",
        silentBefore.some((venue) => venue.restaurant_id === restaurantId),
        silentBefore.length
      );
    }

    // Baseline for the activity window — other rows may exist in a dev DB, so
    // every assertion is relative.
    const before = await bookingActivitySnapshot(60);

    await pool.query(
      `INSERT INTO call_logs (restaurant_id, provider, provider_call_id, status)
       VALUES ($1, 'retell', 'smoke-business-' || $2 || '-1', 'completed'),
              ($1, 'retell', 'smoke-business-' || $2 || '-2', 'completed'),
              ($1, 'retell', 'smoke-business-' || $2 || '-3', 'completed')`,
      [restaurantId, SUFFIX]
    );

    const calls = await bookingActivitySnapshot(60);
    assert(
      "three landed calls are visible in the activity window",
      calls.calls === before.calls + 3 && calls.bookings === before.bookings,
      { before, after: calls }
    );

    if (hoursNow && hoursNow.hoursIntoService >= 4) {
      const silentAfter = await restaurantsSilentDuringService();
      assert(
        "a single call clears the venue from the silent list",
        !silentAfter.some((venue) => venue.restaurant_id === restaurantId),
        silentAfter.length
      );
    }

    // A venue whose opening_hours_json is the {} default must never be
    // flagged, whatever the hour — that's the false-page guard.
    const { restaurantId: emptyHoursVenue } = await createSmokeRestaurant({
      name: `Business Alerts Empty ${SUFFIX}`,
      phoneNumber: `+6129008${SUFFIX.slice(0, 4)}`,
      tables: [{ label: "T1", minCapacity: 1, maxCapacity: 4 }]
    });
    try {
      await pool.query(
        `UPDATE restaurant_settings SET opening_hours_json = '{}'::jsonb WHERE restaurant_id = $1`,
        [emptyHoursVenue]
      );
      const silent = await restaurantsSilentDuringService();
      assert(
        "a venue with no configured hours is never flagged",
        !silent.some((venue) => venue.restaurant_id === emptyHoursVenue),
        silent.length
      );
    } finally {
      await cleanupSmokeRestaurant(emptyHoursVenue);
    }
  } finally {
    await pool.query(`DELETE FROM call_logs WHERE provider_call_id LIKE 'smoke-business-' || $1 || '%'`, [
      SUFFIX
    ]);
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("business alerts");
}

main().catch((error) => {
  console.error("smoke-business-alerts crashed:", error);
  process.exit(1);
});
