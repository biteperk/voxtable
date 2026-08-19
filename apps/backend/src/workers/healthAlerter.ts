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
import { quotaSnapshotFromDb } from "../services/calcomQuotaTracker";
import { kdsHealthSnapshot } from "../services/orderService";
import { retellAuthSnapshot } from "../services/retellAuthHealth";
import { getKdsHeartbeats } from "../services/kdsHeartbeats";
import { getOpsState, setOpsState } from "../repositories/opsState";
import { OpeningHours } from "../domain/types";
import { logger, withTickLogContext } from "../utils/logger";
import { registerTickExpectation } from "../utils/tickPulse";
import {
  getOpeningWindowsForDate,
  nowTimeInTz,
  todayInTz,
  toMinutes,
  zonedWallClockToUtcISO
} from "../utils/time";

const CHECK_INTERVAL_MS = 60_000; // every minute
const OUTBOX_DEPTH_THRESHOLD = 100;
const OUTBOX_DEPTH_CONSECUTIVE_CHECKS = 5; // ≥ 5 min lag before pinging
// Was 5, which meant five guests could each be holding a Cal.com confirmation
// for a table nobody knew about before anyone was told. A retried failure is
// now normal and self-healing (calcomInboxWorker), so the interesting number is
// dead letters, not attempts — and one of those is one guest too many.
const INBOX_FAILURES_THRESHOLD = 5;
const INBOX_DEAD_LETTER_THRESHOLD = 0;
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

// Business-outcome thresholds. The auth-storm alert above only catches the
// signature-gate variant of "Bella answers but nothing books" — a prompt
// regression, tool-schema drift, or a booking_outcome=failed streak produced
// zero alerts. These two watch the OUTCOME instead of a mechanism:
//   - calls arriving but zero bookings written across a full hour, and
//   - a venue with configured opening hours that is deep into service with
//     zero calls at all (dead number, broken SIP forward, Retell outage).
const NO_BOOKINGS_WINDOW_MINUTES = 60;
const NO_BOOKINGS_MIN_CALLS = 3;
const ZERO_CALLS_MIN_HOURS_INTO_SERVICE = 4;

interface AlertState {
  outboxDepthBreaches: number;
  outboxDepthAlerted: boolean;
  breakerAlerted: boolean;
  inboxFailuresAlerted: boolean;
  inboxDeadLetterAlerted: boolean;
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
  menuImportsFailedAlerted: boolean;
  // UTC day the Cal.com quota alert last fired for — once per day, and the
  // latch survives a restart like every other latch here (the old version
  // lived inside calcomQuotaTracker's module memory and re-fired on redeploy).
  quotaAlertedDayKey: string | null;
  // Business outcomes: calls-but-no-bookings (edge-triggered with recovery),
  // and per-venue "silent all service" latches as "restaurantId:dayKey"
  // entries so each venue alerts at most once per day.
  noBookingsAlerted: boolean;
  zeroCallsAlertedKeys: string[];
  // Voice-order payments: rows the reaper couldn't resolve (webhook wiring
  // broken), disputes (they debit the PLATFORM account on destination
  // charges), and money-vs-order divergence (amount mismatch / paid after
  // cancel) that needs a human decision.
  orderPaymentsStuckAlerted: boolean;
  orderPaymentsDisputeAlerted: boolean;
  orderPaymentsMismatchAlerted: boolean;
}

const DEFAULT_STATE: AlertState = {
  outboxDepthBreaches: 0,
  outboxDepthAlerted: false,
  breakerAlerted: false,
  inboxFailuresAlerted: false,
  inboxDeadLetterAlerted: false,
  outboxDeadLetterCount: 0,
  outboxDeadLetterAlerted: false,
  kdsOldestPendingAlerted: false,
  kdsTabletOfflineAlerted: false,
  kdsHasSeenAnyHeartbeat: false,
  retellAuthAlerted: false,
  funnelSummaryDayKey: null,
  provisioningStuckAlerted: false,
  notificationsStuckAlerted: false,
  stripeUnprocessedAlerted: false,
  menuImportsFailedAlerted: false,
  quotaAlertedDayKey: null,
  noBookingsAlerted: false,
  zeroCallsAlertedKeys: [],
  orderPaymentsStuckAlerted: false,
  orderPaymentsDisputeAlerted: false,
  orderPaymentsMismatchAlerted: false
};

const state: AlertState = { ...DEFAULT_STATE };

