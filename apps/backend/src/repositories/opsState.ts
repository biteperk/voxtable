/**
 * Cross-process ops state (migration 028).
 *
 * The api and the worker are separate processes, so module-level Maps and
 * counters exist twice. Everything here is state one process WRITES and the
 * other READS: KDS heartbeats (api → alerter), the Retell auth-failure window
 * (api → alerter), the Cal.com breaker/quota mirror (worker → ops endpoint),
 * and the alerter's own edge-trigger latches (worker → its restarted self,
 * so a redeploy doesn't re-page every open alert).
 *
 * Deliberately a keyed JSONB row per fact, not a schema per fact — this is
 * observability plumbing, and the write rates are tiny (a heartbeat per
 * tablet per minute, a row per Cal.com request, a row per auth failure).
 */
import { DbClient, pool, readPool } from "../db/pool";

export async function getOpsState(
  key: string,
  db: DbClient = readPool
): Promise<Record<string, unknown> | null> {
  const result = await db.query<{ value: Record<string, unknown> }>(
    "SELECT value FROM ops_state WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? null;
}

export async function setOpsState(
  key: string,
  value: Record<string, unknown>,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `INSERT INTO ops_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

/** Atomically add `by` to value.count — for bucket counters. */
export async function incrementOpsCounter(
  key: string,
  by = 1,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `INSERT INTO ops_state (key, value, updated_at)
     VALUES ($1, jsonb_build_object('count', $2::int), now())
     ON CONFLICT (key) DO UPDATE
       SET value = jsonb_set(
             ops_state.value,
             '{count}',
             to_jsonb(COALESCE((ops_state.value->>'count')::int, 0) + $2::int)
           ),
           updated_at = now()`,
    [key, by]
  );
}

export interface OpsStateRow {
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
}

export async function listOpsStateByPrefix(
  prefix: string,
  db: DbClient = readPool
): Promise<OpsStateRow[]> {
  const result = await db.query<OpsStateRow>(
    `SELECT key, value, updated_at::text FROM ops_state
      WHERE key LIKE $1 || '%'
      ORDER BY key`,
    [prefix]
  );
  return result.rows;
}

/**
 * Purge rows under a prefix whose last update is older than `olderThan`.
 * Called by the cleanup worker — heartbeats and failure buckets are only
 * meaningful fresh, and nothing should accumulate here.
 */
export async function purgeOpsStateByPrefix(
  prefix: string,
  olderThan: string,
  db: DbClient = pool
): Promise<number> {
  const result = await db.query(
    `DELETE FROM ops_state
      WHERE key LIKE $1 || '%'
        AND updated_at < now() - $2::interval`,
    [prefix, olderThan]
  );
  return result.rowCount ?? 0;
}
