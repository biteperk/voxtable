import { Router } from "express";

import { env } from "../config/env";
import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  findDuplicateRestaurant,
  getOnboardingStatus,
  getRestaurantProfile,
  getStripeCustomerId,
  setOnboardingStatus
} from "../repositories/restaurants";
import {
  createCheckoutSession,
  createPortalSession,
  getSubscription,
  listInvoices,
  listPaymentMethods
} from "../services/stripeService";
import { isBillingConfigured, stripeMode } from "../services/stripeClient";
import {
  createConnectOnboardingLink,
  getConnectStatus,
  isConnectEnabled,
  refreshConnectStatus
} from "../services/stripeConnectService";
import {
  assertCanStartCheckout,
  computeChecklist,
  nextOnboardingStatus
} from "../services/onboardingService";

// Per-tenant Stripe billing. Read endpoints mirror the active restaurant's
// Stripe data; the checkout endpoint starts a self-serve free trial. Auth +
// tenant gated. When billing is disabled, GETs return a graceful empty state.
export const billingRouter = Router();

// Path-scoped so these gates run ONLY for /api/billing/* — a bare
// router.use(mw) leaks onto every fall-through request (e.g. /api/me,
// /stripe/webhook) because the router is mounted at "/".
billingRouter.use("/api/billing", requireFirebaseAuth);
billingRouter.use("/api/billing", resolveTenant);
billingRouter.use("/api/billing", requireMemberRole("manager"));

// The restaurant's own Stripe customer. null → this restaurant hasn't started
// billing yet, and every caller below renders that as an empty/disabled state.
//
// There used to be a `?? legacyCustomerId()` fallback here, reading the
// process-wide STRIPE_CUSTOMER_ID with no tenant check at all. Every tenant
// that had not yet completed checkout — which is every new tenant — fell
// through to it, so a manager of ANY restaurant could read another business's
// invoices, amounts and card last4, and (via the portal route below) change
// their payment method or cancel their subscription. It was transition
// scaffolding for the single-tenant era and the transition is over.
//
// If a venue that was billed before multi-tenancy suddenly shows no billing,
// the fix is to set restaurants.stripe_customer_id for that venue — not to
// bring a global fallback back.
async function resolveCustomer(restaurantId: string): Promise<string | null> {
  return getStripeCustomerId(restaurantId);
}

billingRouter.get(
  "/api/billing/invoices",
  asyncHandler(async (request, response) => {
    if (!isBillingConfigured()) {
      response.json({ enabled: false, mode: stripeMode(), invoices: [] });
      return;
    }
    const restaurantId = tenantId(request);
    const customer = await resolveCustomer(restaurantId);
    if (!customer) {
      response.json({ enabled: true, mode: stripeMode(), invoices: [] });
      return;
    }
    const invoices = await listInvoices(customer, restaurantId);
    response.json({ enabled: true, mode: stripeMode(), invoices });
  })
);

billingRouter.get(
  "/api/billing/payment-methods",
  asyncHandler(async (request, response) => {
    if (!isBillingConfigured()) {
      response.json({ enabled: false, mode: stripeMode(), payment_methods: [], default_payment_method_id: null });
      return;
    }
    const customer = await resolveCustomer(tenantId(request));
    if (!customer) {
      response.json({ enabled: true, mode: stripeMode(), payment_methods: [], default_payment_method_id: null });
      return;
    }
    const result = await listPaymentMethods(customer);
    response.json({ enabled: true, mode: stripeMode(), ...result });
  })
);

billingRouter.get(
  "/api/billing/subscription",
  asyncHandler(async (request, response) => {
    if (!isBillingConfigured()) {
      response.json({ enabled: false, mode: stripeMode(), subscription: null });
      return;
    }
    const restaurantId = tenantId(request);
    const customer = await resolveCustomer(restaurantId);
    if (!customer) {
      response.json({ enabled: true, mode: stripeMode(), subscription: null });
      return;
    }
    const subscription = await getSubscription(customer, restaurantId);
    response.json({ enabled: true, mode: stripeMode(), subscription });
  })
);

// Hosted Customer Portal redirect — card management never touches our backend.
billingRouter.post(
  "/api/billing/portal-session",
  asyncHandler(async (request, response) => {
    // This was the ONE billing route with no isBillingConfigured() gate, so it
    // reached Stripe whenever ORDER_PAYMENTS_ENABLED was on even with
    // subscription billing switched off (getStripe accepts either flag).
    if (!isBillingConfigured()) {
      throw new AppError(409, "NO_BILLING", "Billing is not enabled.");
    }
    const customer = await resolveCustomer(tenantId(request));
    if (!customer) {
      throw new AppError(409, "NO_BILLING", "No billing is set up for this restaurant yet.");
    }
    const session = await createPortalSession(customer);
    response.json(session);
  })
);

// Start (or resume) a self-serve subscription with a free trial. Returns a
// Stripe-hosted Checkout URL to redirect to.
billingRouter.post(
  "/api/billing/checkout-session",
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);

    // Don't take a card until the earlier steps are actually done. A tenant who
    // pays too early can't be advanced by the Stripe webhook, and unwinding a
    // charge is far worse than refusing one.
    const statusBeforeCheckout = await getOnboardingStatus(restaurantId);
    if (!statusBeforeCheckout) {
      throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
    }
    assertCanStartCheckout(statusBeforeCheckout);

    // Commitment boundary for the advertised-number reservation: pre-trial
    // signups may share a number freely (see findDuplicateRestaurant), but the
    // first tenant to start a trial claims it. Same generic contract as the
    // profile route — no other tenant's identity in the response.
    const profile = await getRestaurantProfile(restaurantId);
    if (profile?.existing_phone_number) {
      const dup = await findDuplicateRestaurant({
        existingPhoneNumber: profile.existing_phone_number
      });
      if (dup && dup.id !== restaurantId) {
        throw new AppError(
          409,
          "DUPLICATE_RESTAURANT",
          "The phone number on your profile is already connected to an active VoxTable account. Update it on the profile step, or contact support@biteperk.com.au if you believe this is an error."
        );
      }
    }

    if (!isBillingConfigured() && env.APP_ENV !== "production") {
      // Dev-only shortcut: no Stripe, so nothing will ever send us the webhook
      // that normally advances the tenant. Tick the trial step by hand instead.
      const current = statusBeforeCheckout;
      const next = nextOnboardingStatus(current, "trial_started");
      if (next !== current) await setOnboardingStatus(restaurantId, next);
      response.json({
        url: null,
        onboarding_status: next,
        checklist: computeChecklist(next),
        mode: "billing_disabled_dev"
      });
      return;
    }

    const session = await createCheckoutSession(restaurantId);
    response.json(session);
  })
);

// --- Stripe Connect (guest payments payouts) --------------------------------

// Capability status for the Billing page's Payouts card. ?refresh=1 pulls the
// live state from Stripe (used after returning from hosted onboarding, since
// account.updated webhooks can lag the redirect).
billingRouter.get(
  "/api/billing/connect",
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    if (!isConnectEnabled()) {
      response.json(await getConnectStatus(restaurantId));
      return;
    }
    const status =
      request.query.refresh === "1"
        ? await refreshConnectStatus(restaurantId)
        : await getConnectStatus(restaurantId);
    response.json(status);
  })
);

// Mint a Stripe-hosted onboarding link (creates the connected account on
// first call). Account Links are single-use — resume = call again.
billingRouter.post(
  "/api/billing/connect/onboarding-link",
  asyncHandler(async (request, response) => {
    const result = await createConnectOnboardingLink(tenantId(request));
    response.json(result);
  })
);
