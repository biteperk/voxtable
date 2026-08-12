/**
 * Lazy singleton Stripe SDK instance.
 *
 * Why a getter instead of a module-level `new Stripe(...)`:
 *   - Billing is behind the STRIPE_BILLING_ENABLED kill switch. The scaffolding
 *     ships to production with the flag OFF and no key set, so we must NOT
 *     construct the client (or throw) at import time.
 *   - `getStripe()` throws AppError(503) when disabled/unconfigured, so route
 *     handlers fail with a clean envelope rather than a raw SDK error.
 *
 * We deliberately rely on the official SDK's built-in `timeout` +
 * `maxNetworkRetries` rather than the calcom-style hand-rolled circuit breaker:
 * the SDK already owns retry/backoff for idempotent reads, and billing is a
 * single-tenant, on-load read — there's no outbox to protect.
 */

import Stripe from "stripe";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";

// Pinned to the API version the installed SDK's types reflect
// (stripe@18.5.0 → LatestApiVersion). Bump in lockstep with the SDK so the
// invoice→charge field shapes the service relies on stay stable, and so tsc
// keeps accepting this literal.
const STRIPE_API_VERSION = "2025-08-27.basil" as const;

let client: Stripe | null = null;

// Self-serve billing (Phase 3) creates a Stripe customer per restaurant, so a
// single env STRIPE_CUSTOMER_ID is no longer required — only the secret key.
export function isBillingConfigured(): boolean {
  return Boolean(env.STRIPE_BILLING_ENABLED && env.STRIPE_SECRET_KEY);
}

/** "test" | "live" — drives the dashboard TEST MODE banner. */
export function stripeMode(): "test" | "live" {
  return env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "live" : "test";
}

export function getStripe(): Stripe {
  // Order payments (Checkout links for voice orders) share the account and the
  // client with billing, so either flag entitles construction — otherwise a
  // payments-on/billing-off config boots cleanly and then 503s every link
  // creation and 500-loops every webhook.
  if (!env.STRIPE_BILLING_ENABLED && !env.ORDER_PAYMENTS_ENABLED) {
    throw new AppError(503, "BILLING_NOT_CONFIGURED", "Billing is not enabled.");
  }
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(503, "BILLING_NOT_CONFIGURED", "Billing is not configured.");
  }
  if (!client) {
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
      timeout: env.STRIPE_REQUEST_TIMEOUT_MS,
      maxNetworkRetries: 2,
      typescript: true
    });
  }
  return client;
}

/**
 * Legacy single-tenant customer (env). Transitional fallback only — per-tenant
 * code resolves restaurants.stripe_customer_id and should pass that explicitly.
 * Returns null when unset (no throw) so callers can decide.
 */
export function legacyCustomerId(): string | null {
  return env.STRIPE_CUSTOMER_ID ?? null;
}

/**
 * Wrap every Stripe call. Logs the full (redacted) error and converts it to a
 * generic AppError — a raw Stripe message can contain customer PII and must
 * never reach the client. Transient errors map to 503, everything else to 502.
 * AppError from getStripe() (e.g. BILLING_NOT_CONFIGURED) is passed through.
 * Lives here (not stripeService) so payment services can share it without an
 * import cycle through the webhook branch.
 */
export async function withStripeErrors<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    if (err instanceof Stripe.errors.StripeError) {
      const transient =
        err instanceof Stripe.errors.StripeRateLimitError ||
        err instanceof Stripe.errors.StripeConnectionError;
      logger.error({
        evt: "stripe_request_failed",
        op,
        stripe_type: err.type,
        stripe_code: err.code ?? null,
        error: err
      });
      if (transient) {
        throw new AppError(503, "BILLING_UPSTREAM_UNAVAILABLE", "Billing is temporarily unavailable.");
      }
      throw new AppError(502, "BILLING_UPSTREAM_ERROR", "Billing is temporarily unavailable.");
    }
    logger.error({ evt: "stripe_request_failed", op, error: err });
    throw new AppError(502, "BILLING_UPSTREAM_ERROR", "Billing is temporarily unavailable.");
  }
}

/**
 * Verify a Stripe webhook signature against the raw request body. Throws
 * AppError(400) on a bad/missing signature so the route returns 4xx (Stripe
 * won't keep retrying a 4xx the way it does a 5xx).
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, "BILLING_NOT_CONFIGURED", "Webhook secret not configured.");
  }
  if (!signature) {
    throw new AppError(400, "STRIPE_BAD_SIGNATURE", "Missing Stripe-Signature header.");
  }
  // getStripe() throws BILLING_NOT_CONFIGURED when billing is switched off.
  // Resolve the client OUTSIDE the try: a blanket catch would relabel that
  // config error as a bad signature, the route would answer 400, and Stripe
  // would never retry — silently dropping every subscription event until
  // someone noticed customers weren't going live.
  const stripe = getStripe();
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new AppError(400, "STRIPE_BAD_SIGNATURE", "Invalid Stripe webhook signature.");
  }
}
