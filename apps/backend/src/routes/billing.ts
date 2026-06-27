import { Router } from "express";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { getStripeCustomerId } from "../repositories/restaurants";
import {
  createCheckoutSession,
  createPortalSession,
  getSubscription,
  listInvoices,
  listPaymentMethods
} from "../services/stripeService";
import { isBillingConfigured, legacyCustomerId, stripeMode } from "../services/stripeClient";

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

// The restaurant's own Stripe customer, falling back to the legacy single-tenant
// env id during transition. null → this restaurant hasn't started billing yet.
async function resolveCustomer(restaurantId: string): Promise<string | null> {
  return (await getStripeCustomerId(restaurantId)) ?? legacyCustomerId();
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
    const session = await createCheckoutSession(tenantId(request));
    response.json(session);
  })
);
