import { Router } from "express";

import { AuthenticatedRequest, requireFirebaseAuth } from "../auth/firebaseAuth";
import { asyncHandler } from "../http/asyncHandler";
import { getUserMemberships, upsertUser } from "../repositories/members";

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
