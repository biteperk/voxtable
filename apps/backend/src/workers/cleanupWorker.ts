/**
 * Daily cleanup worker — the general housekeeping janitor. Purges old rows so
 * the operational tables don't grow unbounded, and cancels stale onboardings.
 *
 *   * Outbox: rows with succeeded_at < now() - 30 days. We keep failed_at
 *     rows for ops investigation indefinitely — they're rare and small.
 *   * Inbox: rows with received_at < now() - 30 days, regardless of state.
 *     The 5-min replay window is the dedup horizon; anything older is just
 *     audit history.
 *   * Notifications: sent rows older than 30 days.
 *   * Onboarding: restaurants abandoned mid-signup for 30 days.
 *
 * Deliberately NOT cleaned up: order_payments. It is a financial ledger
 * (guest payments, fees, refunds, disputes) and is retained indefinitely.
 *
 * Runs every 6 hours after the first tick at +1 hour after boot (so a
 * fresh container doesn't spike the DB the moment it comes up). Counts are
 * structured-logged so ops can see how much the cleanup is touching.
 *
 * Always runs — every DELETE is WHERE-scoped, so it's a harmless no-op for
 * any feature that isn't in use (Cal.com sync, notifications, etc.).
 */

import { pool } from "../db/pool";
import { logger, withTickLogContext } from "../utils/logger";
import { registerTickExpectation } from "../utils/tickPulse";
import { purgeOpsStateByPrefix } from "../repositories/opsState";
import { purgeStaleKdsHeartbeats } from "../services/kdsHeartbeats";
import { purgeStaleRetellAuthBuckets } from "../services/retellAuthHealth";
import { cancelAbandonedOnboarding } from "../repositories/restaurants";

const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const INITIAL_DELAY_MS = 60 * 60 * 1000;     // 1h after boot
const RETENTION_INTERVAL_SQL = "30 days";

let intervalHandle: NodeJS.Timeout | null = null;
let firstTickTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const outbox = await pool.query<{ deleted: number }>(
      `
      WITH deleted AS (
        DELETE FROM outbox_calcom
         WHERE succeeded_at IS NOT NULL
           AND succeeded_at < now() - interval '${RETENTION_INTERVAL_SQL}'
         RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted
      `
    );
    const inbox = await pool.query<{ deleted: number }>(
      `
      WITH deleted AS (
        DELETE FROM inbox_calcom_events
         WHERE received_at < now() - interval '${RETENTION_INTERVAL_SQL}'
         RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted
      `
    );
    // Phase 5: purge old sent notifications. Guarded with its own catch so
    // this is safe before migration 012 applies.
    let notificationsDeleted = 0;
    try {
      const notif = await pool.query<{ deleted: number }>(
        `
        WITH deleted AS (
          DELETE FROM notifications_outbox
           WHERE status = 'sent' AND sent_at < now() - interval '${RETENTION_INTERVAL_SQL}'
           RETURNING 1
        )
        SELECT count(*)::int AS deleted FROM deleted
        `
      );
      notificationsDeleted = notif.rows[0]?.deleted ?? 0;
    } catch (error) {
      // Tables/columns may not exist yet on an un-migrated DB — non-fatal.
      logger.warn({ evt: "cleanup_worker_phase5_skipped", error });
    }

    // Phase 6: cancel abandoned onboardings. Isolated from phase 5 so an
    // outbox purge failure can never silently skip the sweeper.
    let abandonedCancelled = 0;
    try {
      abandonedCancelled = await cancelAbandonedOnboarding(30);
    } catch (error) {
      logger.warn({ evt: "cleanup_worker_phase6_skipped", error });
    }

    // Phase 7: ops_state hygiene (migration 028). Heartbeats and auth-failure
    // buckets only mean anything fresh; quota mirrors age out after two
    // months. Guarded like phase 5 so a pre-028 database stays harmless.
    let opsStatePurged = 0;
    try {
      opsStatePurged =
        (await purgeStaleKdsHeartbeats()) +
        (await purgeStaleRetellAuthBuckets()) +
        (await purgeOpsStateByPrefix("calcom-quota:", "60 days"));
    } catch (error) {
      logger.warn({ evt: "cleanup_worker_phase7_skipped", error });
    }

    logger.info({
      evt: "cleanup_worker_tick",
      outbox_deleted: outbox.rows[0]?.deleted ?? 0,
      inbox_deleted: inbox.rows[0]?.deleted ?? 0,
      notifications_deleted: notificationsDeleted,
      abandoned_cancelled: abandonedCancelled,
      ops_state_purged: opsStatePurged
    });
  } catch (error) {
    logger.warn({ evt: "cleanup_worker_failed", error });
  } finally {
    tickInFlight = false;
  }
}

export function startCleanupWorker(): void {
  // Always runs — it's the general daily janitor now (Cal.com outbox/inbox,
  // sent notifications, abandoned onboardings). Every DELETE is WHERE-scoped so
  // it's a harmless no-op when a given feature is unused.
  if (intervalHandle !== null) return;
  logger.info({
    evt: "cleanup_worker_starting",
    initial_delay_ms: INITIAL_DELAY_MS,
    tick_interval_ms: TICK_INTERVAL_MS,
    retention: RETENTION_INTERVAL_SQL
  });
  firstTickTimer = setTimeout(() => {
    void withTickLogContext("cleanup", () => tick());
    // Only registered once the worker genuinely starts ticking, so a
    // flag-disabled no-op is never reported as stalled.
    registerTickExpectation("cleanup", TICK_INTERVAL_MS);
    intervalHandle = setInterval(() => void withTickLogContext("cleanup", () => tick()), TICK_INTERVAL_MS);
    intervalHandle.unref();
  }, INITIAL_DELAY_MS);
  firstTickTimer.unref();
}

export async function stopCleanupWorker(): Promise<void> {
  if (firstTickTimer !== null) {
    clearTimeout(firstTickTimer);
    firstTickTimer = null;
  }
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  // No in-flight wait — DELETEs are fast and idempotent at the worst
  // case (another tick after restart re-runs the same WHERE clause).
}
