/**
 * Inbox repository — durable audit + dedup of events FROM Cal.com.
 *
 * Every Cal.com webhook hits `recordEvent` BEFORE any business logic runs.
 * The event_id (a deterministic hash from `payload.uid + triggerEvent +
 * payload.startTime`) is the primary key — duplicate hits return without side
 * effects. This gives us strong idempotency without trusting Cal.com to never
 * retry (they do, frequently).
 */

import { DbClient, pool, readPool } from "../db/pool";

export interface InboxRow {
  event_id: string;
  trigger_event: string;
  raw_payload: Record<string, unknown>;
  received_at: string;
  processed_at: string | null;
  process_error: string | null;
  attempts: number;
  failed_at: string | null;
}

export interface RecordInboxEventInput {
  eventId: string;
  triggerEvent: string;
  rawPayload: Record<string, unknown>;
}

/**
 * Persist a Cal.com webhook event. Returns `true` if newly inserted, `false`
 * if this event_id has already been seen (replay). Callers should only
 * proceed with side effects when `true` is returned.
 */
/**
 * How long the caller that just inserted a row owns the first attempt.
 *
 * This is a LEASE, not a delay. routes/cal.ts inserts the row and then processes
 * it inline, so without it the row is claimable by the retry worker the instant
 * the INSERT commits — while the inline attempt is still running. Both would
 * pass the loop guard (neither has stamped a uid yet) and both would call
 * createBooking: either two reservations for one guest, or the loser hits the
 * overlap constraint and we cancel the guest's Cal.com booking while their table
 * sits confirmed in our database.
 *
 * FOR UPDATE SKIP LOCKED only serialises worker against worker; the inline path
 * takes no row lock, so the lease is what serialises inline against worker.
 *
 * Comfortably longer than an inline attempt can take: statement_timeout is 15 s
 * and the pool's connect timeout is 5 s, so 60 s means a wedged inline attempt
 * has already died before the worker is allowed near the row.
 */
const INLINE_ATTEMPT_LEASE_MS = 60_000;

export async function recordInboxEvent(input: RecordInboxEventInput, db: DbClient = pool): Promise<boolean> {
  const result = await db.query<{ inserted: boolean }>(
    `
    INSERT INTO inbox_calcom_events (event_id, trigger_event, raw_payload, next_attempt_at)
    VALUES ($1, $2, $3::jsonb, now() + ($4::bigint || ' milliseconds')::interval)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING true AS inserted
    `,
    [input.eventId, input.triggerEvent, JSON.stringify(input.rawPayload), INLINE_ATTEMPT_LEASE_MS]
  );
  return result.rows.length > 0;
}

/**
 * Rows that are still owed a processing attempt and whose backoff has elapsed.
 *
 * Excludes dead-lettered rows (`failed_at`): those are evidence, not work.
 * Without that exclusion a permanently-failing row — an unmapped event type,
 * say — would be re-claimed every tick forever, and each attempt re-issues the
 * cancel-back call to Cal.com.
 *
 * FOR UPDATE SKIP LOCKED so two worker processes can never take the same row.
 * Ordered by due time, then received time, so an old row that has exhausted its
 * backoff does not sit behind a newer one that has not.
 */
export async function claimRetryableInbox(
  limit: number,
  db: DbClient,
  /** Test-only scope. Production passes nothing and claims everything due. */
  onlyEventIds?: string[]
): Promise<InboxRow[]> {
  const result = await db.query<InboxRow>(
    `
    SELECT event_id, trigger_event, raw_payload, received_at,
           processed_at, process_error, attempts, failed_at
      FROM inbox_calcom_events
     WHERE processed_at IS NULL
       AND failed_at IS NULL
       AND next_attempt_at <= now()
       AND ($2::text[] IS NULL OR event_id = ANY($2::text[]))
     ORDER BY next_attempt_at, received_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
    `,
    [limit, onlyEventIds ?? null]
  );
  return result.rows;
}

/**
 * The `AND failed_at IS NULL` predicate is not decoration. Two paths can hold an
 * opinion about one row (the inline attempt and the retry worker), and
 * migration 036's chk_inbox_calcom_terminal_state forbids a row being both
 * processed and dead-lettered. Without the predicate that CHECK is reachable,
 * and it throws from inside the worker's catch block — the worst place for it.
 * A dead-lettered row simply stays dead-lettered; last writer does not win.
 */
export async function markInboxProcessed(eventId: string, db: DbClient = pool): Promise<void> {
  await db.query(
    `UPDATE inbox_calcom_events
        SET processed_at = now(), process_error = NULL
      WHERE event_id = $1 AND failed_at IS NULL`,
    [eventId]
  );
}

/**
 * Record a failed attempt and schedule the next one.
 *
 * Called by BOTH the inline path in routes/cal.ts and the retry worker, so an
 * inline failure is simply attempt one — the row stays claimable and the worker
 * picks it up when its backoff elapses. It used to only stamp `process_error`,
 * which left the row unprocessed forever with nothing scheduled to look at it
 * again, and nothing at Cal.com either, because we answer 200.
 */
export async function markInboxRetry(
  eventId: string,
  error: string,
  delayMs: number,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `UPDATE inbox_calcom_events
        SET attempts = attempts + 1,
            process_error = $2,
            next_attempt_at = now() + ($3::bigint || ' milliseconds')::interval
      WHERE event_id = $1 AND processed_at IS NULL AND failed_at IS NULL`,
    [eventId, error.slice(0, 1000), Math.max(0, Math.round(delayMs))]
  );
}

/**
 * Terminal. The row keeps its payload and its last error as the durable record
 * of a booking we could not honour — cleanupWorker refuses to sweep it (#214),
 * and it drops out of both the retry claim and the unprocessed-depth alert.
 */
export async function markInboxDeadLettered(
  eventId: string,
  error: string,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `UPDATE inbox_calcom_events
        SET attempts = attempts + 1, process_error = $2, failed_at = now()
      WHERE event_id = $1 AND processed_at IS NULL`,
    [eventId, error.slice(0, 1000)]
  );
}

export interface InboxStats {
  /** Still owed work. Excludes dead letters, or the depth alert would latch. */
  unprocessedDepth: number;
  oldestUnprocessedAt: string | null;
  failuresLast24h: number;
  /** Terminal failures — a guest holds a confirmation we could not honour. */
  deadLetteredLast24h: number;
}

export async function getInboxStats(db: DbClient = readPool): Promise<InboxStats> {
  const result = await db.query<{
    unprocessed_depth: string;
    oldest_unprocessed_at: string | null;
    failures_last_24h: string;
    dead_lettered_last_24h: string;
  }>(
    `
    SELECT
      COUNT(*) FILTER (WHERE processed_at IS NULL
                       AND failed_at IS NULL)::text AS unprocessed_depth,
      MIN(received_at)
        FILTER (WHERE processed_at IS NULL
                AND failed_at IS NULL)::text AS oldest_unprocessed_at,
      COUNT(*) FILTER (WHERE process_error IS NOT NULL
                       AND received_at >= now() - INTERVAL '24 hours')::text AS failures_last_24h,
      COUNT(*) FILTER (WHERE failed_at IS NOT NULL
                       AND failed_at >= now() - INTERVAL '24 hours')::text AS dead_lettered_last_24h
    FROM inbox_calcom_events
    `
  );
  const row = result.rows[0]!;
  return {
    unprocessedDepth: Number(row.unprocessed_depth),
    oldestUnprocessedAt: row.oldest_unprocessed_at,
    failuresLast24h: Number(row.failures_last_24h),
    deadLetteredLast24h: Number(row.dead_lettered_last_24h)
  };
}
