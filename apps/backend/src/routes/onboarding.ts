import { Router } from "express";

import { env } from "../config/env";
import { AuthenticatedRequest, requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { createRestaurantSchema, onboardingAdvanceSchema } from "../http/schemas";
import { pool, withTransaction } from "../db/pool";
import { countCallsSince } from "../repositories/callLogs";
import { getUserMemberships, upsertUser } from "../repositories/members";
import {
  createRestaurantWithOwner,
  getOnboardingStatus,
  getProvisioning,
  getRestaurantProfile,
  setOnboardingStatus
} from "../repositories/restaurants";
import {
  computeChecklist,
  nextOnboardingStatus,
  type OnboardingEvent
} from "../services/onboardingService";
import { notifyRestaurant } from "../services/notificationService";
import { createRestaurantLimiter } from "../http/rateLimiters";

export const onboardingRouter = Router();

// Resolve the acting user's id/email/name. In the dev escape hatch (auth off)
// there's no verified token, so use a deterministic local identity so the
// onboarding flow is testable without Firebase.
function actingUser(request: AuthenticatedRequest): { uid: string; email: string; name: string | null } {
  const fb = request.firebaseUser;
  if (fb?.uid) {
    return { uid: fb.uid, email: fb.email ?? "", name: (fb.name as string | undefined) ?? null };
  }
  if (!env.DASHBOARD_VERIFY_AUTH) {
    return { uid: "dev-local-user", email: "dev@local", name: "Dev User" };
  }
  throw new AppError(401, "MISSING_AUTH", "Authentication required.");
}

// First-signup create. Idempotent: one restaurant per owner for v1 — if the
// user already belongs to a restaurant, return it instead of creating another
// (guards against double-clicks and refreshes).
onboardingRouter.post(
  "/api/onboarding/restaurant",
  requireFirebaseAuth,
  createRestaurantLimiter,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const user = actingUser(request);
    const body = createRestaurantSchema.parse(request.body);

    await upsertUser({
      id: user.uid,
      email: user.email,
      name: user.name,
      emailVerified: request.firebaseUser?.email_verified === true
    });

    const existing = await getUserMemberships(user.uid);
    if (existing.length > 0) {
      const m = existing[0]!;
      const status = await getOnboardingStatus(m.restaurantId);
      response.status(200).json({
        restaurant_id: m.restaurantId,
        onboarding_status: status,
        idempotent: true
      });
      return;
    }

    // createRestaurantWithOwner is idempotent (per-owner advisory lock +
    // in-txn re-check), so a double-submit that slips past the read above
    // returns the same restaurant with existing=true instead of a 2nd tenant.
    const { restaurantId, existing: alreadyExisted } = await createRestaurantWithOwner({
      name: body.name,
      ownerUserId: user.uid,
      ownerName: user.name,
      contactEmail: user.email || null
    });

    if (alreadyExisted) {
      const status = await getOnboardingStatus(restaurantId);
      response.status(200).json({
        restaurant_id: restaurantId,
        onboarding_status: status,
        idempotent: true
      });
      return;
    }

    void notifyRestaurant("welcome", restaurantId);

    response.status(201).json({
      restaurant_id: restaurantId,
      onboarding_status: "account_created",
      idempotent: false
    });
  })
);

// Status + checklist for the wizard. Requires a restaurant (resolveTenant).
onboardingRouter.get(
  "/api/onboarding/status",
  requireFirebaseAuth,
  resolveTenant,
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const [status, profile] = await Promise.all([
      getOnboardingStatus(restaurantId),
      getRestaurantProfile(restaurantId)
    ]);
    if (!status) {
      throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
    }
    response.json({
      onboarding_status: status,
      checklist: computeChecklist(status),
      restaurant: { id: restaurantId, name: profile?.name ?? "" }
    });
  })
);

// Owner-driven forward transitions (profile/menu/trial). Subscription &
// provisioning transitions are server-internal (Stripe webhook / admin), not
// reachable here. menu_completed verifies the menu actually has items.
onboardingRouter.post(
  "/api/onboarding/advance",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const body = onboardingAdvanceSchema.parse(request.body);
    const event = body.event as OnboardingEvent;

    // Read status, validate the event, and write the new status atomically in
    // one transaction, serialized per-restaurant via an advisory lock. Without
    // this, the menu_completed COUNT(*) check and the status write are separate
    // queries — a concurrent menu delete between them could strand the tenant
    // in `trial` with zero menu items.
    const next = await withTransaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `onboard-advance:${restaurantId}`
      ]);

      const current = await getOnboardingStatus(restaurantId, db);
      if (!current) {
        throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
      }

      if (event === "menu_completed") {
        const count = await db.query<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM menu_items WHERE restaurant_id = $1",
          [restaurantId]
        );
        if (Number(count.rows[0]?.n ?? "0") === 0) {
          throw new AppError(
            400,
            "MENU_EMPTY",
            "Add at least one menu item before continuing."
          );
        }
      }

      const target = nextOnboardingStatus(current, event);
      if (target !== current) await setOnboardingStatus(restaurantId, target, db);
      return target;
    });

    response.json({ onboarding_status: next, checklist: computeChecklist(next) });
  })
);

// Phone-setup view for the owner: their VocoTable number (once an admin has
// bound it) + whether they're live. Drives the "Connect your phone" step.
onboardingRouter.get(
  "/api/onboarding/phone-setup",
  requireFirebaseAuth,
  resolveTenant,
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const prov = await getProvisioning(restaurantId);
    response.json({
      onboarding_status: prov?.onboarding_status ?? null,
      vocotable_number: prov?.twilio_phone_number ?? null,
      number_ready: Boolean(prov?.twilio_phone_number && prov?.retell_agent_id),
      forwarding_verified: prov?.onboarding_status === "live"
    });
  })
);

// Verify call-forwarding by looking for a real inbound call to the restaurant's
// VocoTable number in the last 15 minutes (the test call). On success, advance
// provisioning → live. This both confirms forwarding works AND proves the owner
// controls the advertised line.
onboardingRouter.post(
  "/api/onboarding/verify-forwarding",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const prov = await getProvisioning(restaurantId);
    if (!prov?.twilio_phone_number || !prov?.retell_agent_id) {
      throw new AppError(409, "NUMBER_NOT_READY", "Your phone line isn't set up yet — please check back shortly.");
    }
    if (prov.onboarding_status === "live") {
      response.json({ verified: true, onboarding_status: "live" });
      return;
    }

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const calls = await countCallsSince(restaurantId, since);
    if (calls === 0) {
      throw new AppError(
        409,
        "NO_TEST_CALL",
        "We haven't seen a test call yet. Forward your number to your VocoTable number, then call your restaurant from another phone."
      );
    }

    const next = nextOnboardingStatus(prov.onboarding_status, "provisioned");
    if (next !== prov.onboarding_status) {
      await setOnboardingStatus(restaurantId, next);
      if (next === "live") void notifyRestaurant("live", restaurantId);
    }
    response.json({ verified: true, onboarding_status: next });
  })
);