// The edge-trigger latches used to be memory-only, so every worker restart
// re-posted every open alert and the once-a-day funnel summary. They now
// round-trip through ops_state: loaded before each tick, saved after. Only
// keys present in the stored row are applied, so adding a latch later needs
// no migration and a corrupt row degrades to the defaults.
const LATCHES_KEY = "health-alerter-latches";

async function loadAlertLatches(): Promise<void> {
  const stored = await getOpsState(LATCHES_KEY);
  if (!stored) return;
  for (const key of Object.keys(DEFAULT_STATE) as Array<keyof AlertState>) {
    const value = stored[key];
    const isValid =
      key === "zeroCallsAlertedKeys"
        ? Array.isArray(value) && value.every((entry) => typeof entry === "string")
        : key === "funnelSummaryDayKey" || key === "quotaAlertedDayKey"
          ? value === null || typeof value === "string"
          : typeof value === typeof DEFAULT_STATE[key];
    if (isValid) {
      (state as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

async function saveAlertLatches(): Promise<void> {
  await setOpsState(LATCHES_KEY, { ...state });
}

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
    const heartbeats = await getKdsHeartbeats(env.DEFAULT_RESTAURANT_ID);
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

    // 3b) A dead-lettered inbound event is a booking we accepted from Cal.com
    //     and could not honour after every retry. Unlike a failure count, this
    //     does not decay into nothing: someone is expecting a table. Alert on
    //     the first one, no debounce, same posture as the outbox dead letter.
    if (inbox.deadLetteredLast24h > INBOX_DEAD_LETTER_THRESHOLD) {
      if (!state.inboxDeadLetterAlerted) {
        await postToSlack(
          `:rotating_light: Cal.com inbound bookings dead-lettered: ${inbox.deadLetteredLast24h} in the last 24h. ` +
            `Each one is a guest holding a confirmation for a table we have no record of. ` +
            `Payloads are kept in inbox_calcom_events (failed_at IS NOT NULL).`
        );
        state.inboxDeadLetterAlerted = true;
      }
    } else if (state.inboxDeadLetterAlerted) {
      state.inboxDeadLetterAlerted = false;
    }

    // 4) Cal.com daily quota — edge-triggered alert (once per UTC day).
    //    Audit Sweep I. Catches runaway-loop scenarios where the outbox
    //    retry budget burns the Cal.com rate limit before we notice. Reads
    //    the ops_state counter (survives restarts — the crashy runaway that
    //    burns quota is exactly the one that restarts workers) and latches
    //    on the day key alongside the other restart-surviving latches.
    const quota = await quotaSnapshotFromDb();
    if (quota.above_threshold && state.quotaAlertedDayKey !== quota.day_key) {
      await postToSlack(
        `:warning: Cal.com API quota: ${quota.count} / ${quota.daily_threshold} requests today (UTC ${quota.day_key}). Investigate if outbox is healthy.`
      );
      state.quotaAlertedDayKey = quota.day_key;
    } else if (!quota.above_threshold && state.quotaAlertedDayKey !== null && state.quotaAlertedDayKey !== quota.day_key) {
      // A new UTC day under the threshold — clear the latch so the next
      // breach fires again.
      state.quotaAlertedDayKey = null;
    }
  } catch (error) {
    logger.warn({ evt: "health_alerter_calcom_check_failed", error: (error as Error).message });
  }
}

async function checkRetellAuth(): Promise<void> {
  try {
    const snap = await retellAuthSnapshot();

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
      menu_imports_failed: string;
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
         ) AS stripe_unprocessed,
         -- A failed menu import is an owner stuck mid-onboarding who has just
         -- been told to type their whole menu by hand. Nothing watched this.
         (SELECT count(*) FROM menu_ingestion_jobs
           WHERE status = 'failed' AND created_at > now() - interval '24 hours'
         ) AS menu_imports_failed`
    );
    const counts = rows[0];
    if (!counts) return;

    const provisioningStuck = Number(counts.provisioning_stuck);
    const notificationsFailed = Number(counts.notifications_failed);
    const stripeUnprocessed = Number(counts.stripe_unprocessed);
    const menuImportsFailed = Number(counts.menu_imports_failed);

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

    if (menuImportsFailed > 0 && !state.menuImportsFailedAlerted) {
      await postToSlack(
        `:warning: ${menuImportsFailed} menu import(s) failed in the last 24h. Each one is an owner mid-onboarding who has just been told to type their menu by hand. Check \`menu_ingestion_jobs.last_error\` — a repeated cause usually means a menu layout the parser can't read.`
      );
      state.menuImportsFailedAlerted = true;
    } else if (menuImportsFailed === 0 && state.menuImportsFailedAlerted) {
      await postToSlack(`:white_check_mark: Menu imports clear — none failed in the last 24h.`);
      state.menuImportsFailedAlerted = false;
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

// Voice-order payment links. Guarded like the cleanup worker's phase guards:
// on a pre-030 database (VM window before the migration applies) the table
// doesn't exist and this check quietly skips instead of spamming warnings.
async function checkOrderPayments(): Promise<void> {
  try {
    const { rows } = await pool.query<{
      stuck: string;
      disputes: string;
      mismatches: string;
    }>(
      `SELECT
         -- Active rows >30 min past expiry: the reaper (5-min tick) should
         -- have resolved these against Stripe — if they persist, webhook
         -- delivery AND the reaper are both failing.
         (SELECT count(*) FROM order_payments
           WHERE status IN ('created','sent','processing')
             AND expires_at IS NOT NULL
             AND expires_at < now() - interval '30 minutes'
         ) AS stuck,
         (SELECT count(*) FROM order_payments
           WHERE status = 'disputed' AND updated_at > now() - interval '24 hours'
         ) AS disputes,
         -- Money-vs-order divergence: guest paid but the order isn't settled —
         -- amount mismatch (order edited after the link went out) or paid
         -- after cancellation. Both need a human refund/adjust decision.
         (SELECT count(*) FROM order_payments p
           WHERE p.status = 'paid'
             AND p.updated_at > now() - interval '24 hours'
             AND EXISTS (
               SELECT 1 FROM orders o
                WHERE o.id = p.order_id
                  AND (o.payment_status <> 'paid' OR o.status = 'cancelled')
             )
         ) AS mismatches`
    );
    const counts = rows[0];
    if (!counts) return;

    const stuck = Number(counts.stuck);
    const disputes = Number(counts.disputes);
    const mismatches = Number(counts.mismatches);

    if (stuck > 0 && !state.orderPaymentsStuckAlerted) {
      await postToSlack(
        `:rotating_light: ${stuck} order payment link(s) unresolved >30 min past expiry. The reaper should have settled these against Stripe — if this persists, Stripe webhook delivery AND the reaper are both failing. Check \`order_payments.last_error\` and the /stripe/webhook endpoint.`
      );
      state.orderPaymentsStuckAlerted = true;
    } else if (stuck === 0 && state.orderPaymentsStuckAlerted) {
      await postToSlack(`:white_check_mark: Order payment links clear — nothing stuck past expiry.`);
      state.orderPaymentsStuckAlerted = false;
    }

    if (disputes > 0 && !state.orderPaymentsDisputeAlerted) {
      await postToSlack(
        `:rotating_light: ${disputes} guest payment(s) disputed in the last 24h. Destination-charge disputes debit the BITEPERK platform account, not the venue's. Respond in the Stripe dashboard; the transfer reversal is a manual decision.`
      );
      state.orderPaymentsDisputeAlerted = true;
    } else if (disputes === 0 && state.orderPaymentsDisputeAlerted) {
      await postToSlack(`:white_check_mark: No new payment disputes in the last 24h.`);
      state.orderPaymentsDisputeAlerted = false;
    }

    if (mismatches > 0 && !state.orderPaymentsMismatchAlerted) {
      await postToSlack(
        `:warning: ${mismatches} guest payment(s) received that don't settle their order — amount mismatch (order edited after the link was texted) or paid after cancellation. The money is in Stripe; the order is NOT marked paid. Needs a manual refund-or-adjust call. Check \`order_payments.last_error\`.`
      );
      state.orderPaymentsMismatchAlerted = true;
    } else if (mismatches === 0 && state.orderPaymentsMismatchAlerted) {
      await postToSlack(`:white_check_mark: Guest payments reconcile cleanly again.`);
      state.orderPaymentsMismatchAlerted = false;
    }
  } catch (error) {
    // 42P01 = table missing (pre-030 database) — expected during the rollout
    // window, skip quietly. Anything else is worth a structured warn.
    if ((error as { code?: string }).code === "42P01") return;
    logger.warn({ evt: "health_alerter_order_payments_check_failed", error: (error as Error).message });
  }
}

// How far into today's service a venue is right now, or null when closed /
// no hours configured. Pure so the DST-heavy cases are unit-testable.
// Overnight windows (close <= open, e.g. 18:00–02:00) count the morning leg
// as a continuation of yesterday's service — serviceOpenDate points at the
// calendar day the window OPENED, which is what the calls-since-open query
// needs to build a UTC boundary.
export function serviceProgressNow(
  openingHours: OpeningHours,
  timeZone: string,
  now: Date = new Date()
): { hoursIntoService: number; serviceOpenDate: string; serviceOpenTime: string } | null {
  const localDate = todayInTz(timeZone, now);
  const nowMinutes = toMinutes(nowTimeInTz(timeZone, now));

  const yesterdayOf = (date: string): string => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
  };

  for (const window of getOpeningWindowsForDate(localDate, openingHours)) {
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);
    if (close === open) continue; // degenerate "closed all day"
    if (close > open) {
      if (nowMinutes >= open && nowMinutes < close) {
        return {
          hoursIntoService: (nowMinutes - open) / 60,
          serviceOpenDate: localDate,
          serviceOpenTime: window.open
        };
      }
    } else if (nowMinutes >= open) {
      // Evening leg of an overnight window.
      return {
        hoursIntoService: (nowMinutes - open) / 60,
        serviceOpenDate: localDate,
        serviceOpenTime: window.open
      };
    }
  }

  // Morning leg of YESTERDAY'S overnight window (e.g. 00:30 during 18:00–02:00).
  for (const window of getOpeningWindowsForDate(yesterdayOf(localDate), openingHours)) {
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);
    if (close < open && nowMinutes < close) {
      return {
        hoursIntoService: (nowMinutes + 1440 - open) / 60,
        serviceOpenDate: yesterdayOf(localDate),
        serviceOpenTime: window.open
      };
    }
  }

  return null;
}

