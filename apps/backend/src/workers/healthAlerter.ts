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
import { getInboxStats } from "../repositories/inbox";
import { getOutboxStats } from "../repositories/outbox";
import { getBreakerState } from "../services/calcomClient";
import { quotaSnapshot, shouldFireQuotaAlert } from "../services/calcomQuotaTracker";
import { kdsHealthSnapshot } from "../services/orderService";
import { getKdsHeartbeats } from "../routes/orders";

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
  kdsHasSeenAnyHeartbeat: false
};

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
    console.warn("[health-alerter] failed to post to Slack:", (error as Error).message);
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
    console.warn("[health-alerter] kds check failed:", (error as Error).message);
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
          `:warning: VocoTable outbox depth = ${outbox.pendingDepth} (oldest ${
            outbox.oldestPendingAt ?? "n/a"
          }). Cal.com mirror is lagging.`
        );
        state.outboxDepthAlerted = true;
      }
    } else {
      if (state.outboxDepthAlerted) {
        await postToSlack(
          `:white_check_mark: VocoTable outbox depth recovered (now ${outbox.pendingDepth}).`
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
    console.warn("[health-alerter] calcom check failed:", (error as Error).message);
  }
}

async function checkOnce(): Promise<void> {
  // KDS always runs when slack is configured. Cal.com gated by its env flag.
  await checkKds();
  if (env.CALCOM_SYNC_ENABLED) {
    await checkCalcom();
  }
}

export function startHealthAlerter(): void {
  // Slack webhook is the only hard requirement now. KDS rules are valuable
  // even when Cal.com sync is off (single-tenant venues that don't mirror).
  if (!env.OPS_SLACK_WEBHOOK_URL) {
    console.log(`[health-alerter] not starting (no OPS_SLACK_WEBHOOK_URL)`);
    return;
  }
  if (intervalHandle !== null) return;
  console.log(
    `[health-alerter] starting; every ${CHECK_INTERVAL_MS}ms (kds=on, calcom=${env.CALCOM_SYNC_ENABLED})`
  );
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
