/**
 * KDS tablet heartbeats, DB-backed (ops_state, migration 028).
 *
 * This lived as a module-level Map inside routes/orders.ts — written by the
 * api process's heartbeat endpoint, read by the health alerter in the WORKER
 * process, which imported the routes module and got its own permanently empty
 * Map. The "no kitchen tablet heartbeat" alert was written for a real
 * incident and could never fire. Postgres is the only memory both processes
 * share.
 *
 * The old map's two hardening properties are preserved:
 *   - tenant-scoped keys (two venues naming a tablet "kitchen-1" don't mask
 *     each other's outage);
 *   - bounded growth: tablet ids are length-capped by the route, rows are
 *     per (restaurant, tablet) so repeats overwrite, stale rows are filtered
 *     on read and purged by the cleanup worker.
 */
import { DbClient, pool, readPool } from "../db/pool";
import {
  listOpsStateByPrefix,
  purgeOpsStateByPrefix,
  setOpsState
} from "../repositories/opsState";

export const KDS_HEARTBEAT_TTL_MS = 15 * 60 * 1000;
const KEY_PREFIX = "kds-heartbeat:";

export interface KdsHeartbeat {
  tablet_id: string;
  last_seen_ms_ago: number;
}

export async function recordKdsHeartbeat(
  restaurantId: string,
  tabletId: string,
  now: number = Date.now(),
  db: DbClient = pool
): Promise<void> {
  await setOpsState(`${KEY_PREFIX}${restaurantId}:${tabletId}`, { at: now }, db);
}

export async function getKdsHeartbeats(
  restaurantId: string,
  now: number = Date.now(),
  db: DbClient = readPool
): Promise<KdsHeartbeat[]> {
  const rows = await listOpsStateByPrefix(`${KEY_PREFIX}${restaurantId}:`, db);
  const cutoff = now - KDS_HEARTBEAT_TTL_MS;
  return rows
    .filter((row) => typeof row.value.at === "number" && (row.value.at as number) >= cutoff)
    .map((row) => ({
      tablet_id: row.key.slice(`${KEY_PREFIX}${restaurantId}:`.length),
      last_seen_ms_ago: now - (row.value.at as number)
    }));
}

/** Cleanup-worker hook: drop heartbeats no one has refreshed in a day. */
export async function purgeStaleKdsHeartbeats(db: DbClient = pool): Promise<number> {
  return purgeOpsStateByPrefix(KEY_PREFIX, "1 day", db);
}
