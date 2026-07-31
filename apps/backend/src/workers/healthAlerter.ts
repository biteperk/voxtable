/**
 * Health alerter — periodic poll that posts to Slack when any production
 * health threshold trips. Two unrelated subsystems are covered:
 *
 *   Cal.com (gated on CALCOM_SYNC_ENABLED):
 *     1. Outbox depth > 100 for 5+ consecutive checks.
 *     2. Cal.com circuit breaker open.
 *     3. Inbox processing errors > 5 in the last 24h.
 *     4. Cal.com daily quota threshold.
 *     5. Outbox dead-letter rows in the last 24h.
 *
 *   KDS (always on when ANY slack webhook is configured):
 *     6. Oldest pending order > 10 min — line cook hasn't picked it up.
 *     7. No kitchen tablet heartbeat in 5 min — display likely offline
 *        (only after at least one tablet has EVER checked in, so we
 *        don't alert on a venue that hasn't installed the kiosk yet).
 *
 * Posts to `OPS_SLACK_WEBHOOK_URL`. No-op when the env is unset.
 * Edge-triggered: only post when a threshold NEWLY crosses, so Slack
 * doesn't spam. Recovery messages confirm thresholds dropped back.
 *
 * Single-process; state is in-memory. After a container restart the
 * "already alerted" state is lost — first check may re-alert on
 * persistent issues. Acceptable for a single-tenant deploy.
 */

import { env } from "../config/env";
import { pool } from "../db/pool";
import { getInboxStats } from "../repositories/inbox";
import { getOutboxStats } from "../repositories/outbox";
import { getOnboardingFunnel } from "../repositories/restaurants";
import { getBreakerState } from "../services/calcomClient";
import { quotaSnapshot, shouldFireQuotaAlert } from "../services/calcomQuotaTracker";
import { kdsHealthSnapshot } from "../services/orderService";
import { retellAuthSnapshot } from "../services/retellAuthHealth";
import { getKdsHeartbeats } from "../routes/orders";
import { logger } from "../utils/logger";

const CHECK_INTERVAL_MS = 60_000; // every minute
const OUTBOX_DEPTH_THRESHOLD = 100;
const OUTBOX_DEPTH_CONSECUTIVE_CHECKS = 5; // ≥ 5 min lag before pinging
const INBOX_FAILURES_THRESHOLD = 5;
// Audit L4: any permanent-failed outbox row in the last 24h means a Cal.com
// push hit MAX_ATTEMPTS and stopped retrying — there's a reservation in
// Postgres that never reached Cal.com. Alert immediately, no debounce.
const OUTBOX_DEAD_LETTER_THRESHOLD = 0;

// KDS thresholds. A pending order in the kitchen > 10 min is a service
// emergency on a busy night — the cook lost track or the printer/display died.
const KDS_OLDEST_PENDING_SECONDS = 10 * 60;
// Tablets ping at 60s. Five minutes of silence = either the tablet is offline
// or the wifi is down. Either way, the kitchen is flying blind.
const KDS_TABLET_SILENCE_MS = 5 * 60 * 1000;

// Retell signed-surface auth failures. A wrong / stale / non-webhook-badged
// RETELL_API_KEY 401s every tool call — the agent picks up and talks, but no
// booking is ever written. 3 failures in the 5-min window = a real outage, not
// a one-off. Edge-triggered with a recovery message.
const RETELL_AUTH_FAILURE_THRESHOLD = 3;

