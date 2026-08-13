/**
 * Stripe Connect (destination charges) — one connected account per venue.
 *
 * Guest payments for voice orders land on the BitePerk platform account and
 * auto-transfer to the venue's connected account minus our application fee;
 * `on_behalf_of` makes the venue the settlement merchant (their name on the
 * guest's statement). This service owns account creation, the Stripe-hosted
 * onboarding link, and the capability cache on `restaurants`.
 *
 * Kill switch: STRIPE_CONNECT_ENABLED. Route handlers return a graceful
 * disabled state; nothing here is reachable from the voice path directly.
 */

import type Stripe from "stripe";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";
import { getStripe, withStripeErrors } from "./stripeClient";
import {
  findRestaurantIdByConnectAccountId,
  getConnectAccountState,
  getRestaurantProfile,
  setConnectAccountId,
  updateConnectCapabilities
} from "../repositories/restaurants";

/**
 * The client is pinned to the API version the installed SDK's types describe
 * (2025-08-27.basil), and that pin must not move independently — billing reads
 * invoice/charge shapes off it. But `/v2/core/accounts` does not exist on a
 * 2025 version: the call comes back "API method cannot be found". So the
 * account-creation request alone is sent with a newer version, per request.
 * Pinning it here rather than tracking the account default is deliberate — the
 * v2 account shape is then stable for us regardless of dashboard changes.
 */
const STRIPE_ACCOUNTS_V2_API_VERSION = "2026-06-24.dahlia";

export function isConnectEnabled(): boolean {
  return Boolean(env.STRIPE_CONNECT_ENABLED && env.STRIPE_SECRET_KEY);
}

export interface ConnectStatus {
  enabled: boolean;
  account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
}

export async function getConnectStatus(restaurantId: string): Promise<ConnectStatus> {
  const state = await getConnectAccountState(restaurantId);
  return {
    enabled: isConnectEnabled(),
    account_id: state?.stripe_connect_account_id ?? null,
    charges_enabled: state?.stripe_connect_charges_enabled ?? false,
    payouts_enabled: state?.stripe_connect_payouts_enabled ?? false
  };
}

/**
 * Create the venue's connected account.
 *
 * This goes through `/v2/core/accounts`, not `stripe.accounts.create`. Stripe
 * stopped accepting the v1 Accounts API for Connect platforms enabled from
 * 2026 — it is an outright error, not a deprecation warning, so on a freshly
 * enabled platform (which is what production will be) the first venue to
 * onboard would simply fail. Platforms already using v1 are grandfathered,
 * which is why staging can look healthy while production is broken.
 *
 * It uses `rawRequest` rather than the typed helpers because the pinned SDK
 * has no v2 surface at all. `rawRequest` still goes through the configured
 * client, so auth, timeout, retries and error mapping behave like every other
 * call. Replace this with `stripe.v2.core.accounts.create` once the SDK is
 * upgraded.
 *
 * Two details that are easy to get wrong and fail late:
 *  - The transfers half of a destination charge is
 *    `recipient.capabilities.stripe_balance.stripe_transfers`. Without it,
 *    account creation succeeds and every *charge* fails. Worse, the v1 view
 *    of the account reports `transfers: active` regardless, so the readback
 *    lies to you while payments break.
 *  - `dashboard: "express"` is required for a merchant account, and it also
 *    hands requirement collection to Stripe — which is what we want (venues
 *    complete their own details via the hosted link below), but it means the
 *    platform cannot set business details by API afterwards.
 */
async function createConnectedAccount(
  stripe: Stripe,
  restaurantId: string,
  venueName: string | null,
  contactEmail: string
): Promise<{ id: string }> {
  const account = (await stripe.rawRequest("POST", "/v2/core/accounts", {
    contact_email: contactEmail,
    display_name: venueName ?? undefined,
    dashboard: "express",
    identity: { country: "au" },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } }
    },
    defaults: {
      currency: "aud",
      // Express requires the platform to carry losses; this matches the
      // documented position that disputes debit us, not the venue.
      responsibilities: { fees_collector: "application", losses_collector: "application" }
    },
    metadata: { restaurant_id: restaurantId }
  }, {
    additionalHeaders: { "Stripe-Version": STRIPE_ACCOUNTS_V2_API_VERSION }
  })) as { id?: unknown };

  if (typeof account?.id !== "string" || !account.id.startsWith("acct_")) {
    throw new AppError(502, "BILLING_UPSTREAM_ERROR", "Stripe returned no connected account id.");
  }
  return { id: account.id };
}

