/**
 * In-memory Cal.com API call counter + quota tracking.
 *
 * Cal.com's free tier rate limit is ~100k requests/month. At our current
 * scale (≤10 voice calls/day × ~3 Cal.com requests each = 30/day) we're
 * nowhere near it, but a runaway loop (outbox retrying a transient error
 * forever, breaker not firing) could burn it fast. This module gives us:
 *
 *   1. Per-day rolling counter. `recordCalcomRequest()` is called from
 *      calcomClient after every request. Window auto-rolls at UTC midnight.
 *   2. Threshold check. `quotaSnapshot().above_threshold` is true once we've
 *      crossed the warning line (CALCOM_DAILY_QUOTA_THRESHOLD env, or 80% of
 *      the ~3333/day free-tier limit ≈ 2666 if unset).
 *   3. Snapshot for ops endpoint. `quotaSnapshot()` returns today's count +
 *      threshold + threshold state.
 *
 * In-process only. Survives a container restart for the current UTC day if
 * the restart is fast enough that no calls happen in between, otherwise the
 * counter resets — that's fine because Cal.com's own dashboard is the
 * source of truth for billing.
 */

import { env } from "../config/env";
import { getOpsState, incrementOpsCounter } from "../repositories/opsState";
import { logger } from "../utils/logger";

// Cal.com free tier ≈ 100k/month — give us 80% × (100k / 30) = 2666/day as
// the default warning line. Tunable via env when ops wants tighter alarms.
const DEFAULT_DAILY_THRESHOLD = Math.floor((100_000 / 30) * 0.8);

interface QuotaState {
  dayKey: string;       // "YYYY-MM-DD" UTC
  count: number;
  startedAt: string;    // ISO
}

let state: QuotaState = newState();

function newState(): QuotaState {
  const now = new Date();
  return {
    dayKey: now.toISOString().slice(0, 10),
    count: 0,
    startedAt: now.toISOString()
  };
}

function ensureCurrentWindow(): void {
  const todayKey = new Date().toISOString().slice(0, 10);
  if (state.dayKey !== todayKey) {
    state = newState();
  }
}

/**
 * Increment the per-day Cal.com call counter. Called from calcomClient on
 * every request (success OR failure — failed requests still consumed a
 * rate-limit slot at Cal.com's end).
 */
export function recordCalcomRequest(): void {
  ensureCurrentWindow();
  state.count += 1;
  // Mirror into ops_state so /api/ops/calcom-health (API process) can report
  // the real count instead of its own permanently-zero module instance.
  // Best-effort: the in-worker counter stays authoritative for the alerter,
  // and a quota mirror must never fail a Cal.com push.
  void incrementOpsCounter(`calcom-quota:${state.dayKey}`).catch((error) => {
    logger.warn({ evt: "calcom_quota_mirror_failed", error: (error as Error).message });
  });
}

/**
 * DB-backed snapshot for processes that do NOT drive the Cal.com client
 * (the API's ops endpoint). Reads today's mirrored counter; the in-process
 * `quotaSnapshot()` remains the authority inside the worker.
 */
export async function quotaSnapshotFromDb(): Promise<{
  day_key: string;
  count: number;
  daily_threshold: number;
  above_threshold: boolean;
}> {
  const dayKey = new Date().toISOString().slice(0, 10);
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

export function quotaSnapshot(): {
  day_key: string;
  count: number;
  window_started_at: string;
  daily_threshold: number;
  above_threshold: boolean;
} {
  ensureCurrentWindow();
  const threshold = env.CALCOM_DAILY_QUOTA_THRESHOLD ?? DEFAULT_DAILY_THRESHOLD;
  return {
    day_key: state.dayKey,
    count: state.count,
    window_started_at: state.startedAt,
    daily_threshold: threshold,
    above_threshold: state.count > threshold
  };
}

/**
 * Convenience for the health alerter. True iff today's count has crossed
 * the configured threshold AND we haven't already alerted for this UTC day.
 * Edge-triggered to keep Slack quiet.
 */
let lastAlertedDayKey: string | null = null;

export function shouldFireQuotaAlert(): boolean {
  const snap = quotaSnapshot();
  if (!snap.above_threshold) {
    // Recovery — clear the alert latch so next breach fires.
    if (lastAlertedDayKey !== null && lastAlertedDayKey !== snap.day_key) {
      lastAlertedDayKey = null;
    }
    return false;
  }
  if (lastAlertedDayKey === snap.day_key) return false;
  lastAlertedDayKey = snap.day_key;
  return true;
}