interface AlertState {
  outboxDepthBreaches: number;
  outboxDepthAlerted: boolean;
  breakerAlerted: boolean;
  inboxFailuresAlerted: boolean;
  outboxDeadLetterCount: number;
  outboxDeadLetterAlerted: boolean;
  kdsOldestPendingAlerted: boolean;
  kdsTabletOfflineAlerted: boolean;
  // Sticky flag: once a tablet has EVER checked in, future silence is a real
  // outage, not "the kiosk was never installed". Survives across ticks, resets
  // only on process restart.
  kdsHasSeenAnyHeartbeat: boolean;
  // Retell signed-surface 401/403 storm (wrong/stale RETELL_API_KEY).
  retellAuthAlerted: boolean;
  // D1: UTC day-key of the last onboarding-funnel summary posted, so it fires
  // at most once per day (the alerter ticks every minute).
  funnelSummaryDayKey: string | null;
  // The money-path queues. Every one of these represents a customer who has
  // PAID and is stuck: a failed provisioning job is a restaurant with no phone
  // number, an unprocessed Stripe event is a subscription we never acted on,
  // and a failed notification is a verification code that never arrived.
  // None of them were monitored — a paid-but-never-provisioned customer was
  // invisible until they emailed us.
  provisioningStuckAlerted: boolean;
  notificationsStuckAlerted: boolean;
  stripeUnprocessedAlerted: boolean;
}

const state: AlertState = {
  outboxDepthBreaches: 0,
  outboxDepthAlerted: false,
  breakerAlerted: false,
  inboxFailuresAlerted: false,
  outboxDeadLetterCount: 0,
  outboxDeadLetterAlerted: false,
  kdsOldestPendingAlerted: false,
  kdsTabletOfflineAlerted: false,
  kdsHasSeenAnyHeartbeat: false,
  retellAuthAlerted: false,
  funnelSummaryDayKey: null,
  provisioningStuckAlerted: false,
  notificationsStuckAlerted: false,
  stripeUnprocessedAlerted: false
};

// D1: how the onboarding funnel reads in the daily summary. Ordered by the
// real signup sequence so a glance shows where signups pile up / drop off.
const FUNNEL_ORDER = [
  "account_created",
  "profile",
  "menu",
  "trial",
  "provisioning",
  "live",
  "suspended",
  "cancelled"
] as const;
// Only count the live operational restaurant(s) toward "noise" — fire the
// summary once we send it for the day, regardless of counts, so a stall at a
// given step is always visible. Skips the report entirely if there are no
// in-progress signups (every restaurant is live), to avoid daily no-op spam.
const FUNNEL_IN_PROGRESS = ["account_created", "profile", "menu", "trial", "provisioning"] as const;

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let currentTick: Promise<void> | null = null;

