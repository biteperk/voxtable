import { Router } from "express";
import { z } from "zod";

import {
  actorFor,
  AuthenticatedRequest,
  requireFirebaseAuth,
  requireFirebaseIdentity
} from "../auth/firebaseAuth";
import { requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { withTransaction } from "../db/pool";
import {
  getRestaurantMember,
  listRestaurantMembers,
  removeMember,
  updateMemberRole,
  upsertUser
} from "../repositories/members";
import {
  acceptInvite,
  createInvite,
  getInviteByToken,
  getInviteInfo,
  listPendingInvites,
  revokeInvite
} from "../repositories/invites";
import { logger } from "../utils/logger";

export const staffRouter = Router();

const assignableRoles = ["manager", "server", "kitchen"] as const;
const inviteSchema = z.object({
  email: z.string().email().max(160),
  role: z.enum(assignableRoles)
});

const updateRoleSchema = z.object({
  role: z.enum(assignableRoles)
});

function actorIsOwner(request: AuthenticatedRequest): boolean {
  return request.tenant?.role === "owner";
}

function assertCanAssignRole(request: AuthenticatedRequest, role: string): void {
  if (role === "manager" && !actorIsOwner(request)) {
    throw new AppError(
      403,
      "OWNER_REQUIRED_FOR_MANAGER_ROLE",
      "Only the restaurant owner can assign the manager role."
    );
  }
}

staffRouter.get(
  "/api/staff",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const [members, invites] = await Promise.all([
      listRestaurantMembers(restaurantId),
      listPendingInvites(restaurantId)
    ]);
    response.json({
      members: members.map((m) => ({
        user_id: m.userId,
        email: m.email,
        name: m.name,
        role: m.role,
        joined_at: m.joinedAt
      })),
      pending_invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        token: i.token,
        expires_at: i.expiresAt,
        created_at: i.createdAt
      }))
    });
  })
);

staffRouter.post(
  "/api/staff/invite",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const restaurantId = tenantId(request);
    const body = inviteSchema.parse(request.body);
    assertCanAssignRole(request, body.role);

    const invitedBy = request.firebaseUser?.uid ?? "dev-local-user";
    const members = await listRestaurantMembers(restaurantId);
    const existing = members.find(
      (m) => m.email.toLowerCase() === body.email.toLowerCase()
    );
    if (existing) {
      throw new AppError(
        409,
        "ALREADY_A_MEMBER",
        `${body.email} is already a member of this restaurant.`
      );
    }

    const invite = await createInvite({
      restaurantId,
      email: body.email,
      role: body.role,
      invitedBy
    });

    logger.info({
      evt: "staff_invite_created",
      actor: actorFor(request),
      restaurant_id: restaurantId,
      invite_id: invite.id,
      invited_email: invite.email,
      role: invite.role
    });

    response.status(201).json({
      invite_id: invite.id,
      token: invite.token,
      email: invite.email,
      role: invite.role,
      expires_at: invite.expiresAt
    });
  })
);

staffRouter.patch(
  "/api/staff/:userId/role",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("owner"),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const restaurantId = tenantId(request);
    const { userId } = request.params;
    const body = updateRoleSchema.parse(request.body);

    const target = await getRestaurantMember(restaurantId, userId!);
    if (!target) {
      throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");
    }
    if (target.role === "owner") {
      throw new AppError(400, "CANNOT_CHANGE_OWNER", "The owner role cannot be changed.");
    }

    const updated = await updateMemberRole(restaurantId, userId!, body.role);
    if (!updated) {
      throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");
    }

    logger.info({
      evt: "staff_role_changed",
      actor: actorFor(request),
      restaurant_id: restaurantId,
      target_user: userId,
      old_role: target.role,
      new_role: body.role
    });

    response.json({ updated: true, user_id: userId, role: body.role });
  })
);

