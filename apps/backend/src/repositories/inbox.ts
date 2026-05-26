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
export async function recordInboxEvent(input: RecordInboxEventInput, db: DbClient = pool): Promise<boolean> {
  const result = await db.query<{ inserted: boolean }>(
    `
    INSERT INTO inbox_calcom_events (event_id, trigger_event, raw_payload)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING true AS inserted
    `,
    [input.eventId, input.triggerEvent, JSON.stringify(input.rawPayload)]
  );
  return result.rows.length > 0;
}

/**
 * Used by the inbox worker (PR 2) to pull events that haven't been processed.
 * No locking primitive needed here because the worker pulls by `processed_at
 * IS NULL` and writes to it inside its own transaction — see Postgres's
 * default row-locking semantics in SELECT FOR UPDATE.
 */
export async function claimUnprocessedInbox(limit: number, db: DbClient): Promise<InboxRow[]> {
  const result = await db.query<InboxRow>(
    `
    SELECT event_id, trigger_event, raw_payload, received_at,
           processed_at, process_error
      FROM inbox_calcom_events
     WHERE processed_at IS NULL
     ORDER BY received_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
    `,
    [limit]
  );
  return result.rows;
}

export async function markInboxProcessed(eventId: string, db: DbClient = pool): Promise<void> {
  await db.query(
    "UPDATE inbox_calcom_events SET processed_at = now(), process_error = NULL WHERE event_id = $1",
    [eventId]
  );
}

export async function markInboxFailed(eventId: string, error: string, db: DbClient = pool): Promise<void> {
  await db.query(
    "UPDATE inbox_calcom_events SET process_error = $2 WHERE event_id = $1",
    [eventId, error.slice(0, 1000)]
  );
}

export interface InboxStats {
  unprocessedDepth: number;
  oldestUnprocessedAt: string | null;
  failuresLast24h: number;
}

export async function getInboxStats(db: DbClient = readPool): Promise<InboxStats> {
  const result = await db.query<{
    unprocessed_depth: string;
    oldest_unprocessed_at: string | null;
    failures_last_24h: string;
  }>(
    `
    SELECT
      COUNT(*) FILTER (WHERE processed_at IS NULL)::text AS unprocessed_depth,
      MIN(received_at)
        FILTER (WHERE processed_at IS NULL)::text AS oldest_unprocessed_at,
      COUNT(*) FILTER (WHERE process_error IS NOT NULL
                       AND received_at >= now() - INTERVAL '24 hours')::text AS failures_last_24h
    FROM inbox_calcom_events
    `
  );
  const row = result.rows[0]!;
  return {
    unprocessedDepth: Number(row.unprocessed_depth),
    oldestUnprocessedAt: row.oldest_unprocessed_at,
    failuresLast24h: Number(row.failures_last_24h)
  };
}
