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

/**
 * How many times this exact action has been taken against this target.
 *
 * The audit log is the honest record of "how often has an admin done this", so
 * a per-target ceiling reads it rather than keeping a counter somewhere else
 * that could drift. Used to cap menu-import re-runs, where each re-run is a
 * paid vision call and the service-level daily cap does not apply.
 */
export async function countAdminActions(
  action: string,
  target: string,
  db: DbClient = pool
): Promise<number> {
  const result = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM admin_actions WHERE action = $1 AND target = $2",
    [action, target]
  );
  return Number(result.rows[0]?.n ?? "0");
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