async function postToSlack(text: string): Promise<void> {
  if (!env.OPS_SLACK_WEBHOOK_URL) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(env.OPS_SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (error) {
    // Don't crash the alerter if Slack is down. Log and move on.
    logger.warn({ evt: "health_alerter_slack_post_failed", error: (error as Error).message });
  }
}

async function checkKds(): Promise<void> {
  try {
    const kds = await kdsHealthSnapshot(env.DEFAULT_RESTAURANT_ID);

    // 6) Oldest pending order age. Voice-created orders that the kitchen
    //    hasn't picked up — line cook checked out, kiosk locked, tablet
    //    dropped. Edge-triggered with a recovery message.
    if (
      kds.oldest_pending_order_age_seconds !== null &&
      kds.oldest_pending_order_age_seconds > KDS_OLDEST_PENDING_SECONDS
    ) {
      if (!state.kdsOldestPendingAlerted) {
        const mins = Math.floor(kds.oldest_pending_order_age_seconds / 60);
        await postToSlack(
          `:fire: Kitchen has a ${mins}-min old PENDING order. Check the wall display or call the line.`
        );
        state.kdsOldestPendingAlerted = true;
      }
    } else if (state.kdsOldestPendingAlerted) {
      await postToSlack(`:white_check_mark: Kitchen pending queue cleared.`);
      state.kdsOldestPendingAlerted = false;
    }

    // 7) Tablet heartbeat. Each kiosk pings every 60s. We only alert AFTER
    //    we've ever seen at least one heartbeat — otherwise a venue that
    //    hasn't deployed the kiosk yet would page on every check.
    const heartbeats = getKdsHeartbeats();
    if (heartbeats.length > 0) {
      state.kdsHasSeenAnyHeartbeat = true;
    }
    const allTabletsSilent =
      state.kdsHasSeenAnyHeartbeat &&
      (heartbeats.length === 0 ||
        heartbeats.every((h) => h.last_seen_ms_ago > KDS_TABLET_SILENCE_MS));
    if (allTabletsSilent) {
      if (!state.kdsTabletOfflineAlerted) {
        await postToSlack(
          `:rotating_light: No kitchen tablet has checked in for 5+ min. Kitchen is flying blind — check the wall display.`
        );
        state.kdsTabletOfflineAlerted = true;
      }
    } else if (state.kdsTabletOfflineAlerted) {
      await postToSlack(`:white_check_mark: Kitchen tablet back online.`);
      state.kdsTabletOfflineAlerted = false;
    }
  } catch (error) {
    logger.warn({ evt: "health_alerter_kds_check_failed", error: (error as Error).message });
  }
}

async function checkCalcom(): Promise<void> {
  try {
    const [outbox, inbox] = await Promise.all([getOutboxStats(), getInboxStats()]);
    const breaker = getBreakerState();

    // 1) Outbox depth — require sustained breach to avoid noise from a
    //    brief Cal.com hiccup that the worker drains within a minute.
    if (outbox.pendingDepth > OUTBOX_DEPTH_THRESHOLD) {
      state.outboxDepthBreaches += 1;
      if (
        state.outboxDepthBreaches >= OUTBOX_DEPTH_CONSECUTIVE_CHECKS &&
        !state.outboxDepthAlerted
      ) {
        await postToSlack(
          `:warning: VoxTable outbox depth = ${outbox.pendingDepth} (oldest ${
            outbox.oldestPendingAt ?? "n/a"
          }). Cal.com mirror is lagging.`
        );
        state.outboxDepthAlerted = true;
      }
    } else {
      if (state.outboxDepthAlerted) {
        await postToSlack(
          `:white_check_mark: VoxTable outbox depth recovered (now ${outbox.pendingDepth}).`
        );
      }
      state.outboxDepthBreaches = 0;
      state.outboxDepthAlerted = false;
    }

    // 2) Circuit breaker open — immediate, no debounce. Half-open is fine.
    if (breaker.state === "open") {
      if (!state.breakerAlerted) {
        await postToSlack(
          `:rotating_light: Cal.com circuit breaker OPEN after ${breaker.consecutiveFailures} consecutive failures. Outbox will retry once the breaker closes.`
        );
        state.breakerAlerted = true;
      }
    } else if (state.breakerAlerted) {
      await postToSlack(`:white_check_mark: Cal.com circuit breaker closed.`);
      state.breakerAlerted = false;
    }

    // 3b) Outbox dead-letter rows — any row that hit CALCOM_OUTBOX_MAX_ATTEMPTS
    //     and was marked permanently failed in the last 24h. Edge-triggered:
    //     only ping when the count grows. Resets daily as `failed_last_24h`
    //     decays.
    if (outbox.failedLast24h > OUTBOX_DEAD_LETTER_THRESHOLD) {
      if (outbox.failedLast24h > state.outboxDeadLetterCount && !state.outboxDeadLetterAlerted) {
        await postToSlack(
          `:rotating_light: Cal.com outbox dead-letter: ${outbox.failedLast24h} reservation(s) failed to sync in the last 24h. Check /api/ops/calcom-health and outbox_calcom for stuck rows.`
        );
        state.outboxDeadLetterAlerted = true;
      }
      state.outboxDeadLetterCount = outbox.failedLast24h;
    } else {
      state.outboxDeadLetterCount = 0;
      state.outboxDeadLetterAlerted = false;
    }

    // 3) Inbox failures — immediate, no debounce. Threshold counts last 24h.
    if (inbox.failuresLast24h > INBOX_FAILURES_THRESHOLD) {
      if (!state.inboxFailuresAlerted) {
        await postToSlack(
          `:warning: Cal.com inbox failures: ${inbox.failuresLast24h} in the last 24h. Check /api/ops/calcom-health.`
        );
        state.inboxFailuresAlerted = true;
      }
    } else if (state.inboxFailuresAlerted) {
      // Don't post a recovery for inbox failures — they decay naturally with
      // the 24h window.
      state.inboxFailuresAlerted = false;
    }

    // 4) Cal.com daily quota — edge-triggered alert (once per UTC day).
    //    Audit Sweep I. Catches runaway-loop scenarios where the outbox
    //    retry budget burns the Cal.com rate limit before we notice.
    if (shouldFireQuotaAlert()) {
      const snap = quotaSnapshot();
      await postToSlack(
        `:warning: Cal.com API quota: ${snap.count} / ${snap.daily_threshold} requests today (UTC ${snap.day_key}). Window opened ${snap.window_started_at}. Investigate if outbox is healthy.`
      );
    }
  } catch (error) {
    logger.warn({ evt: "health_alerter_calcom_check_failed", error: (error as Error).message });
  }
}

async function checkRetellAuth(): Promise<void> {
  try {
    const snap = retellAuthSnapshot();

    // 8) Retell auth-failure storm. The voice agent answers normally but every
    //    tool call 401s at the signature gate, so bookings silently vanish.
    //    This is the exact failure mode that hid the "number busy / no booking"
    //    incident. Page immediately once the threshold trips.
    if (snap.failures_last_5min >= RETELL_AUTH_FAILURE_THRESHOLD) {
      if (!state.retellAuthAlerted) {
        await postToSlack(
          `:rotating_light: Retell tool calls failing auth — ${snap.failures_last_5min} × 401/403 on /retell/* in the last 5 min. The agent answers but NO booking is being written. Check RETELL_API_KEY (must be the webhook-badged key) and the number's webhook/agent binding in Retell.`
        );
        state.retellAuthAlerted = true;
      }
    } else if (state.retellAuthAlerted && snap.failures_last_5min === 0) {
      await postToSlack(
        `:white_check_mark: Retell tool-call auth recovered — no 401/403 on /retell/* in the last 5 min.`
      );
      state.retellAuthAlerted = false;
    }
  } catch (error) {
    logger.warn({ evt: "health_alerter_retell_auth_check_failed", error: (error as Error).message });
  }
}

// D1: once-per-UTC-day onboarding funnel summary. Posts a per-status snapshot so
// stalls/drop-off are visible without opening the admin console. Edge-gated on
// the UTC day-key so it fires at most once per day even though the alerter ticks
// every minute. Skips entirely when no signups are in progress (every
// restaurant is live) to avoid a daily no-op message.
async function checkOnboardingFunnel(): Promise<void> {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (state.funnelSummaryDayKey === todayKey) return;

    const funnel = await getOnboardingFunnel();
    const inProgress = FUNNEL_IN_PROGRESS.reduce((sum, k) => sum + (funnel[k] ?? 0), 0);
    // Mark the day done even when we skip, so we don't re-query every minute.
    state.funnelSummaryDayKey = todayKey;
    if (inProgress === 0) return;

    const line = FUNNEL_ORDER.filter((k) => (funnel[k] ?? 0) > 0)
      .map((k) => `${k}: ${funnel[k]}`)
      .join(" · ");
    await postToSlack(
      `:bar_chart: Onboarding funnel (${todayKey} UTC): ${line}. ${inProgress} restaurant(s) mid-signup.`
    );
  } catch (error) {
    logger.warn({ evt: "health_alerter_funnel_summary_failed", error: (error as Error).message });
  }
}

