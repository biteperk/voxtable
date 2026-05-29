import { Router } from "express";

import { env } from "../config/env";
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
    // a synthetic owner of the default restaurant so local dashboards work.
    if (!user) {
      response.json({
        user: null,
        memberships: [],
        active_restaurant_id: env.DEFAULT_RESTAURANT_ID
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
