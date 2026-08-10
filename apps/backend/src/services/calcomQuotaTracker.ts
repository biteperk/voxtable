/**
 * Cal.com API call counter + quota tracking, backed by ops_state.
 *
 * Cal.com's free tier rate limit is ~100k requests/month. At our current
 * scale (≤10 voice calls/day × ~3 Cal.com requests each = 30/day) we're
 * nowhere near it, but a runaway loop (outbox retrying a transient error
 * forever, breaker not firing) could burn it fast.
 *
 * The per-UTC-day counter lives in ops_state (`calcom-quota:YYYY-MM-DD`,
 * atomic increment), so it survives worker restarts and is readable from any
 * process — the api's /api/ops/calcom-health and the worker's alerter read
 * the same number. The old module kept an in-memory count as the authority,
 * which reset to zero on every restart and under-reported for the rest of
 * the day: precisely the runaway-loop scenario this exists to catch is the
 * one that crashes workers. Increments are best-effort — a quota write must
 * never fail a Cal.com push — so the count is a floor, not an exact ledger;
 * Cal.com's own dashboard stays the source of truth for billing.
 *
 * Day rows are purged by the cleanup worker along with the other ops_state
 * buckets.
 */

import { env } from "../config/env";
import { getOpsState, incrementOpsCounter } from "../repositories/opsState";
import { logger } from "../utils/logger";

// Cal.com free tier ≈ 100k/month — give us 80% × (100k / 30) = 2666/day as
// the default warning line. Tunable via env when ops wants tighter alarms.
const DEFAULT_DAILY_THRESHOLD = Math.floor((100_000 / 30) * 0.8);

function todayKeyUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Increment the per-day Cal.com call counter. Called from calcomClient on
 * every request (success OR failure — failed requests still consumed a
 * rate-limit slot at Cal.com's end).
 */
export function recordCalcomRequest(): void {
  void incrementOpsCounter(`calcom-quota:${todayKeyUtc()}`).catch((error) => {
    logger.warn({ evt: "calcom_quota_record_failed", error: (error as Error).message });
  });
}

export interface QuotaSnapshot {
  day_key: string;
  count: number;
  daily_threshold: number;
  above_threshold: boolean;
}

/** Today's count as ops_state knows it — every process reads the same row. */
export async function quotaSnapshotFromDb(): Promise<QuotaSnapshot> {
  const dayKey = todayKeyUtc();
  const row = await getOpsState(`calcom-quota:${dayKey}`);
  const count = Number(row?.count ?? 0);
  const threshold = env.CALCOM_DAILY_QUOTA_THRESHOLD ?? DEFAULT_DAILY_THRESHOLD;
  return {
    day_key: dayKey,
    count,
    daily_threshold: threshold,
    above_threshold: count > threshold
  };
}
