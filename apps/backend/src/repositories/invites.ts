import crypto from "crypto";

import { DbClient, pool } from "../db/pool";
import { AppError } from "../domain/errors";
import type { MemberRole } from "./members";

export interface StaffInvite {
  id: string;
  restaurantId: string;
  email: string;
  role: MemberRole;
  invitedBy: string;
  token: string;
  status: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface InviteInfo {
  restaurantName: string;
  role: MemberRole;
  inviterName: string | null;
  inviterEmail: string;
  email: string;
  expiresAt: string;
}

interface InviteRow {
  id: string;
  restaurant_id: string;
  email: string;
  role: MemberRole;
  invited_by: string;
  token: string;
  status: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

interface InviteInfoRow {
  restaurant_name: string;
  role: MemberRole;
  inviter_name: string | null;
  inviter_email: string;
  email: string;
  expires_at: string;
}

/**
 * Create an invite for a staff member. Generates a cryptographically random
 * token. Default expiry is 7 days. The partial unique index on
 * (restaurant_id, lower(email)) WHERE status='pending' prevents duplicate
 * pending invites to the same person.
 */
export async function createInvite(
  input: {
    restaurantId: string;
    email: string;
    role: MemberRole;
    invitedBy: string;
    expiresInDays?: number;
  },
  db: DbClient = pool
): Promise<StaffInvite> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresInDays = input.expiresInDays ?? 7;
  try {
    const result = await db.query<InviteRow>(
      `
      INSERT INTO staff_invites (restaurant_id, email, role, invited_by, token, expires_at)
      VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
      RETURNING id, restaurant_id, email, role, invited_by, token, status,
                expires_at::text, accepted_at::text, created_at::text
      `,
      [input.restaurantId, input.email.toLowerCase().trim(), input.role, input.invitedBy, token, expiresInDays]
    );
    const row = result.rows[0]!;
    return mapRow(row);
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new AppError(
        409,
        "INVITE_ALREADY_PENDING",
        "A pending invite already exists for this email."
      );
    }
    throw error;
  }
}

/**
 * Look up a pending, non-expired invite by its token.
 */
export async function getInviteByToken(
  token: string,
  db: DbClient = pool
): Promise<StaffInvite | null> {
  const result = await db.query<InviteRow>(
    `
    SELECT id, restaurant_id, email, role, invited_by, token, status,
           expires_at::text, accepted_at::text, created_at::text
    FROM staff_invites
    WHERE token = $1 AND status = 'pending' AND expires_at > now()
    `,
    [token]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Public invite info for the accept page — shows restaurant name, role, and
 * who sent the invite without leaking internal IDs.
 */
export async function getInviteInfo(
  token: string,
  db: DbClient = pool
): Promise<InviteInfo | null> {
  const result = await db.query<InviteInfoRow>(
    `
    SELECT r.name AS restaurant_name, si.role, u.name AS inviter_name,
           u.email AS inviter_email, si.email, si.expires_at::text
    FROM staff_invites si
    JOIN restaurants r ON r.id = si.restaurant_id
    JOIN users u ON u.id = si.invited_by
    WHERE si.token = $1 AND si.status = 'pending' AND si.expires_at > now()
    `,
    [token]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    restaurantName: row.restaurant_name,
    role: row.role,
    inviterName: row.inviter_name,
    inviterEmail: row.inviter_email,
    email: row.email,
    expiresAt: row.expires_at
  };
}

/**
 * Accept an invite: mark as accepted and create the membership row. Both
 * happen in the caller's transaction. If the user already has a membership
 * at this restaurant, the INSERT is a no-op (ON CONFLICT DO NOTHING).
 */
export async function acceptInvite(
  token: string,
  userId: string,
  email: string,
  db: DbClient = pool
): Promise<StaffInvite | null> {
  // Mark invite accepted only when the authenticated user's email matches the invite.
  const result = await db.query<InviteRow>(
    `
    UPDATE staff_invites
    SET status = 'accepted', accepted_at = now()
    WHERE token = $1
      AND lower(email) = lower($2)
      AND status = 'pending'
      AND expires_at > now()
    RETURNING id, restaurant_id, email, role, invited_by, token, status,
              expires_at::text, accepted_at::text, created_at::text
    `,
    [token, email.toLowerCase().trim()]
  );
  if (!result.rows[0]) return null;
  const invite = mapRow(result.rows[0]);

  // Create membership (idempotent)
  await db.query(
    `
    INSERT INTO restaurant_members (user_id, restaurant_id, role)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, restaurant_id) DO NOTHING
    `,
    [userId, invite.restaurantId, invite.role]
  );

  return invite;
}

/**
 * All pending invites for a restaurant (for the manager's staff list).
 */
export async function listPendingInvites(
  restaurantId: string,
  db: DbClient = pool
): Promise<StaffInvite[]> {
  const result = await db.query<InviteRow>(
    `
    SELECT id, restaurant_id, email, role, invited_by, token, status,
           expires_at::text, accepted_at::text, created_at::text
    FROM staff_invites
    WHERE restaurant_id = $1 AND status = 'pending' AND expires_at > now()
    ORDER BY created_at DESC
    `,
    [restaurantId]
  );
  return result.rows.map(mapRow);
}

/**
 * Revoke a pending invite (manager decided to cancel it).
 */
export async function revokeInvite(
  inviteId: string,
  restaurantId: string,
  db: DbClient = pool
): Promise<boolean> {
  const result = await db.query(
    `
    UPDATE staff_invites
    SET status = 'revoked'
    WHERE id = $1 AND restaurant_id = $2 AND status = 'pending'
    `,
    [inviteId, restaurantId]
  );
  return (result.rowCount ?? 0) > 0;
}


function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}
function mapRow(row: InviteRow): StaffInvite {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    token: row.token,
    status: row.status,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at
  };
}
