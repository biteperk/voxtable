import { env } from "../config/env";
import { logger } from "../utils/logger";
import { enqueueNotification } from "../repositories/notifications";
import { getRestaurantProfile } from "../repositories/restaurants";

export function isEmailEnabled(): boolean {
  if (!env.NOTIFICATIONS_ENABLED) return false;
  // The worker can only drain email rows with the active provider's credential.
  return env.EMAIL_PROVIDER === "zeptomail"
    ? Boolean(env.ZEPTOMAIL_TOKEN)
    : Boolean(env.SENDGRID_API_KEY);
}

export function isSmsEnabled(): boolean {
  if (!env.NOTIFICATIONS_ENABLED) return false;
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      (env.NOTIFICATIONS_MESSAGING_SERVICE_SID || env.NOTIFICATIONS_SMS_FROM)
  );
}

/**
 * The sender half of a Twilio send — exactly one parameter, Messaging Service
 * first. Returns null when neither is configured (the channel is then not
 * claimed at all, so rows wait as pending rather than burning attempts).
 *
 * Never returns both. Twilio reads `{messagingServiceSid, from}` together as
 * "keep the service's features but pin this From", which switches OFF automatic
 * sender selection — so the alphanumeric `BitePerk` sender would be ignored even
 * once it is in the pool, and the failure is silent. Read off the VM on 1 Sep
 * 2026, production sets NEITHER variable, so nothing sends at all — and its
 * TWILIO_ACCOUNT_SID is the legacy Algorythmos account, which owns neither the
 * Messaging Service nor the number. Correct the credentials before setting a
 * sender; no sender value works until then.
 *
 * With the service alone, Twilio picks the alphanumeric sender where the
 * destination supports it and falls back to a number from the same pool where it
 * does not. Rolling back to the plain number is unsetting the SID — an env
 * change, no deploy.
 */
export function resolveSmsSender(config: {
  messagingServiceSid?: string;
  smsFrom?: string;
}): { messagingServiceSid: string } | { from: string } | null {
  if (config.messagingServiceSid) {
    return { messagingServiceSid: config.messagingServiceSid };
  }
  if (config.smsFrom) return { from: config.smsFrom };
  return null;
}

/**
 * Whether a completed order should text the guest.
 *
 * A pure predicate rather than an inline condition because every clause here is
 * a bug someone already shipped:
 *   - `isTakeaway`   — a dine-in pre-order hangs off a booking that already texted.
 *   - `isReplay`     — a retried tool call would text twice.
 *   - `flagEnabled`  — takeaway texts must be switchable off without touching bookings.
 *   - `senderConfigured` — the one that bites silently. Without a sender the worker
 *     never claims the row, so it sits pending and then flushes the moment a sender
 *     is switched on, texting people about orders they collected hours ago.
 *   - `hasPhone`     — a withheld caller ID has nowhere to send.
 */
export function shouldTextOrderConfirmation(input: {
  isTakeaway: boolean;
  isReplay: boolean;
  flagEnabled: boolean;
  senderConfigured: boolean;
  hasPhone: boolean;
}): boolean {
  return (
    input.isTakeaway &&
    !input.isReplay &&
    input.flagEnabled &&
    input.senderConfigured &&
    input.hasPhone
  );
}

/** `resolveSmsSender` bound to the live environment. */
export function smsSenderParams(): { messagingServiceSid: string } | { from: string } | null {
  return resolveSmsSender({
    messagingServiceSid: env.NOTIFICATIONS_MESSAGING_SERVICE_SID,
    smsFrom: env.NOTIFICATIONS_SMS_FROM
  });
}

// The channels are independent: an SMS-only deployment (no email key) must
// still drain the outbox, and vice versa. The worker claims only rows whose
// channel is actually sendable, so a disabled channel's rows wait as pending
// rather than burning attempts.
export function isNotificationsEnabled(): boolean {
  return isEmailEnabled() || isSmsEnabled();
}

export type NotificationKind =
  | "welcome"
  | "number_ready"
  | "live"
  | "trial_ending"
  | "payment_failed";

type Vars = Record<string, string>;

// Email templates. Plain-text bodies keep it simple + deliverable; subjects are
// concise. {restaurant} etc. are interpolated from vars.
const TEMPLATES: Record<NotificationKind, (v: Vars) => { subject: string; body: string }> = {
  welcome: (v) => ({
    subject: `Welcome to VoxTable, ${v.restaurant ?? "there"}!`,
    body: `Thanks for signing up. Finish setting up your AI phone host and you'll be taking bookings in no time.`
  }),
  number_ready: (v) => ({
    subject: `Your VoxTable number is ready`,
    body: `Your dedicated number ${v.number ?? ""} is live. Log in and follow the "Connect your phone" step to forward your calls and activate the reviewed configuration.`
  }),
  live: (v) => ({
    subject: `🎉 ${v.restaurant ?? "Your restaurant"} is live on VoxTable`,
    body: `Bella is now answering your calls. Manage bookings, calls and your menu from your dashboard anytime.`
  }),
  trial_ending: (_v) => ({
    subject: `Your VoxTable trial ends soon`,
    body: `Your free trial is ending. No action needed to continue — your subscription will start automatically. Manage your plan anytime from Billing.`
  }),
  payment_failed: (_v) => ({
    subject: `Action needed: payment issue on your VoxTable account`,
    body: `We couldn't process your latest payment. Please update your card in Billing to keep Bella answering your calls.`
  })
};

/**
 * Queue a notification email to a restaurant's contact email. No-op (logged)
 * when notifications are disabled or the restaurant has no contact email, so
 * callers can fire-and-forget without guarding. The worker does the sending.
 */
export async function notifyRestaurant(
  kind: NotificationKind,
  restaurantId: string,
  vars: Vars = {}
): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    const profile = await getRestaurantProfile(restaurantId);
    const email = profile?.contact_email;
    if (!email) {
      logger.info({ evt: "notification_skipped_no_email", restaurant_id: restaurantId, kind });
      return;
    }
    const merged: Vars = { restaurant: profile?.name ?? "", ...vars };
    const { subject, body } = TEMPLATES[kind](merged);
    await enqueueNotification({
      restaurantId,
      channel: "email",
      recipient: email,
      kind,
      subject,
      body
    });
  } catch (error) {
    // Never let a notification failure break the caller's flow.
    logger.error({ evt: "notification_enqueue_failed", restaurant_id: restaurantId, kind, error });
  }
}
