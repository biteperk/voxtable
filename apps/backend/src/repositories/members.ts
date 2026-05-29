import { DbClient, pool } from "../db/pool";

export type MemberRole = "owner" | "manager" | "staff";

export interface Membership {
  restaurantId: string;
  restaurantName: string;
  role: MemberRole;
}

interface MembershipRow {
  restaurant_id: string;
  restaurant_name: string;
  role: MemberRole;
}

/**
 * All restaurants the user belongs to, with their role at each. Joined to
 * restaurants so the dashboard can render a switcher without a second call.
 * Ordered by membership age so the "first" membership is deterministic when a
 * user has exactly one (the common case) and no explicit selection is sent.
 */
export async function getUserMemberships(
  userId: string,
  db: DbClient = pool
): Promise<Membership[]> {
  const result = await db.query<MembershipRow>(
    `
    SELECT rm.restaurant_id, r.name AS restaurant_name, rm.role
    FROM restaurant_members rm
    JOIN restaurants r ON r.id = rm.restaurant_id
    WHERE rm.user_id = $1
    ORDER BY rm.created_at ASC
    `,
    [userId]
  );
  return result.rows.map((row) => ({
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    role: row.role
  }));
}

/**
 * Single-row authorization check: the user's role at one restaurant, or null
 * if they are not a member. This is the isolation guarantee — resolveTenant
 * validates the requested restaurant against this before trusting it.
 */
export async function getMembership(
  userId: string,
  restaurantId: string,
  db: DbClient = pool
): Promise<{ role: MemberRole } | null> {
  const result = await db.query<{ role: MemberRole }>(
    "SELECT role FROM restaurant_members WHERE user_id = $1 AND restaurant_id = $2 LIMIT 1",
    [userId, restaurantId]
  );
  return result.rows[0] ?? null;
}

/**
 * Idempotently create/refresh the users row on login (the Firebase uid is the
 * PK). email_verified is mirrored from the verified token so cost/paid actions
 * can gate on it. Does NOT create any membership — that happens at restaurant
 * creation (onboarding) or via an invite.
 */
export async function upsertUser(
  input: { id: string; email: string; name?: string | null; emailVerified?: boolean },
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `
    INSERT INTO users (id, email, name, email_verified)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      name = COALESCE(EXCLUDED.name, users.name),
      email_verified = EXCLUDED.email_verified,
      updated_at = now()
    `,
    [input.id, input.email, input.name ?? null, input.emailVerified ?? false]
  );
}
