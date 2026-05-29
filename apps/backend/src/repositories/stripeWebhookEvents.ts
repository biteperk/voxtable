import { DbClient, pool } from "../db/pool";

/**
 * Idempotency inbox for Stripe webhooks. recordEvent inserts the event id; if
 * it already exists (a Stripe retry), it returns false so the caller skips
 * reprocessing. markProcessed/markFailed close the loop.
 */

export async function recordWebhookEvent(
  eventId: string,
  type: string,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query<{ event_id: string }>(
    `INSERT INTO stripe_webhook_events (event_id, type)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, type]
  );
  return result.rows.length > 0; // true = newly inserted (process it)
}

export async function isWebhookProcessed(eventId: string, db: DbClient = pool): Promise<boolean> {
  const result = await db.query<{ processed_at: string | null }>(
    "SELECT processed_at FROM stripe_webhook_events WHERE event_id = $1",
    [eventId]
  );
  return Boolean(result.rows[0]?.processed_at);
}

export async function markWebhookProcessed(eventId: string, db: DbClient = pool): Promise<void> {
  await db.query(
    "UPDATE stripe_webhook_events SET processed_at = now(), process_error = NULL WHERE event_id = $1",
    [eventId]
  );
}

export async function markWebhookFailed(
  eventId: string,
  error: string,
  db: DbClient = pool
): Promise<void> {
  await db.query("UPDATE stripe_webhook_events SET process_error = $2 WHERE event_id = $1", [
    eventId,
    error.slice(0, 500)
  ]);
}
