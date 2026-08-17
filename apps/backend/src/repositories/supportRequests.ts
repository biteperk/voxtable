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