// Exported for the business-alerts smoke: calls and bookings landed in the
// trailing window, across all venues.
export async function bookingActivitySnapshot(
  windowMinutes: number = NO_BOOKINGS_WINDOW_MINUTES
): Promise<{ calls: number; bookings: number }> {
  const result = await pool.query<{ calls: string; bookings: string }>(
    `SELECT
       (SELECT count(*) FROM call_logs
         WHERE created_at >= now() - $1::int * interval '1 minute') AS calls,
       (SELECT count(*) FROM reservations
         WHERE created_at >= now() - $1::int * interval '1 minute') AS bookings`,
    [windowMinutes]
  );
  return {
    calls: Number(result.rows[0]?.calls ?? 0),
    bookings: Number(result.rows[0]?.bookings ?? 0)
  };
}

// Exported for the business-alerts smoke: venues that are configured with
// opening hours, are at least ZERO_CALLS_MIN_HOURS_INTO_SERVICE into today's
// service, and have not logged a single call since service opened. Venues
// with empty hours ({} is the column default) are skipped — alerting every
// quiet venue that never configured hours would page-spam and get muted.
export async function restaurantsSilentDuringService(
  now: Date = new Date()
): Promise<Array<{ restaurant_id: string; name: string; hours_into_service: number }>> {
  const venues = await pool.query<{
    id: string;
    name: string;
    timezone: string;
    opening_hours_json: OpeningHours;
  }>(
    `SELECT r.id, r.name, r.timezone, s.opening_hours_json
       FROM restaurants r
       JOIN restaurant_settings s ON s.restaurant_id = r.id
      WHERE s.opening_hours_json <> '{}'::jsonb`
  );

  const silent: Array<{ restaurant_id: string; name: string; hours_into_service: number }> = [];
  for (const venue of venues.rows) {
    const progress = serviceProgressNow(venue.opening_hours_json, venue.timezone, now);
    if (!progress || progress.hoursIntoService < ZERO_CALLS_MIN_HOURS_INTO_SERVICE) continue;

    const serviceStartUtc = zonedWallClockToUtcISO(
      progress.serviceOpenDate,
      progress.serviceOpenTime,
      venue.timezone
    );
    const calls = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM call_logs
        WHERE restaurant_id = $1 AND created_at >= $2::timestamptz`,
      [venue.id, serviceStartUtc]
    );
    if (Number(calls.rows[0]?.n ?? 0) === 0) {
      silent.push({
        restaurant_id: venue.id,
        name: venue.name,
        hours_into_service: progress.hoursIntoService
      });
    }
  }
  return silent;
}

async function checkBusinessOutcomes(): Promise<void> {
  try {
    // 9) Calls arriving but nothing books. The auth-storm alert catches the
    //    signature-gate variant; this one is mechanism-blind — whatever broke
    //    the funnel, the outcome is calls with no bookings for an hour.
    const activity = await bookingActivitySnapshot();
    if (activity.calls >= NO_BOOKINGS_MIN_CALLS && activity.bookings === 0) {
      if (!state.noBookingsAlerted) {
        await postToSlack(
          `:rotating_light: ${activity.calls} call(s) in the last ${NO_BOOKINGS_WINDOW_MINUTES} min and ZERO bookings written. Bella may be answering while every booking silently fails — check /retell tool logs and booking_outcome in call_logs.`
        );
        state.noBookingsAlerted = true;
      }
    } else if (state.noBookingsAlerted && activity.bookings > 0) {
      await postToSlack(
        `:white_check_mark: Bookings are being written again (${activity.bookings} in the last ${NO_BOOKINGS_WINDOW_MINUTES} min).`
      );
      state.noBookingsAlerted = false;
    }

    // 10) A venue deep into service with zero calls at all — dead number,
    //     broken SIP forward, or a Retell-side outage. Once per venue per day.
    const dayKey = new Date().toISOString().slice(0, 10);
    const silent = await restaurantsSilentDuringService();
    for (const venue of silent) {
      const latchEntry = `${venue.restaurant_id}:${dayKey}`;
      if (state.zeroCallsAlertedKeys.includes(latchEntry)) continue;
      await postToSlack(
        `:rotating_light: ${venue.name} is ${venue.hours_into_service.toFixed(1)}h into service with ZERO calls today. The phone line may be dead — dial the number and check the Twilio + Retell consoles.`
      );
      // Keep only today's entries so the latch list can't grow forever.
      state.zeroCallsAlertedKeys = [
        ...state.zeroCallsAlertedKeys.filter((entry) => entry.endsWith(dayKey)),
        latchEntry
      ];
    }
  } catch (error) {
    logger.warn({ evt: "health_alerter_business_check_failed", error: (error as Error).message });
  }
}

// The dead-man's switch: a GET that says "the worker's alert loop ran". The
// external service (healthchecks.io-style) alerts when these STOP — covering
// the failure mode every in-process alert shares: the process that would
// have alerted is dead, and until this existed every probe ran on the same
// box it was probing. Exported (with url injectable) for the unit test.
export async function pingHeartbeat(url: string | undefined = env.OPS_HEARTBEAT_URL): Promise<void> {
  if (!url) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
  } catch (error) {
    logger.warn({ evt: "health_alerter_heartbeat_failed", error: (error as Error).message });
  }
}

async function checkOnce(): Promise<void> {
  // Latches round-trip through ops_state so a worker restart doesn't re-page
  // every open alert. A failed load runs the tick on current in-memory state
  // (worst case: one duplicate page); a failed save is logged and retried by
  // the next tick's save.
  try {
    await loadAlertLatches();
  } catch (error) {
    logger.warn({ evt: "health_alerter_latch_load_failed", error: (error as Error).message });
  }

  // KDS + Retell auth always run when slack is configured. Cal.com gated by its
  // env flag.
  await checkKds();
  await checkRetellAuth();
  await checkBusinessOutcomes();
  await checkOnboardingFunnel();
  await checkPaidCustomerQueues();
  await checkOrderPayments();
  if (env.CALCOM_SYNC_ENABLED) {
    await checkCalcom();
  }

  try {
    await saveAlertLatches();
  } catch (error) {
    logger.warn({ evt: "health_alerter_latch_save_failed", error: (error as Error).message });
  }

  // Last, always: the heartbeat means "this loop ran", not "all healthy" —
  // a tick that posted five alerts still pings.
  await pingHeartbeat();
}

export function startHealthAlerter(): void {
  // Starts when there is anywhere to signal: Slack for the alerts, or the
  // heartbeat URL alone — the dead-man's switch must keep pinging even on a
  // box that has no Slack webhook configured.
  if (!env.OPS_SLACK_WEBHOOK_URL && !env.OPS_HEARTBEAT_URL) {
    logger.info({
      evt: "health_alerter_not_started",
      reason: "no OPS_SLACK_WEBHOOK_URL and no OPS_HEARTBEAT_URL"
    });
    return;
  }
  if (intervalHandle !== null) return;
  logger.info({
    evt: "health_alerter_starting",
    check_interval_ms: CHECK_INTERVAL_MS,
    calcom_enabled: env.CALCOM_SYNC_ENABLED
  });
  // Only registered once the worker genuinely starts ticking, so a
  // flag-disabled no-op is never reported as stalled.
  registerTickExpectation("health-alerter", CHECK_INTERVAL_MS);
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    // Each check function wraps itself in try/catch today, but that is
    // discipline, not a guarantee — one `await` added outside a `try` in any
    // of the five checks would kill the whole worker process. Backstop here,
    // same pattern as provisioningWorker.
    currentTick = withTickLogContext("health-alerter", () => checkOnce())
      .catch((error) => logger.error({ evt: "health_alerter_tick_failed", error }))
      .finally(() => {
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
