/**
 * Read-only mirror of the restaurant's Stripe billing data, shaped for the
 * dashboard (snake_case JSON).
 *
 * Revenue-critical rules baked in here:
 *   1. Every money figure is an INTEGER in minor units (cents) sourced directly
 *      from Stripe. We never do float arithmetic to derive money — Stripe's
 *      integers pass straight through. A `*_display` dollar string is added at
 *      the edge purely for convenience; the cents are authoritative.
 *   2. GST comes from `invoice.total_taxes[].amount` (Stripe's real tax line),
 *      NEVER `total / 1.1`. If Stripe reports no tax we surface tax_cents = 0
 *      rather than fabricating a 1/11 split on a tax document.
 *   3. Paid amount/date come from `amount_paid` / `status_transitions.paid_at`,
 *      issue date from `finalized_at ?? created`.
 *   4. Invoice number is Stripe's official `invoice.number`, falling back to id.
 *   5. Refunds live on the CHARGE (`amount_refunded`), not the invoice. We join
 *      invoices→charges via the payment_intent id and handle partial vs full.
 *   6. Currency is passed through (single tenant is `aud`) so the edge can label
 *      non-AUD rather than assuming a symbol.
 *
 * API-version note (stripe@18.5.0, pinned 2025-08-27.basil):
 *   - Invoices no longer carry a `charge` or `tax` field. Tax is `total_taxes`,
 *     and the charge is reached via `payments[].payment.payment_intent`.
 *   - A subscription's billing period now lives on the SubscriptionItem
 *     (`items.data[].current_period_end`), not the subscription itself.
 */

import Stripe from "stripe";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import {
  findRestaurantIdByStripeCustomerId,
  getOnboardingStatus,
  getRestaurantProfile,
  getRestaurantTimezone,
  getStripeCustomerId,
  setOnboardingStatus,
  setStripeCustomerId
} from "../repositories/restaurants";
import { logger } from "../utils/logger";
import { unixSecondsToYmd } from "../utils/time";
import { enqueueProvisioningJob } from "../repositories/provisioning";
import { nextOnboardingStatus } from "./onboardingService";
import { notifyRestaurant } from "./notificationService";
import { getStripe } from "./stripeClient";

// --- Dashboard-facing shapes -------------------------------------------------

export interface BillingCard {
  brand: string;
  last4: string;
}

export interface BillingInvoice {
  id: string;
  number: string;
  issued_at: string | null;
  paid_at: string | null;
  status: "paid" | "refunded" | "failed";
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  tax_behavior: "inclusive" | "exclusive" | null;
  refund_type: "full" | "partial" | null;
  refunded_at: string | null;
  refund_reason: string | null;
  card: BillingCard | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  subtotal_display: string;
  tax_display: string;
  total_display: string;
  amount_refunded_display: string | null;
}

export interface BillingPaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expiry: string | null;
  is_default: boolean;
}

export interface BillingSubscription {
  plan_name: string;
  amount_cents: number | null;
  amount_display: string | null;
  currency: string;
  interval: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

// --- Helpers -----------------------------------------------------------------

/**
 * Format integer cents as a 2dp dollar string. AUD gets a "$" prefix; any other
 * currency is rendered as "12.34 USD" so it can never be mistaken for AUD.
 * The cents value remains the source of truth — this is display sugar only.
 */
function formatAmount(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = (Math.abs(cents) / 100).toFixed(2);
  const cur = currency.toUpperCase();
  return cur === "AUD" ? `${sign}$${dollars}` : `${sign}${dollars} ${cur}`;
}

const REFUND_REASON_TEXT: Record<string, string> = {
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent charge",
  requested_by_customer: "Requested by customer",
  expired_uncaptured_charge: "Expired uncaptured charge"
};

function mapRefundReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REFUND_REASON_TEXT[reason] ?? reason.replace(/_/g, " ");
}

// draft/void are not real billed invoices → excluded. open/uncollectible on a
// charge_automatically subscription mean the auto-charge didn't go through, so
// they bucket as "failed" (the dashboard filter only has paid/refunded/failed).
function mapInvoiceStatus(
  stripeStatus: Stripe.Invoice.Status | null
): "paid" | "failed" | "excluded" {
  switch (stripeStatus) {
    case "paid":
      return "paid";
    case "open":
    case "uncollectible":
      return "failed";
    default:
      return "excluded";
  }
}

