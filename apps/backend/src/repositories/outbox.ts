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
import { redactSecrets } from "../utils/logger";

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
 *
 * Audit Sweep F — enqueue-time de-dup: if a non-succeeded, non-failed row
 * already exists for `(reservation_id, op)`, return its id instead of
 * inserting a new one. Prevents retry-spam: if Retell sends the same
 * create_booking tool call twice (rare but possible), we don't queue two
 * Cal.com pushes for the same reservation. The existing row's idempotency
 * key already protects against duplicate Cal.com bookings; this just keeps
 * the outbox table clean.
 */
export async function enqueueOutbox(input: EnqueueOutboxInput, db: DbClient = pool): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `
    SELECT id FROM outbox_calcom
     WHERE reservation_id = $1
       AND op = $2
       AND succeeded_at IS NULL
       AND failed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
    `,
    [input.reservationId, input.op]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return existing.rows[0]!.id;
  }

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
     ORDER BY next_attempt_at, created_at, id
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
    [id, redactSecrets(error).slice(0, 1000), String(nextAttemptDelayMs)]
  );
}

/**
 * Reschedule a row WITHOUT consuming an attempt. Used when the row was never
 * actually pushed (circuit breaker open) — a long Cal.com outage must not
 * burn the retry budget and dead-letter bookings that were never tried.
 */
export async function markOutboxDeferred(
  id: string,
  error: string,
  nextAttemptDelayMs: number,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `
    UPDATE outbox_calcom
       SET last_error = $2,
           next_attempt_at = now() + ($3 || ' milliseconds')::interval
     WHERE id = $1
    `,
    [id, redactSecrets(error).slice(0, 1000), String(nextAttemptDelayMs)]
  );
}

/**
 * Dead-letter the row — won't be retried again until ops intervenes.
 * Error string is redacted before storage — Cal.com 4xx echoes back our
 * request body which can include the Authorization header / synthesized
 * email / phone number. We do not want those persisted in a DB column.
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
    [id, redactSecrets(error).slice(0, 1000)]
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

/**
 * The same outbox picture, scoped to one restaurant.
 *
 * `getOutboxStats` above aggregates the whole table with no tenant predicate,
 * which is correct for the platform admin console and a cross-tenant leak
 * anywhere a venue can see it: pending depth, dead letters and oldest-pending
 * are a direct read on another restaurant's booking volume and reliability.
 * outbox_calcom carries no restaurant_id of its own, so the scope has to come
 * through the reservation it mirrors.
 */
export async function getOutboxStatsForRestaurant(
  restaurantId: string,
  db: DbClient = readPool
): Promise<OutboxStats> {
  const result = await db.query<{
    pending_depth: string;
    oldest_pending_at: string | null;
    failed_last_24h: string;
    succeeded_last_1h: string;
    last_success_at: string | null;
  }>(
    `
    SELECT
      COUNT(*) FILTER (WHERE o.succeeded_at IS NULL AND o.failed_at IS NULL)::text AS pending_depth,
      -- created_at, matching the unscoped getOutboxStats above. next_attempt_at
      -- answers "when will we next try", which for any backed-off row is in the
      -- FUTURE — the dashboard would render an "oldest pending" timestamp later
      -- than now.
      MIN(o.created_at) FILTER (
        WHERE o.succeeded_at IS NULL AND o.failed_at IS NULL
      )::text AS oldest_pending_at,
      COUNT(*) FILTER (
        WHERE o.failed_at IS NOT NULL AND o.failed_at >= now() - INTERVAL '24 hours'
      )::text AS failed_last_24h,
      COUNT(*) FILTER (
        WHERE o.succeeded_at IS NOT NULL AND o.succeeded_at >= now() - INTERVAL '1 hour'
      )::text AS succeeded_last_1h,
      MAX(o.succeeded_at)::text AS last_success_at
    FROM outbox_calcom o
    -- INNER JOIN is safe only because outbox_calcom.reservation_id is
    -- ON DELETE CASCADE (migration 004), so an outbox row can never outlive its
    -- reservation. If that ever changes, this silently under-counts.
    JOIN reservations r ON r.id = o.reservation_id
    WHERE r.restaurant_id = $1
    `,
    [restaurantId]
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
