import { Router } from "express";
import { z } from "zod";

import {
  AuthenticatedRequest,
  requireFirebaseAuth,
  requireFirebaseIdentity
} from "../auth/firebaseAuth";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { contactLimiter } from "../http/rateLimiters";
import { getUserMemberships, updateUserContact, upsertUser } from "../repositories/members";
import { normalizePhone } from "../utils/phone";

// Identity endpoint the dashboard calls on load to learn who the user is and
// which restaurant(s) they belong to. This is also where the `users` row is
// lazily provisioned on first authenticated hit (the Firebase uid is the PK).
export const meRouter = Router();

meRouter.get(
  "/api/me",
  requireFirebaseAuth,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const user = request.firebaseUser;

    // Dev escape hatch (DASHBOARD_VERIFY_AUTH=false): no verified token. Present
    // the same synthetic identity used by onboarding create, so local signup can
    // create a restaurant and immediately see its owner membership.
    if (!user) {
      const devUserId = "dev-local-user";
      await upsertUser({
        id: devUserId,
        email: "dev@local.test",
        name: "Dev User",
        emailVerified: true
      });
      const memberships = await getUserMemberships(devUserId);
      response.json({
        user: {
          id: devUserId,
          email: "dev@local.test",
          name: "Dev User",
          email_verified: true
        },
        memberships: memberships.map((m) => ({
          restaurant_id: m.restaurantId,
          name: m.restaurantName,
          role: m.role
        })),
        active_restaurant_id: memberships.length === 1 ? memberships[0]!.restaurantId : null
      });
      return;
    }

    await upsertUser({
      id: user.uid,
      email: user.email ?? "",
      name: (user.name as string | undefined) ?? null,
      emailVerified: user.email_verified === true
    });

    const memberships = await getUserMemberships(user.uid);

    response.json({
      user: {
        id: user.uid,
        email: user.email ?? null,
        name: (user.name as string | undefined) ?? null,
        email_verified: user.email_verified === true
      },
      memberships: memberships.map((m) => ({
        restaurant_id: m.restaurantId,
        name: m.restaurantName,
        role: m.role
      })),
      // Auto-select when there's exactly one; the frontend persists the choice
      // and sends X-Restaurant-Id thereafter. null → frontend must pick.
      active_restaurant_id: memberships.length === 1 ? memberships[0]!.restaurantId : null
    });
  })
);

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(6).max(32).optional()
});

// Representative contact details (the person, not the venue): the mobile
// number captured at signup, flushed by the frontend on the first VERIFIED
// session. requireFirebaseIdentity: verified email enforced (shared
// middleware), allowlist deliberately NOT — this is lead capture and must
// work before any membership or allowlist entry exists. Writes only the
// caller's own users row; contactLimiter caps abuse.
meRouter.post(
  "/api/me/contact",
  requireFirebaseIdentity,
  contactLimiter,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const user = request.firebaseUser;
    if (!user) {
      // Dev escape hatch — accept and no-op against the synthetic identity.
      response.json({ ok: true, dev: true });
      return;
    }

    const body = contactSchema.parse(request.body);

    let phone: string | null = null;
    if (body.phone !== undefined) {
      phone = normalizePhone(body.phone);
      if (!phone) {
        throw new AppError(
          400,
          "INVALID_PHONE",
          "That mobile number doesn't look right — please use an Australian mobile like 04xx xxx xxx."
        );
      }
    }

    await updateUserContact({
      id: user.uid,
      email: user.email ?? "",
      name: body.name ?? null,
      phone
    });

    response.json({ ok: true });
  })
);
