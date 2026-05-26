/**
 * Daily cleanup worker — purges old outbox + inbox rows so the tables don't
 * grow unbounded.
 *
 *   * Outbox: rows with succeeded_at < now() - 30 days. We keep failed_at
 *     rows for ops investigation indefinitely — they're rare and small.
 *   * Inbox: rows with received_at < now() - 30 days, regardless of state.
 *     The 5-min replay window is the dedup horizon; anything older is just
 *     audit history.
 *
 * Runs every 6 hours after the first tick at +1 hour after boot (so a
 * fresh container doesn't spike the DB the moment it comes up). Counts are
 * structured-logged so ops can see how much the cleanup is touching.
 *
 * Skipped entirely when CALCOM_SYNC_ENABLED=false (nothing to clean up).
 */

import { env } from "../config/env";
import { pool } from "../db/pool";
import { logger } from "../utils/logger";

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
    logger.info({
      evt: "cleanup_worker_tick",
      outbox_deleted: outbox.rows[0]?.deleted ?? 0,
      inbox_deleted: inbox.rows[0]?.deleted ?? 0
    });
  } catch (error) {
    logger.warn({ evt: "cleanup_worker_failed", error });
  } finally {
    tickInFlight = false;
  }
}

export function startCleanupWorker(): void {
  if (!env.CALCOM_SYNC_ENABLED) {
    logger.info({ evt: "cleanup_worker_disabled", reason: "calcom_sync_off" });
    return;
  }
  if (intervalHandle !== null) return;
  logger.info({
    evt: "cleanup_worker_starting",
    initial_delay_ms: INITIAL_DELAY_MS,
    tick_interval_ms: TICK_INTERVAL_MS,
    retention: RETENTION_INTERVAL_SQL
  });
  firstTickTimer = setTimeout(() => {
    void tick();
    intervalHandle = setInterval(() => void tick(), TICK_INTERVAL_MS);
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
