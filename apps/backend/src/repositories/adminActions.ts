import { DbClient, pool } from "../db/pool";

/**
 * Operational audit trail for the platform-admin surface (migration 033).
 * Every mutating /api/admin/* route records one row: who (Firebase uid/email),
 * what (action + params), against which venue, under which request_id. The
 * write joins the caller's transaction when one is passed, so the trail and
 * the mutation commit or roll back together.
 */

export interface AdminActionRow {
  id: string;
  actor_uid: string;
  actor_email: string | null;
  action: string;
  restaurant_id: string | null;
  target: string | null;
  params: Record<string, unknown>;
  request_id: string | null;
  created_at: string;
}

export async function recordAdminAction(
  input: {
    actorUid: string;
    actorEmail?: string | null;
    action: string;
    restaurantId?: string | null;
    target?: string | null;
    params?: Record<string, unknown>;
    requestId?: string | null;
  },
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `INSERT INTO admin_actions (actor_uid, actor_email, action, restaurant_id, target, params, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.actorUid,
      input.actorEmail ?? null,
      input.action,
      input.restaurantId ?? null,
      input.target ?? null,
      JSON.stringify(input.params ?? {}),
      input.requestId ?? null
    ]
  );
}

export async function listAdminActions(limit = 50, db: DbClient = pool): Promise<AdminActionRow[]> {
  const result = await db.query<AdminActionRow>(
    `SELECT id, actor_uid, actor_email, action, restaurant_id, target, params, request_id, created_at
       FROM admin_actions
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)]
  );
  return result.rows;
}
