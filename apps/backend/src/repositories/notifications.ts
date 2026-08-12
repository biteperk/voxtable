import { DbClient, pool } from "../db/pool";

export interface NotificationRow {
  id: string;
  restaurant_id: string | null;
  channel: "email" | "sms";
  recipient: string;
  kind: string;
  subject: string | null;
  body: string;
  body_html: string | null;
  status: "pending" | "sent" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export async function enqueueNotification(
  input: {
    restaurantId?: string | null;
    channel: "email" | "sms";
    recipient: string;
    kind: string;
    subject?: string | null;
    body: string;
    bodyHtml?: string | null;
  },
  db: DbClient = pool
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO notifications_outbox (restaurant_id, channel, recipient, kind, subject, body, body_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.restaurantId ?? null,
      input.channel,
      input.recipient,
      input.kind,
      input.subject ?? null,
      input.body,
      input.bodyHtml ?? null
    ]
  );
  return result.rows[0]!.id;
}

export async function claimReadyNotifications(
  limit: number,
  channels: Array<"email" | "sms">,
  db: DbClient = pool
): Promise<NotificationRow[]> {
  if (channels.length === 0) return [];
  // Pushing next_attempt_at forward IS the claim lease: the row stops matching
  // the ready predicate the moment this UPDATE commits, so a second worker
  // replica (or a send outliving the tick interval) cannot claim it again and
  // double-send. FOR UPDATE SKIP LOCKED alone never provided that — the row
  // lock dies with this autocommitted statement, while the actual send happens
  // afterwards, outside any transaction. If the process crashes mid-send, the
  // row simply becomes claimable again when the lease expires (at-least-once,
  // same guarantee as before); markNotificationSent/Retry/Failed all overwrite
  // the lease with their own terminal or scheduled state.
  const result = await db.query<NotificationRow>(
    `
    UPDATE notifications_outbox
    SET attempts = attempts + 1,
        next_attempt_at = now() + interval '5 minutes'
    WHERE id IN (
      SELECT id FROM notifications_outbox
      WHERE status = 'pending' AND next_attempt_at <= now() AND channel = ANY($2)
      ORDER BY next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    RETURNING *
    `,
    [limit, channels]
  );
  return result.rows;
}

export async function markNotificationSent(id: string): Promise<void> {
  await pool.query(
    "UPDATE notifications_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1",
    [id]
  );
}

export async function markNotificationRetry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
  await pool.query(
    "UPDATE notifications_outbox SET status = 'pending', next_attempt_at = $2, last_error = $3 WHERE id = $1",
    [id, nextAttemptAt.toISOString(), error.slice(0, 500)]
  );
}

export async function markNotificationFailed(id: string, error: string): Promise<void> {
  await pool.query("UPDATE notifications_outbox SET status = 'failed', last_error = $2 WHERE id = $1", [
    id,
    error.slice(0, 500)
  ]);
}