function paymentIntentId(value: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * Wrap every Stripe call. Logs the full (redacted) error and converts it to a
 * generic AppError — a raw Stripe message can contain customer PII and must
 * never reach the client. Transient errors map to 503, everything else to 502.
 * AppError from getStripe() (e.g. BILLING_NOT_CONFIGURED) is passed through.
 */
async function withStripeErrors<T>(op: string, fn: () => Promise<T>): Promise<T> {
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

// --- Public API --------------------------------------------------------------

export async function listInvoices(customer: string, restaurantId: string): Promise<BillingInvoice[]> {
  return withStripeErrors("listInvoices", async () => {
    const stripe = getStripe();
    const tz = await getRestaurantTimezone(restaurantId);

    const [invoiceList, chargeList] = await Promise.all([
      stripe.invoices.list({ customer, limit: 24, expand: ["data.payments"] }),
      // Join source for card brand/last4 + refunds. amount_refunded is always
      // on the charge; data.refunds is expanded only to surface the reason.
      stripe.charges.list({ customer, limit: 100, expand: ["data.refunds"] })
    ]);

    // payment_intent id (and charge id) → charge. List is newest-first, so the
    // first charge seen for a PI is the latest one.
    const chargeByPi = new Map<string, Stripe.Charge>();
    const chargeById = new Map<string, Stripe.Charge>();
    for (const charge of chargeList.data) {
      chargeById.set(charge.id, charge);
      const piId = paymentIntentId(charge.payment_intent);
      if (piId && !chargeByPi.has(piId)) {
        chargeByPi.set(piId, charge);
      }
    }

    const out: BillingInvoice[] = [];
    for (const invoice of invoiceList.data) {
      const status = mapInvoiceStatus(invoice.status);
      if (status === "excluded") continue;
      // A persisted invoice always has an id; the SDK types it optional only to
      // cover unsaved previews, which never appear in a list. Skip defensively.
      if (!invoice.id) continue;

      const currency = invoice.currency;
      const subtotalCents = invoice.subtotal ?? 0;
      const totalCents = invoice.total ?? 0;
      const taxes = invoice.total_taxes ?? [];
      const taxCents = taxes.reduce((sum, t) => sum + (t.amount ?? 0), 0);
      const taxBehavior = taxes[0]?.tax_behavior === "inclusive"
        ? "inclusive"
        : taxes[0]?.tax_behavior === "exclusive"
          ? "exclusive"
          : null;

      // Locate the charge behind this invoice via its payment.
      let charge: Stripe.Charge | undefined;
      const firstPayment = invoice.payments?.data?.[0]?.payment;
      if (firstPayment) {
        const piId = paymentIntentId(firstPayment.payment_intent);
        if (piId) charge = chargeByPi.get(piId);
        if (!charge && firstPayment.charge) {
          const chId = typeof firstPayment.charge === "string"
            ? firstPayment.charge
            : firstPayment.charge.id;
          charge = chargeById.get(chId);
        }
      }

      const card: BillingCard | null = charge?.payment_method_details?.card
        ? {
            brand: charge.payment_method_details.card.brand ?? "card",
            last4: charge.payment_method_details.card.last4 ?? "????"
          }
        : null;

      const amountRefundedCents = charge?.amount_refunded ?? 0;
      let finalStatus: BillingInvoice["status"] = status;
      let refundType: BillingInvoice["refund_type"] = null;
      let refundedAt: string | null = null;
      let refundReason: string | null = null;

      if (status === "paid" && amountRefundedCents > 0) {
        finalStatus = "refunded";
        // Compare against what was actually charged, not the invoice total
        // (credits/discounts can make those differ).
        const chargedCents = charge?.amount ?? totalCents;
        refundType = amountRefundedCents >= chargedCents ? "full" : "partial";
        const latestRefund = charge?.refunds?.data?.[0];
        refundReason = mapRefundReason(latestRefund?.reason);
        refundedAt = latestRefund?.created ? unixSecondsToYmd(latestRefund.created, tz) : null;
      }

      const issuedSeconds = invoice.status_transitions?.finalized_at ?? invoice.created;
      const paidSeconds = invoice.status_transitions?.paid_at ?? null;

      out.push({
        id: invoice.id,
        number: invoice.number ?? invoice.id,
        issued_at: issuedSeconds ? unixSecondsToYmd(issuedSeconds, tz) : null,
        paid_at: paidSeconds ? unixSecondsToYmd(paidSeconds, tz) : null,
        status: finalStatus,
        currency,
        subtotal_cents: subtotalCents,
        tax_cents: taxCents,
        total_cents: totalCents,
        amount_paid_cents: invoice.amount_paid ?? 0,
        amount_refunded_cents: amountRefundedCents,
        tax_behavior: taxBehavior,
        refund_type: refundType,
        refunded_at: refundedAt,
        refund_reason: refundReason,
        card,
        hosted_invoice_url: invoice.hosted_invoice_url ?? null,
        invoice_pdf: invoice.invoice_pdf ?? null,
        subtotal_display: formatAmount(subtotalCents, currency),
        tax_display: formatAmount(taxCents, currency),
        total_display: formatAmount(totalCents, currency),
        amount_refunded_display:
          amountRefundedCents > 0 ? formatAmount(amountRefundedCents, currency) : null
      });
    }

    return out;
  });
}

export async function listPaymentMethods(customer: string): Promise<{
  payment_methods: BillingPaymentMethod[];
  default_payment_method_id: string | null;
}> {
  return withStripeErrors("listPaymentMethods", async () => {
    const stripe = getStripe();

    const [customerObj, methods] = await Promise.all([
      stripe.customers.retrieve(customer, {
        expand: ["invoice_settings.default_payment_method"]
      }),
      stripe.paymentMethods.list({ customer, type: "card" })
    ]);

    let defaultPmId: string | null = null;
    if (customerObj && !("deleted" in customerObj)) {
      const dpm = customerObj.invoice_settings?.default_payment_method;
      defaultPmId = typeof dpm === "string" ? dpm : dpm?.id ?? null;
    }

    const payment_methods: BillingPaymentMethod[] = methods.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand ?? "card",
      last4: pm.card?.last4 ?? "????",
      expiry: pm.card
        ? `${String(pm.card.exp_month).padStart(2, "0")}/${pm.card.exp_year}`
        : null,
      is_default: pm.id === defaultPmId
    }));

    return { payment_methods, default_payment_method_id: defaultPmId };
  });
}

