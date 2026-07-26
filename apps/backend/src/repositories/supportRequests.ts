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