/**
 * Create (once) the venue's connected account and return a Stripe-hosted
 * onboarding link. Re-entrant: an existing account gets a fresh link — Account
 * Links are single-use and expire, so "resume onboarding" is the same call.
 */
export async function createConnectOnboardingLink(
  restaurantId: string
): Promise<{ url: string; account_id: string }> {
  if (!isConnectEnabled()) {
    throw new AppError(503, "CONNECT_NOT_CONFIGURED", "Payouts are not enabled.");
  }
  const stripe = getStripe();

  let accountId = (await getConnectAccountState(restaurantId))?.stripe_connect_account_id ?? null;
  if (!accountId) {
    const profile = await getRestaurantProfile(restaurantId);
    // Stripe refuses configuration.recipient without a contact email, and
    // dropping recipient to get past that would create an account that looks
    // fine and then fails on every charge. Venues installed by hand carry a
    // null contact_email on purpose (it suppresses the go-live emails during
    // setup), so this is reachable — say so plainly instead.
    if (!profile?.contact_email) {
      throw new AppError(
        400,
        "CONNECT_CONTACT_EMAIL_REQUIRED",
        "Set the venue's contact email before connecting payouts."
      );
    }
    const account = await withStripeErrors("connect_create_account", () =>
      createConnectedAccount(stripe, restaurantId, profile.name ?? null, profile.contact_email as string)
    );
    accountId = account.id;
    await setConnectAccountId(restaurantId, accountId);
    logger.info({ evt: "connect_account_created", restaurant_id: restaurantId, account_id: accountId });
  }

  // Return/refresh land on the dashboard Billing page (same base the portal
  // uses); refresh_url fires when the link expired mid-flow — the page's
  // "Set up payouts" button simply mints a new link.
  const link = await withStripeErrors("connect_create_account_link", () =>
    stripe.accountLinks.create({
      account: accountId as string,
      type: "account_onboarding",
      return_url: env.STRIPE_PORTAL_RETURN_URL,
      refresh_url: env.STRIPE_PORTAL_RETURN_URL
    })
  );
  return { url: link.url, account_id: accountId };
}

/**
 * Sync the capability cache from an account.updated event (or a manual
 * refresh). Called by the webhook with the event's account object; resolves
 * the venue by connected-account id — these events carry no metadata.
 */
export async function syncConnectAccount(account: Stripe.Account): Promise<void> {
  const restaurantId =
    (account.metadata?.restaurant_id as string | undefined) ??
    (await findRestaurantIdByConnectAccountId(account.id));
  if (!restaurantId) {
    logger.warn({ evt: "connect_account_unmatched", account_id: account.id });
    return;
  }
  await updateConnectCapabilities(
    restaurantId,
    Boolean(account.charges_enabled),
    Boolean(account.payouts_enabled)
  );
  logger.info({
    evt: "connect_capabilities_synced",
    restaurant_id: restaurantId,
    account_id: account.id,
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled)
  });
}

/** Pull current capability state from Stripe (dashboard "refresh" affordance). */
export async function refreshConnectStatus(restaurantId: string): Promise<ConnectStatus> {
  if (!isConnectEnabled()) return getConnectStatus(restaurantId);
  const state = await getConnectAccountState(restaurantId);
  const accountId = state?.stripe_connect_account_id;
  if (accountId) {
    const stripe = getStripe();
    const account = await withStripeErrors("connect_retrieve_account", () =>
      stripe.accounts.retrieve(accountId)
    );
    await syncConnectAccount(account);
  }
  return getConnectStatus(restaurantId);
}
