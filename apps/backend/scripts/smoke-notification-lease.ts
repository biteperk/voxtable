/**
 * Notification-outbox lease smoke — a claimed row must never be claimable
 * twice while its send is in flight.
 *
 * The old claim bumped `attempts` and nothing else: FOR UPDATE SKIP LOCKED
 * only guards rows while the claiming statement runs, and the statement
 * autocommits — so the instant a claim returned, the same row matched the
 * ready predicate again. The actual SendGrid/Twilio send happens after the
 * claim, outside any transaction, which means a second worker replica (or a
 * send outliving one tick interval) would send the same email or SMS twice.
 * The only thing preventing that in production was having exactly one worker
 * replica with an in-process tick guard.
 *
 * The fix leases the row on claim (`next_attempt_at = now() + 5 minutes`).
 * This smoke races two concurrent claimers and then a third late claimer
 * against the REAL repository on a live Postgres and pins:
 *   1. no row is ever handed to two claimers,
 *   2. every seeded row is handed out exactly once,
 *   3. a claimed row carries a future next_attempt_at (the lease) and its
 *      attempts bump — so a crash mid-send retries later instead of never.
 *
 * Needs only a migrated database — no HTTP server, no vendor credentials.
 *
 *   npm run smoke:notification-lease
 */
import { pool } from "../src/db/pool";
import { claimReadyNotifications, enqueueNotification } from "../src/repositories/notifications";
import { assert, reportAndExit, SMOKE_SUFFIX as SUFFIX } from "./lib/smoke-harness";

const RECIPIENT = `lease-smoke-${SUFFIX}@local.test`;
const SEEDED = 10;

async function main(): Promise<void> {
  try {
    await pool.query(`DELETE FROM notifications_outbox WHERE recipient = $1`, [RECIPIENT]);

    for (let i = 0; i < SEEDED; i += 1) {
      await enqueueNotification({
        channel: "email",
        recipient: RECIPIENT,
        kind: "lease_smoke",
        subject: `lease smoke ${i}`,
        body: `row ${i}`
      });
    }

    // Two claimers racing on separate connections — the exact shape of a
    // second worker replica. A third claimer afterwards models the next tick
    // firing while every send is still in flight.
    const [first, second] = await Promise.all([
      claimReadyNotifications(6, ["email", "sms"]),
      claimReadyNotifications(6, ["email", "sms"])
    ]);
    const third = await claimReadyNotifications(50, ["email", "sms"]);

    const allClaimedIds = [...first, ...second, ...third].map((row) => row.id);
    assert(
      "no row was handed to two claimers",
      new Set(allClaimedIds).size === allClaimedIds.length,
      { first: first.length, second: second.length, third: third.length }
    );

    const mineClaimed = [...first, ...second, ...third].filter(
      (row) => row.recipient === RECIPIENT
    );
    assert(
      `every seeded row was handed out exactly once (${SEEDED})`,
      mineClaimed.length === SEEDED,
      { claimed: mineClaimed.length }
    );

    const state = await pool.query<{ leased: boolean; attempts: number }>(
      `SELECT next_attempt_at > now() AS leased, attempts
       FROM notifications_outbox WHERE recipient = $1`,
      [RECIPIENT]
    );
    assert(
      "every claimed row carries a future lease",
      state.rows.length === SEEDED && state.rows.every((row) => row.leased),
      state.rows.filter((row) => !row.leased).length
    );
    assert(
      "every claimed row recorded its attempt",
      state.rows.every((row) => row.attempts === 1),
      state.rows.map((row) => row.attempts)
    );
  } finally {
    await pool.query(`DELETE FROM notifications_outbox WHERE recipient = $1`, [RECIPIENT]);
    await pool.end();
  }

  reportAndExit("notification lease");
}

main().catch((error) => {
  console.error("smoke-notification-lease crashed:", error);
  process.exit(1);
});
