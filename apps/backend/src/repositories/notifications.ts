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

export async function enqueueNotification(input: {
  restaurantId?: string | null;
  channel: "email" | "sms";
  recipient: string;
  kind: string;
  subject?: string | null;
  body: string;
  bodyHtml?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO notifications_outbox (restaurant_id, channel, recipient, kind, subject, body, body_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
}

export async function claimReadyNotifications(limit: number, db: DbClient = pool): Promise<NotificationRow[]> {
  const result = await db.query<NotificationRow>(
    `
    UPDATE notifications_outbox
    SET attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM notifications_outbox
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    RETURNING *
    `,
    [limit]
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
