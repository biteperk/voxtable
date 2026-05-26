/**
 * Health alerter — periodic poll that posts to Slack when any of three
 * production-health thresholds trip:
 *
 *   1. Outbox depth > 100 for two consecutive checks (5+ min lag).
 *   2. Cal.com circuit breaker is open.
 *   3. Inbox processing errors > 5 in the last hour.
 *
 * Posts to `OPS_SLACK_WEBHOOK_URL`. No-op when the env is unset or
 * `CALCOM_SYNC_ENABLED=false`. Edge-triggered: we only post when a threshold
 * NEWLY crosses, not on every check, so Slack doesn't get spammed.
 *
 * Single-process; the state is in-memory. After a container restart the
 * previous "already alerted" state is lost — first check might re-alert on
 * persistent issues. Acceptable.
 */

import { env } from "../config/env";
import { getInboxStats } from "../repositories/inbox";
import { getOutboxStats } from "../repositories/outbox";
import { getBreakerState } from "../services/calcomClient";
import { quotaSnapshot, shouldFireQuotaAlert } from "../services/calcomQuotaTracker";

const CHECK_INTERVAL_MS = 60_000; // every minute
const OUTBOX_DEPTH_THRESHOLD = 100;
const OUTBOX_DEPTH_CONSECUTIVE_CHECKS = 5; // ≥ 5 min lag before pinging
const INBOX_FAILURES_THRESHOLD = 5;

interface AlertState {
  outboxDepthBreaches: number;
  outboxDepthAlerted: boolean;
  breakerAlerted: boolean;
  inboxFailuresAlerted: boolean;
}

const state: AlertState = {
  outboxDepthBreaches: 0,
  outboxDepthAlerted: false,
  breakerAlerted: false,
  inboxFailuresAlerted: false
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

async function checkOnce(): Promise<void> {
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
    console.warn("[health-alerter] check failed:", (error as Error).message);
  }
}

export function startHealthAlerter(): void {
  if (!env.CALCOM_SYNC_ENABLED || !env.OPS_SLACK_WEBHOOK_URL) {
    console.log(
      `[health-alerter] not starting (sync=${env.CALCOM_SYNC_ENABLED}, slack=${Boolean(env.OPS_SLACK_WEBHOOK_URL)})`
    );
    return;
  }
  if (intervalHandle !== null) return;
  console.log(`[health-alerter] starting; every ${CHECK_INTERVAL_MS}ms`);
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
