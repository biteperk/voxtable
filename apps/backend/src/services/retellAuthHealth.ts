/**
 * Rolling-window counter of Retell auth failures (401/403 on any `/retell/*`
 * path), DB-backed (ops_state, migration 028).
 *
 * Why this exists: a wrong / stale / non-webhook-badged `RETELL_API_KEY`
 * makes `assertRetellSignature` reject EVERY signed Retell request with a
 * 401 in a few ms. The call still connects, the agent still talks — but every
 * tool call (check_availability, create_booking, menu_lookup, create_order)
 * bounces at the signature gate, so NO booking is ever written. This counter
 * feeds `healthAlerter` so the failure pages ops instead of silently dropping
 * bookings.
 *
 * It used to be a module-level array — written by the api process's error
 * handler, read by the alerter in the WORKER process, whose own copy of the
 * array was permanently empty. The alert this feeds could never fire.
 *
 * Shape: one ops_state row per epoch minute (`retell-auth-failures:<minute>`)
 * with an atomically incremented count. The reader sums the buckets covering
 * the window. Bucket upserts are race-free under concurrent failures, and the
 * cleanup worker purges old buckets.
 */
import { DbClient, pool, readPool } from "../db/pool";
import {
  incrementOpsCounter,
  listOpsStateByPrefix,
  purgeOpsStateByPrefix
} from "../repositories/opsState";

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const KEY_PREFIX = "retell-auth-failures:";

function minuteBucket(at: number): number {
  return Math.floor(at / 60_000);
}

/** Record one 401/403 on the signed Retell surface. */
export async function recordRetellAuthFailure(
  at: number = Date.now(),
  db: DbClient = pool
): Promise<void> {
  await incrementOpsCounter(`${KEY_PREFIX}${minuteBucket(at)}`, 1, db);
}

export interface RetellAuthSnapshot {
  failures_last_5min: number;
  last_failure_at: string | null;
  window_ms: number;
}

/** Snapshot of auth failures inside the rolling window. */
export async function retellAuthSnapshot(
  now: number = Date.now(),
  db: DbClient = readPool
): Promise<RetellAuthSnapshot> {
  const oldestBucket = minuteBucket(now - WINDOW_MS);
  const rows = await listOpsStateByPrefix(KEY_PREFIX, db);
  let failures = 0;
  let lastFailureAt: string | null = null;
  for (const row of rows) {
    const bucket = Number(row.key.slice(KEY_PREFIX.length));
    if (!Number.isFinite(bucket) || bucket < oldestBucket) continue;
    failures += Number(row.value.count ?? 0);
    if (lastFailureAt === null || row.updated_at > lastFailureAt) {
      lastFailureAt = row.updated_at;
    }
  }
  return {
    failures_last_5min: failures,
    last_failure_at: lastFailureAt,
    window_ms: WINDOW_MS
  };
}

/** Cleanup-worker hook: buckets are meaningless after the window closes. */
export async function purgeStaleRetellAuthBuckets(db: DbClient = pool): Promise<number> {
  return purgeOpsStateByPrefix(KEY_PREFIX, "1 hour", db);
}

/** Test/diagnostic helper — clears the window. */
export async function resetRetellAuthFailures(db: DbClient = pool): Promise<void> {
  await db.query("DELETE FROM ops_state WHERE key LIKE $1 || '%'", [KEY_PREFIX]);
}
