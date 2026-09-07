import { DbClient, pool } from "../db/pool";

export interface SupportRequestRow {
  id: string;
  restaurant_id: string;
  user_id: string | null;
  user_email: string | null;
  category: "account" | "billing" | "booking" | "technical" | "other";
  subject: string;
  message: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  created_at: string;
  resolved_at: string | null;
}

export async function createSupportRequest(
  input: {
    restaurantId: string;
    userId?: string | null;
    userEmail?: string | null;
    category: SupportRequestRow["category"];
    subject: string;
    message: string;
  },
  db: DbClient = pool
): Promise<SupportRequestRow> {
  const result = await db.query<SupportRequestRow>(
    `
    INSERT INTO support_requests (
      restaurant_id,
      user_id,
      user_email,
      category,
      subject,
      message
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
    `,
    [
      input.restaurantId,
      input.userId ?? null,
      input.userEmail ?? null,
      input.category,
      input.subject.trim(),
      input.message.trim()
    ]
  );

  return result.rows[0]!;
}

export interface SupportRequestWithVenue extends SupportRequestRow {
  restaurant_name: string | null;
}

/** Admin inbox — open-first via the (status, created_at DESC) index. */
export async function listSupportRequests(
  filter: { status?: SupportRequestRow["status"]; limit?: number },
  db: DbClient = pool
): Promise<SupportRequestWithVenue[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const params: Array<string | number> = [];
  let where = "";
  if (filter.status) {
    params.push(filter.status);
    where = `WHERE s.status = $${params.length}`;
  }
  params.push(limit);
  const result = await db.query<SupportRequestWithVenue>(
    `SELECT s.*, r.name AS restaurant_name
       FROM support_requests s
       LEFT JOIN restaurants r ON r.id = s.restaurant_id
       ${where}
      ORDER BY (s.status = 'open') DESC, s.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

/**
 * Move a request through its lifecycle. resolved_at is stamped on
 * resolved/closed and cleared again if the request is reopened.
 */
export async function setSupportRequestStatus(
  id: string,
  status: SupportRequestRow["status"],
  db: DbClient = pool
): Promise<SupportRequestRow | null> {
  const result = await db.query<SupportRequestRow>(
    `UPDATE support_requests
        SET status = $2,
            resolved_at = CASE WHEN $2 IN ('resolved', 'closed') THEN COALESCE(resolved_at, now()) ELSE NULL END
      WHERE id = $1
      RETURNING *`,
    [id, status]
  );
  return result.rows[0] ?? null;
}

export interface SupportReplyRow {
  id: string;
  support_request_id: string;
  channel: "email" | "internal";
  author_uid: string;
  author_email: string | null;
  body: string;
  notification_id: string | null;
  created_at: string;
}

/** One request with the venue name, for the thread view. */
export async function getSupportRequest(
  id: string,
  db: DbClient = pool
): Promise<SupportRequestWithVenue | null> {
  const result = await db.query<SupportRequestWithVenue>(
    `SELECT s.*, r.name AS restaurant_name
       FROM support_requests s
       LEFT JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** The thread, oldest first — the order it was written in. */
export async function listSupportReplies(
  supportRequestId: string,
  db: DbClient = pool
): Promise<SupportReplyRow[]> {
  const result = await db.query<SupportReplyRow>(
    `SELECT * FROM support_replies
      WHERE support_request_id = $1
      ORDER BY created_at ASC`,
    [supportRequestId]
  );
  return result.rows;
}

export async function addSupportReply(
  input: {
    supportRequestId: string;
    channel: SupportReplyRow["channel"];
    authorUid: string;
    authorEmail?: string | null;
    body: string;
    notificationId?: string | null;
  },
  db: DbClient = pool
): Promise<SupportReplyRow> {
  const result = await db.query<SupportReplyRow>(
    `INSERT INTO support_replies
       (support_request_id, channel, author_uid, author_email, body, notification_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.supportRequestId,
      input.channel,
      input.authorUid,
      input.authorEmail ?? null,
      input.body.trim(),
      input.notificationId ?? null
    ]
  );
  return result.rows[0]!;
}

/** How many replies each request carries, so the inbox list can show it. */
export async function countRepliesByRequest(
  ids: string[],
  db: DbClient = pool
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const result = await db.query<{ support_request_id: string; n: string }>(
    `SELECT support_request_id, COUNT(*)::text AS n
       FROM support_replies
      WHERE support_request_id = ANY($1::uuid[])
      GROUP BY support_request_id`,
    [ids]
  );
  return new Map(result.rows.map((row) => [row.support_request_id, Number(row.n)]));
}