/**
 * 9) The paid-customer queues. Every row these count is a customer who has
 *    already given us money and is silently stuck:
 *
 *    - a `failed` provisioning job  → they paid, and have no phone number
 *    - an unprocessed Stripe event  → we took a payment and never acted on it
 *    - a `failed` notification      → an email nobody received (including the
 *                                     signup verification codes)
 *
 *    None of this was monitored. The bug that made every paying customer stall
 *    at the menu step produced a permanent webhook-retry loop and left zero
 *    trace anywhere — we would only have learned about it from the customer.
 *    Edge-triggered with a recovery message, same shape as the checks above.
 */
async function checkPaidCustomerQueues(): Promise<void> {
  try {
    const { rows } = await pool.query<{
      provisioning_stuck: string;
      notifications_failed: string;
      stripe_unprocessed: string;
    }>(
      `SELECT
         (SELECT count(*) FROM provisioning_jobs
           WHERE status = 'failed'
              OR (status = 'processing' AND updated_at < now() - interval '30 minutes')
         ) AS provisioning_stuck,
         (SELECT count(*) FROM notifications_outbox
           WHERE status = 'failed' AND created_at > now() - interval '24 hours'
         ) AS notifications_failed,
         -- Uses idx_stripe_webhook_events_unprocessed (010_billing_webhook.sql),
         -- which was created for exactly this query and had no reader until now.
         (SELECT count(*) FROM stripe_webhook_events
           WHERE processed_at IS NULL AND received_at < now() - interval '15 minutes'
         ) AS stripe_unprocessed`
    );
    const counts = rows[0];
    if (!counts) return;

    const provisioningStuck = Number(counts.provisioning_stuck);
    const notificationsFailed = Number(counts.notifications_failed);
    const stripeUnprocessed = Number(counts.stripe_unprocessed);

    if (provisioningStuck > 0 && !state.provisioningStuckAlerted) {
      await postToSlack(
        `:rotating_light: ${provisioningStuck} provisioning job(s) stuck or failed. These are PAYING customers with no phone number. Check \`provisioning_jobs\` (last_error) — and if the failure mentions a purchase started but never recorded, check the Twilio console for an unassigned AU number BEFORE retrying.`
      );
      state.provisioningStuckAlerted = true;
    } else if (provisioningStuck === 0 && state.provisioningStuckAlerted) {
      await postToSlack(`:white_check_mark: Provisioning queue clear — no stuck or failed jobs.`);
      state.provisioningStuckAlerted = false;
    }

    if (stripeUnprocessed > 0 && !state.stripeUnprocessedAlerted) {
      await postToSlack(
        `:rotating_light: ${stripeUnprocessed} Stripe webhook event(s) unprocessed for >15 min. We may have taken payments without acting on them — subscriptions can be active in Stripe while the tenant never goes live. Check \`stripe_webhook_events.last_error\`.`
      );
      state.stripeUnprocessedAlerted = true;
    } else if (stripeUnprocessed === 0 && state.stripeUnprocessedAlerted) {
      await postToSlack(`:white_check_mark: Stripe webhook backlog clear.`);
      state.stripeUnprocessedAlerted = false;
    }

    if (notificationsFailed > 0 && !state.notificationsStuckAlerted) {
      await postToSlack(
        `:warning: ${notificationsFailed} notification(s) failed permanently in the last 24h. Signup verification codes ride this queue, so new signups may be blocked. Check \`notifications_outbox.last_error\`.`
      );
      state.notificationsStuckAlerted = true;
    } else if (notificationsFailed === 0 && state.notificationsStuckAlerted) {
      await postToSlack(`:white_check_mark: Notification queue clear — no permanent failures in the last 24h.`);
      state.notificationsStuckAlerted = false;
    }
  } catch (error) {
    logger.warn({ evt: "health_alerter_paid_queue_check_failed", error: (error as Error).message });
  }
}

