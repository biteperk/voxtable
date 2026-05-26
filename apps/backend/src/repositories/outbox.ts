/**
 * Outbox repository — durable queue of pushes TO Cal.com.
 *
 * The contract:
 *   - `enqueue` is called INSIDE the same transaction that creates/updates a
 *     reservation. Atomicity guarantees we never lose a row to push.
 *   - `claimReady` is used by the outbox worker (PR 2) to pull due rows with
 *     `FOR UPDATE SKIP LOCKED` so multiple workers (future) can drain safely.
 *   - `mark*` functions are called by the worker after each Cal.com call to
 *     record terminal state or schedule a retry.
 *
 * Backoff math lives in the worker, not here — this layer is pure storage.
 */

import { DbClient, pool, readPool } from "../db/pool";

export type OutboxOp = "create" | "cancel" | "reschedule";

export interface OutboxRow {
  id: string;
  reservation_id: string;
  op: OutboxOp;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  succeeded_at: string | null;
  failed_at: string | null;
  created_at: string;
}

export interface EnqueueOutboxInput {
  reservationId: string;
  op: OutboxOp;
  payload: Record<string, unknown>;
}

/**
 * Insert a new outbox row. MUST be called with a DbClient bound to the same
 * transaction that mutates the reservation — atomicity is the whole point of
 * the outbox pattern.
 */
export async function enqueueOutbox(input: EnqueueOutboxInput, db: DbClient = pool): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
    INSERT INTO outbox_calcom (reservation_id, op, payload)
    VALUES ($1, $2, $3::jsonb)
    RETURNING id
    `,
    [input.reservationId, input.op, JSON.stringify(input.payload)]
  );
  return result.rows[0]!.id;
}

/**
 * Pull up to `limit` rows that are due for processing, locking them so no
 * other worker pulls the same row. The caller MUST be inside a transaction
 * (otherwise SKIP LOCKED has no scope to skip within).
 */
export async function claimReadyOutbox(limit: number, db: DbClient): Promise<OutboxRow[]> {
  const result = await db.query<OutboxRow>(
    `
    SELECT id, reservation_id, op, payload, attempts, last_error,
           next_attempt_at, succeeded_at, failed_at, created_at
      FROM outbox_calcom
     WHERE succeeded_at IS NULL
       AND failed_at IS NULL
       AND next_attempt_at <= now()
     ORDER BY next_attempt_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
    `,
    [limit]
  );
  return result.rows;
}

export async function markOutboxSucceeded(id: string, db: DbClient = pool): Promise<void> {
  await db.query("UPDATE outbox_calcom SET succeeded_at = now(), last_error = NULL WHERE id = $1", [id]);
}

/**
 * Record a transient failure and schedule the next attempt. Callers compute
 * the backoff so the policy stays in one place (the worker).
 */
export async function markOutboxRetry(
  id: string,
  error: string,
  nextAttemptDelayMs: number,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `
    UPDATE outbox_calcom
       SET attempts = attempts + 1,
           last_error = $2,
           next_attempt_at = now() + ($3 || ' milliseconds')::interval
     WHERE id = $1
    `,
    [id, error.slice(0, 1000), String(nextAttemptDelayMs)]
  );
}

/**
 * Dead-letter the row — won't be retried again until ops intervenes.
 */
export async function markOutboxFailed(id: string, error: string, db: DbClient = pool): Promise<void> {
  await db.query(
    `
    UPDATE outbox_calcom
       SET attempts = attempts + 1,
           last_error = $2,
           failed_at = now()
     WHERE id = $1
    `,
    [id, error.slice(0, 1000)]
  );
}

export interface OutboxStats {
  pendingDepth: number;
  oldestPendingAt: string | null;
  failedLast24h: number;
  succeededLast1h: number;
  lastSuccessAt: string | null;
}

/**
 * Health-snapshot for the ops dashboard. Reads only — uses readPool so it
 * never starves the write path.
 */
export async function getOutboxStats(db: DbClient = readPool): Promise<OutboxStats> {
  const result = await db.query<{
    pending_depth: string;
    oldest_pending_at: string | null;
    failed_last_24h: string;
    succeeded_last_1h: string;
    last_success_at: string | null;
  }>(
    `
    SELECT
      COUNT(*) FILTER (WHERE succeeded_at IS NULL AND failed_at IS NULL)::text AS pending_depth,
      MIN(created_at)
        FILTER (WHERE succeeded_at IS NULL AND failed_at IS NULL)::text AS oldest_pending_at,
      COUNT(*) FILTER (WHERE failed_at >= now() - INTERVAL '24 hours')::text AS failed_last_24h,
      COUNT(*) FILTER (WHERE succeeded_at >= now() - INTERVAL '1 hour')::text AS succeeded_last_1h,
      MAX(succeeded_at)::text AS last_success_at
    FROM outbox_calcom
    `
  );
  const row = result.rows[0]!;
  return {
    pendingDepth: Number(row.pending_depth),
    oldestPendingAt: row.oldest_pending_at,
    failedLast24h: Number(row.failed_last_24h),
    succeededLast1h: Number(row.succeeded_last_1h),
    lastSuccessAt: row.last_success_at
  };
}