export async function getSubscription(customer: string, restaurantId: string): Promise<BillingSubscription | null> {
  return withStripeErrors("getSubscription", async () => {
    const stripe = getStripe();
    const tz = await getRestaurantTimezone(restaurantId);

    const subs = await stripe.subscriptions.list({ customer, status: "all", limit: 1 });
    const sub = subs.data[0];
    if (!sub) return null;

    const item = sub.items?.data?.[0];
    const price = item?.price;
    const amountCents = price?.unit_amount ?? null;
    const currency = price?.currency ?? "aud";

    return {
      plan_name: price?.nickname ?? "VocoTable Core Plan",
      amount_cents: amountCents,
      amount_display: amountCents != null ? formatAmount(amountCents, currency) : null,
      currency,
      interval: price?.recurring?.interval ?? "month",
      status: sub.status,
      current_period_end: item?.current_period_end
        ? unixSecondsToYmd(item.current_period_end, tz)
        : null,
      cancel_at_period_end: sub.cancel_at_period_end ?? false
    };
  });
}

export async function createPortalSession(customer: string): Promise<{ url: string }> {
  return withStripeErrors("createPortalSession", async () => {
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: env.STRIPE_PORTAL_RETURN_URL
    });
    return { url: session.url };
  });
}

// --- Self-serve subscription (Phase 3) -------------------------------------

/**
 * Resolve (or lazily create) the Stripe customer for a restaurant. The id is
 * persisted on restaurants.stripe_customer_id so it's stable across calls.
 * Idempotent: re-reads the column first.
 */
export async function getOrCreateCustomer(restaurantId: string): Promise<string> {
  return withStripeErrors("getOrCreateCustomer", async () => {
    const existing = await getStripeCustomerId(restaurantId);
    if (existing) return existing;

    const stripe = getStripe();
    const profile = await getRestaurantProfile(restaurantId);
    const customer = await stripe.customers.create({
      name: profile?.name ?? undefined,
      email: profile?.contact_email ?? undefined,
      metadata: { restaurant_id: restaurantId }
    });
    await setStripeCustomerId(restaurantId, customer.id);
    return customer.id;
  });
}

/**
 * Create a Checkout Session for the $80/mo plan with a free trial. Card is
 * collected up front (payment_method_collection: 'always') but not charged
 * until the trial ends. client_reference_id + subscription metadata carry the
 * restaurant id so the webhook can reconcile.
 */
export async function createCheckoutSession(restaurantId: string): Promise<{ url: string }> {
  return withStripeErrors("createCheckoutSession", async () => {
    if (!env.STRIPE_PRICE_ID) {
      throw new AppError(503, "BILLING_NOT_CONFIGURED", "No subscription price configured.");
    }
    const stripe = getStripe();
    const customer = await getOrCreateCustomer(restaurantId);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: restaurantId,
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      payment_method_collection: "always",
      subscription_data: {
        trial_period_days: env.STRIPE_TRIAL_DAYS,
        metadata: { restaurant_id: restaurantId }
      },
      success_url: env.STRIPE_CHECKOUT_SUCCESS_URL,
      cancel_url: env.STRIPE_CHECKOUT_CANCEL_URL
    });
    if (!session.url) {
      throw new AppError(502, "BILLING_UPSTREAM_ERROR", "Checkout session has no URL.");
    }
    return { url: session.url };
  });
}