async function checkOnce(): Promise<void> {
  // KDS + Retell auth always run when slack is configured. Cal.com gated by its
  // env flag.
  await checkKds();
  await checkRetellAuth();
  await checkOnboardingFunnel();
  await checkPaidCustomerQueues();
  if (env.CALCOM_SYNC_ENABLED) {
    await checkCalcom();
  }
}

export function startHealthAlerter(): void {
  // Slack webhook is the only hard requirement now. KDS rules are valuable
  // even when Cal.com sync is off (single-tenant venues that don't mirror).
  if (!env.OPS_SLACK_WEBHOOK_URL) {
    logger.info({ evt: "health_alerter_not_started", reason: "no OPS_SLACK_WEBHOOK_URL" });
    return;
  }
  if (intervalHandle !== null) return;
  logger.info({
    evt: "health_alerter_starting",
    check_interval_ms: CHECK_INTERVAL_MS,
    calcom_enabled: env.CALCOM_SYNC_ENABLED
  });
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    currentTick = checkOnce().finally(() => {
      tickInFlight = false;
      currentTick = null;
    });
  }, CHECK_INTERVAL_MS);
  intervalHandle.unref();
}

export async function stopHealthAlerter(): Promise<void> {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentTick) {
    await currentTick.catch(() => {});
  }
}
