import { Router } from "express";

import { env } from "../config/env";
import { AuthenticatedRequest, requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  AGREEMENT_LANGUAGES,
  AGREEMENT_SERVICES,
  agreementSchema,
  createRestaurantSchema,
  onboardingAdvanceSchema
} from "../http/schemas";
import { withTransaction } from "../db/pool";
import {
  getLatestAcceptance,
  insertAcceptance,
  saveAgreementElections
} from "../repositories/agreements";
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
  assertAcceptanceMatchesPublished,
  assertPublishedVersionAllowed,
  getPublishedLegalDocuments,
  legalDocumentsVerificationEnabled
} from "../services/legalDocuments";
import {
  computeChecklist,
  nextOnboardingStatus,
  type OnboardingEvent
} from "../services/onboardingService";
import { logger } from "../utils/logger";
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
    return { uid: "dev-local-user", email: "dev@local.test", name: "Dev User" };
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
      restaurant: { id: restaurantId, name: profile?.name ?? "" },
      // The wizard renders the trial length from THIS value rather than its own
      // copy of the number, so what the customer is promised is the same value
      // Stripe is told at checkout. They previously disagreed: the landing page
      // said 7 days, the wizard said 14, and Stripe granted 14.
      trial_days: env.STRIPE_TRIAL_DAYS
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

// Agreement step state: which services can be offered, and the latest recorded
// acceptance (if any). Legal document version/URLs/hashes come from the frontend
// GCS manifest and are submitted in POST /api/onboarding/agreement.
onboardingRouter.get(
  "/api/onboarding/agreement",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const acceptance = await getLatestAcceptance(restaurantId);
    response.json({
      // voxdrive is deliberately absent from AGREEMENT_SERVICES (concept only);
      // voxconcierge appears once its release flag is on.
      services_available: AGREEMENT_SERVICES.filter(
        (s) => s !== "voxconcierge" || env.SERVICES_VOXCONCIERGE_ENABLED
      ),
      languages: AGREEMENT_LANGUAGES,
      accepted: acceptance
        ? {
            accepted_at: acceptance.accepted_at,
            document_set_version: acceptance.document_set_version,
            order_form: acceptance.order_form_json
          }
        : null
    });
  })
);

// Owner accepts the Client Services Agreement + Privacy & Data Handling
// Schedule and elects the Order-Form values. The acceptance-ledger insert, the
// elections write, and the state-machine advance are ONE transaction — the
// status can never move past 'agreement' without a matching evidence row.
// Re-acceptance (e.g. a new document version) appends a new ledger row and
// overwrites the elections; the status advance is then an idempotent no-op.
onboardingRouter.post(
  "/api/onboarding/agreement",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("owner"),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const restaurantId = tenantId(request);
    const user = actingUser(request);
    const body = agreementSchema.parse(request.body);

    if (body.services.includes("voxconcierge") && !env.SERVICES_VOXCONCIERGE_ENABLED) {
      throw new AppError(400, "SERVICE_NOT_AVAILABLE", "VoxConcierge isn't available yet.");
    }

    // The submitted version/URLs/hashes go into the append-only ledger, so
    // they must match what we actually published — the browser doesn't get to
    // choose what the evidence says (#196). Fail-closed: manifest unreachable
    // means no acceptance is recorded. Only skipped when no manifest URL is
    // configured, which is a local-dev-only state.
    if (legalDocumentsVerificationEnabled()) {
      const published = await getPublishedLegalDocuments();
      assertPublishedVersionAllowed(published);
      assertAcceptanceMatchesPublished(body, published);
    } else if (env.APP_ENV === "production") {
      // The boot gate above should have made this unreachable. It is repeated
      // here because the failure mode is silent and permanent: an unverified
      // row in an append-only ledger cannot be corrected later, only annotated.
      // Refusing the acceptance costs one signup; recording an unverifiable one
      // costs the evidence.
      throw new AppError(
        503,
        "TERMS_VERIFICATION_UNAVAILABLE",
        "Agreement acceptance is unavailable: published legal documents are not configured."
      );
    } else {
      logger.warn({
        message: "agreement_acceptance_unverified",
        detail: "LEGAL_DOCUMENTS_MANIFEST_URL is not set; recording acceptance without manifest verification (dev only)."
      });
    }

    const result = await withTransaction(async (db) => {
      // Same lock key as /advance so the two transition paths serialize.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `onboard-advance:${restaurantId}`
      ]);

      const current = await getOnboardingStatus(restaurantId, db);
      if (!current) {
        throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
      }

      // Throws 409 if the profile step hasn't completed yet.
      const target = nextOnboardingStatus(current, "agreement_completed");

      await saveAgreementElections(
        restaurantId,
        {
          clientLegalName: body.client_legal_name,
          clientAbn: body.client_abn,
          services: body.services,
          phoneMode: body.phone_mode,
          deliveryTargets: body.delivery_targets,
          retentionDays: body.retention_days,
          storageTier: body.storage_tier,
          piiRedaction: body.pii_redaction,
          serviceStartDate: body.service_start_date ?? null
        },
        body.document_set_version,
        db
      );

      const acceptanceId = await insertAcceptance(
        {
          restaurantId,
          userId: user.uid,
          channel: "online",
          documentSetVersion: body.document_set_version,
          csaUrl: body.csa_url,
          scheduleUrl: body.schedule_url,
          csaSha256: body.csa_sha256,
          scheduleSha256: body.schedule_sha256,
          consentTerms: body.consent_terms,
          consentOverseas: body.consent_overseas,
          consentDisclosure: body.consent_disclosure,
          ipAddress: request.ip ?? null,
          userAgent: request.header("user-agent") ?? null,
          orderForm: body
        },
        db
      );

      if (target !== current) await setOnboardingStatus(restaurantId, target, db);
      return { target, acceptanceId };
    });

    response.status(201).json({
      onboarding_status: result.target,
      checklist: computeChecklist(result.target),
      acceptance_id: result.acceptanceId
    });
  })
);

// Phone-setup view for the owner: their VoxTable number (once an admin has
// bound it) + whether they're live. Drives the "Connect your phone" step.
onboardingRouter.get(
  "/api/onboarding/phone-setup",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const prov = await getProvisioning(restaurantId);
    response.json({
      onboarding_status: prov?.onboarding_status ?? null,
      vocotable_number: prov?.twilio_phone_number ?? null,
      number_ready: Boolean(prov?.twilio_phone_number && prov?.retell_agent_id),
      forwarding_verified: prov?.onboarding_status === "live",
      dev_can_skip_phone_setup:
        env.APP_ENV !== "production" &&
        !env.PROVISIONING_AUTO_ENABLED &&
        !(prov?.twilio_phone_number && prov?.retell_agent_id)
    });
  })
);

// Verify call-forwarding by looking for a real inbound call to the restaurant's
// VoxTable number in the last 15 minutes (the test call). On success, advance
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
      if (env.APP_ENV !== "production" && !env.PROVISIONING_AUTO_ENABLED) {
        await setOnboardingStatus(restaurantId, "live");
        response.json({ verified: true, onboarding_status: "live", mode: "provisioning_disabled_dev" });
        return;
      }
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
        "We haven't seen a test call yet. Forward your number to your VoxTable number, then call your restaurant from another phone."
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
