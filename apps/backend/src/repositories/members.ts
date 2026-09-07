import { DbClient, pool } from "../db/pool";
import { AppError } from "../domain/errors";

export type MemberRole = "owner" | "manager" | "staff" | "server" | "kitchen";

export interface Membership {
  restaurantId: string;
  restaurantName: string;
  role: MemberRole;
  /** Contracted Vox products, e.g. ["voxtable"]. Empty until the agreement step. */
  services: string[];
  /** When the venue's phone line is paused (kill switch), or null when live. */
  voicePausedAt: Date | null;
}

export interface RestaurantMember {
  userId: string;
  email: string;
  name: string | null;
  role: MemberRole;
  joinedAt: string;
}

interface MembershipRow {
  restaurant_id: string;
  restaurant_name: string;
  role: MemberRole;
  services: string[] | null;
  voice_paused_at: Date | null;
}

interface RestaurantMemberRow {
  user_id: string;
  email: string;
  name: string | null;
  role: MemberRole;
  joined_at: string;
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
    SELECT rm.restaurant_id, r.name AS restaurant_name, rm.role, r.services, r.voice_paused_at
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
    role: row.role,
    // Which Vox products this venue contracted for (migration 018). Written once
    // at the agreement step and, until now, read by exactly one admin endpoint no
    // UI rendered — so the dashboard could not tell what a venue had bought.
    services: row.services ?? [],
    voicePausedAt: row.voice_paused_at ?? null
  }));
}

/**
 * All members of a restaurant, joined to users for display. Manager+
 * can view this to manage their team.
 */
export async function listRestaurantMembers(
  restaurantId: string,
  db: DbClient = pool
): Promise<RestaurantMember[]> {
  const result = await db.query<RestaurantMemberRow>(
    `
    SELECT rm.user_id, u.email, u.name, rm.role,
           rm.created_at::text AS joined_at
    FROM restaurant_members rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.restaurant_id = $1
    ORDER BY rm.created_at ASC
    `,
    [restaurantId]
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    joinedAt: row.joined_at
  }));
}

export async function getRestaurantMember(
  restaurantId: string,
  userId: string,
  db: DbClient = pool
): Promise<RestaurantMember | null> {
  const result = await db.query<RestaurantMemberRow>(
    `
    SELECT rm.user_id, u.email, u.name, rm.role,
           rm.created_at::text AS joined_at
    FROM restaurant_members rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.restaurant_id = $1 AND rm.user_id = $2
    `,
    [restaurantId, userId]
  );
  const row = result.rows[0];
  return row
    ? {
        userId: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        joinedAt: row.joined_at
      }
    : null;
}
/**
 * Change a member's role within a restaurant. Cannot change the owner role —
 * owner is assigned at restaurant creation and there must always be one.
 */
export async function updateMemberRole(
  restaurantId: string,
  userId: string,
  newRole: MemberRole,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query(
    `
    UPDATE restaurant_members
    SET role = $3, updated_at = now()
    WHERE restaurant_id = $1 AND user_id = $2 AND role != 'owner'
    `,
    [restaurantId, userId, newRole]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Remove a member from a restaurant. Owners cannot be removed (safety).
 * Returns true if a row was actually deleted.
 */
export async function removeMember(
  restaurantId: string,
  userId: string,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query(
    `
    DELETE FROM restaurant_members
    WHERE restaurant_id = $1 AND user_id = $2 AND role != 'owner'
    `,
    [restaurantId, userId]
  );
  return (result.rowCount ?? 0) > 0;
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
  try {
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
  } catch (error) {
    // The ON CONFLICT arbiter is (id), but migration 007 ALSO puts a unique index
    // on lower(email). A single-arbiter clause does not absorb a violation of a
    // different index, so a NEW uid presenting an email another row already holds
    // raises 23505 — and nothing used to catch it. It surfaced as a bare 500
    // "Something went wrong." on the first step of the onboarding wizard, which a
    // user cannot skip or work around, and identically on accept-invite.
    //
    // This is not hypothetical or staging-only: it happens whenever a person's
    // Firebase identity changes while their email does not — account deleted and
    // recreated, or an email/password identity replaced by Google sign-in.
    //
    // Deliberately NOT auto-relinking the old row to the new uid. That is an
    // account-merge, it moves venue membership between identities, and doing it
    // silently on a login path in a product that takes guest payments is the wrong
    // default. The deliberate, audited version belongs behind the admin surface.
    if ((error as { code?: string }).code === "23505" && /email/i.test((error as { constraint?: string }).constraint ?? "")) {
      throw new AppError(
        409,
        "EMAIL_ALREADY_REGISTERED",
        "That email is already linked to a different account. Contact support so we can move your access across — signing up again won't work."
      );
    }
    throw error;
  }
}

/**
 * Representative contact details captured at self-serve signup (migration
 * 021): the person's mobile (E.164, normalized by the caller) and optionally
 * a display-name refresh. Row may not exist yet (contact can land before the
 * first /api/me hit), so this upserts. signup_source is stamped once and
 * never overwritten.
 */
export async function updateUserContact(
  input: { id: string; email: string; name?: string | null; phone?: string | null },
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `
    INSERT INTO users (id, email, name, email_verified, phone, signup_source)
    VALUES ($1, $2, $3, true, $4, 'self_serve')
    ON CONFLICT (id) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, users.name),
      phone = COALESCE(EXCLUDED.phone, users.phone),
      signup_source = COALESCE(users.signup_source, 'self_serve'),
      updated_at = now()
    `,
    [input.id, input.email, input.name ?? null, input.phone ?? null]
  );
}
