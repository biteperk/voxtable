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
    const account = await withStripeErrors("connect_create_account", () =>
      stripe.accounts.create({
        country: "AU",
        // on_behalf_of requires a payments capability on the connected
        // account; card_payments + transfers is the destination-charge pair.
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        business_profile: profile?.name ? { name: profile.name } : undefined,
        metadata: { restaurant_id: restaurantId }
      })
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