// Map a Stripe subscription status to the onboarding event it should drive.
function eventForSubscriptionStatus(status: Stripe.Subscription.Status): "subscription_active" | "subscription_lapsed" | null {
  if (status === "trialing" || status === "active") return "subscription_active";
  if (status === "past_due" || status === "unpaid" || status === "canceled" || status === "incomplete_expired") {
    return "subscription_lapsed";
  }
  return null;
}

/**
 * Resolve the restaurant id for a webhook event: prefer our own metadata /
 * client_reference_id (set at Checkout), fall back to the customer→restaurant
 * mapping. Returns null if we can't attribute the event (then we ack + skip).
 */
async function restaurantIdForEvent(object: Record<string, unknown>): Promise<string | null> {
  const metaId = (object.metadata as Record<string, unknown> | undefined)?.restaurant_id;
  if (typeof metaId === "string" && metaId) return metaId;
  const ref = object.client_reference_id;
  if (typeof ref === "string" && ref) return ref;
  const customer = object.customer;
  if (typeof customer === "string" && customer) {
    return findRestaurantIdByStripeCustomerId(customer);
  }
  return null;
}

/**
 * Apply a billing webhook event to onboarding state. Order-independent and
 * idempotent: it DERIVES the target status from the event's current data and
 * uses the monotonic state machine (so a late/duplicate event can't regress
 * progress). Returns a short outcome string for logging.
 */
export async function handleBillingWebhook(event: Stripe.Event): Promise<string> {
  const type = event.type;

  if (
    type === "checkout.session.completed" ||
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted"
  ) {
    const object = event.data.object as unknown as Record<string, unknown>;
    const restaurantId = await restaurantIdForEvent(object);
    if (!restaurantId) return "unattributed";

    // Persist the customer id if we learned it here and don't have it yet.
    const customer = object.customer;
    if (typeof customer === "string" && customer) {
      const existing = await getStripeCustomerId(restaurantId);
      if (!existing) await setStripeCustomerId(restaurantId, customer);
    }

    // Determine the subscription status: subscription.* events carry it
    // directly; checkout.session.completed implies a started (trialing) sub.
    let event_: "subscription_active" | "subscription_lapsed" | null = null;
    if (type === "checkout.session.completed") {
      event_ = "subscription_active";
    } else if (type === "customer.subscription.deleted") {
      event_ = "subscription_lapsed";
    } else {
      const status = object.status as Stripe.Subscription.Status | undefined;
      event_ = status ? eventForSubscriptionStatus(status) : null;
    }
    if (!event_) return "no-op";

    const current = await getOnboardingStatus(restaurantId);
    if (!current) return "no-restaurant";
    const next = nextOnboardingStatus(current, event_);
    if (next !== current) {
      await setOnboardingStatus(restaurantId, next);
      logger.info({ evt: "billing_onboarding_advance", restaurant_id: restaurantId, from: current, to: next, stripe_event: type });
      if (next === "live") void notifyRestaurant("live", restaurantId);
      // Kick off automated telephony provisioning once billing is active.
      // No-op enqueue when the flag is off (admin handles it manually in 4a).
      if (next === "provisioning" && env.PROVISIONING_AUTO_ENABLED) {
        void enqueueProvisioningJob(restaurantId);
      }
    }
    return `${type} → ${next}`;
  }

  if (type === "customer.subscription.trial_will_end") {
    const object = event.data.object as unknown as Record<string, unknown>;
    const restaurantId = await restaurantIdForEvent(object);
    if (restaurantId) void notifyRestaurant("trial_ending", restaurantId);
    return "trial_will_end";
  }

  if (type === "invoice.payment_failed") {
    const object = event.data.object as unknown as Record<string, unknown>;
    const restaurantId = await restaurantIdForEvent(object);
    if (restaurantId) {
      const current = await getOnboardingStatus(restaurantId);
      if (current) {
        const next = nextOnboardingStatus(current, "subscription_lapsed");
        if (next !== current) await setOnboardingStatus(restaurantId, next);
      }
      void notifyRestaurant("payment_failed", restaurantId);
    }
    return "payment_failed";
  }

  return "ignored";
}
