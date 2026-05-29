import { env } from "../config/env";
import { logger } from "../utils/logger";
import { enqueueNotification } from "../repositories/notifications";
import { getRestaurantProfile } from "../repositories/restaurants";

export function isNotificationsEnabled(): boolean {
  return env.NOTIFICATIONS_ENABLED && Boolean(env.SENDGRID_API_KEY);
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
    subject: `Welcome to VocoTable, ${v.restaurant ?? "there"}!`,
    body: `Thanks for signing up. Finish setting up your AI phone host and you'll be taking bookings in no time.`
  }),
  number_ready: (v) => ({
    subject: `Your VocoTable number is ready`,
    body: `Your dedicated number ${v.number ?? ""} is live. Log in and follow the "Connect your phone" step to forward your calls and run a quick test.`
  }),
  live: (v) => ({
    subject: `🎉 ${v.restaurant ?? "Your restaurant"} is live on VocoTable`,
    body: `Bella is now answering your calls. Manage bookings, calls and your menu from your dashboard anytime.`
  }),
  trial_ending: (v) => ({
    subject: `Your VocoTable trial ends soon`,
    body: `Your free trial is ending. No action needed to continue — your subscription will start automatically. Manage your plan anytime from Billing.`
  }),
  payment_failed: (v) => ({
    subject: `Action needed: payment issue on your VocoTable account`,
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
  if (!isNotificationsEnabled()) return;
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