staffRouter.delete(
  "/api/staff/:userId",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const restaurantId = tenantId(request);
    const { userId } = request.params;
    const target = await getRestaurantMember(restaurantId, userId!);

    if (!target) {
      throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");
    }
    if (target.userId === request.firebaseUser?.uid) {
      throw new AppError(400, "CANNOT_REMOVE_SELF", "You cannot remove your own account.");
    }
    if (target.role === "owner") {
      throw new AppError(400, "CANNOT_REMOVE_OWNER", "Owners cannot be removed.");
    }
    if (target.role === "manager" && !actorIsOwner(request)) {
      throw new AppError(
        403,
        "OWNER_REQUIRED_FOR_MANAGER_ROLE",
        "Only the restaurant owner can remove a manager."
      );
    }

    const removed = await removeMember(restaurantId, userId!);
    if (!removed) {
      throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");
    }

    logger.info({
      evt: "staff_member_removed",
      actor: actorFor(request),
      restaurant_id: restaurantId,
      target_user: userId,
      target_role: target.role
    });

    response.json({ removed: true, user_id: userId });
  })
);

staffRouter.delete(
  "/api/staff/invites/:inviteId",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const restaurantId = tenantId(request);
    const { inviteId } = request.params;
    const invite = (await listPendingInvites(restaurantId)).find((i) => i.id === inviteId);

    if (!invite) {
      throw new AppError(404, "INVITE_NOT_FOUND", "Invite not found or already used.");
    }
    if (invite.role === "manager" && !actorIsOwner(request)) {
      throw new AppError(
        403,
        "OWNER_REQUIRED_FOR_MANAGER_ROLE",
        "Only the restaurant owner can revoke a manager invite."
      );
    }

    const revoked = await revokeInvite(inviteId!, restaurantId);
    if (!revoked) {
      throw new AppError(404, "INVITE_NOT_FOUND", "Invite not found or already used.");
    }

    logger.info({
      evt: "staff_invite_revoked",
      actor: actorFor(request),
      restaurant_id: restaurantId,
      invite_id: inviteId,
      invited_email: invite.email,
      role: invite.role
    });

    response.json({ revoked: true });
  })
);

staffRouter.get(
  "/api/staff/invite-info",
  asyncHandler(async (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : null;
    if (!token) {
      throw new AppError(400, "TOKEN_REQUIRED", "token query parameter is required.");
    }
    const info = await getInviteInfo(token);
    if (!info) {
      throw new AppError(404, "INVITE_NOT_FOUND", "Invite not found, expired, or already used.");
    }
    response.json({
      restaurant_name: info.restaurantName,
      role: info.role,
      inviter_name: info.inviterName,
      inviter_email: info.inviterEmail,
      invited_email: info.email,
      expires_at: info.expiresAt
    });
  })
);

staffRouter.post(
  "/api/staff/accept-invite",
  requireFirebaseIdentity,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const tokenSchema = z.object({ token: z.string().min(1) });
    const body = tokenSchema.parse(request.body);

    const user = request.firebaseUser;
    const uid = user?.uid ?? "dev-local-user";
    const email = user?.email ?? "dev@local";
    const name = (user?.name as string | undefined) ?? null;

    await upsertUser({
      id: uid,
      email,
      name,
      emailVerified: user?.email_verified === true
    });

    const invite = await withTransaction(async (db) => {
      const pending = await getInviteByToken(body.token, db);
      if (!pending) return null;
      if (pending.email.toLowerCase() !== email.toLowerCase().trim()) {
        throw new AppError(
          403,
          "INVITE_EMAIL_MISMATCH",
          "Sign in with the email address this invite was sent to."
        );
      }
      return acceptInvite(body.token, uid, email, db);
    });

    if (!invite) {
      throw new AppError(404, "INVITE_NOT_FOUND", "Invite not found, expired, or already used.");
    }

    logger.info({
      evt: "staff_invite_accepted",
      actor: uid,
      restaurant_id: invite.restaurantId,
      invite_id: invite.id,
      role: invite.role
    });

    response.json({
      accepted: true,
      restaurant_id: invite.restaurantId,
      role: invite.role
    });
  })
);