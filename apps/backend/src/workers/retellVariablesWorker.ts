/**
 * Keeps the Retell LLM's fallback date variables current.
 *
 * The agent resolves "tomorrow at 7" using `today` / `tomorrow` dynamic
 * variables. When a number is registered with a webhook URL, our
 * /retell/inbound handler injects them fresh on every call and they are always
 * right. When the number is registered with a static `inbound_agent_id` — which
 * is how production is configured — Retell instead uses the values stored on the
 * LLM as `default_dynamic_variables`, and until now those were only ever
 * refreshed by hand.
 *
 * The failure mode is nasty because it is quiet. Stale by two days or more and
 * the booking is rejected as being in the past, loudly. Stale by exactly ONE
 * day — by far the most likely amount, since it goes stale once per midnight —
 * and "tomorrow" resolves to today: the guest is booked for tonight, hears a
 * confirmation, and nothing in the system objects.
 *
 * So: recompute every quarter of an hour, but only call Retell when the values
 * have actually changed. That is one API call a day in the steady state, plus
 * one on boot, and at most ~15 minutes of staleness after midnight.
 *
 * No-op unless RETELL_LLM_ID and RETELL_API_KEY are both set, following the
 * same "off unless configured" pattern as the other integrations.
 */

import Retell from "retell-sdk";

import { env } from "../config/env";
import { getRestaurantTimezone } from "../repositories/restaurants";
import { logger } from "../utils/logger";
import { dayNameInTz, todayInTz, tomorrowInTz } from "../utils/time";

const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 min

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let currentTick: Promise<void> | null = null;
// What we last successfully pushed, so an unchanged day costs no API call.
let lastPushed: string | null = null;

export function isRetellVariableRefreshEnabled(): boolean {
  return Boolean(env.RETELL_API_KEY && env.RETELL_LLM_ID);
}

async function pushIfChanged(): Promise<void> {
  // The LLM's defaults are global, while timezone is per restaurant. Today
  // every restaurant is in the same zone, and the per-call webhook path already
  // injects the correct per-restaurant values whenever it fires — these are only
  // the fallback. If restaurants ever span zones, this fallback has to become
  // per-agent rather than per-LLM.
  const tz = await getRestaurantTimezone(env.DEFAULT_RESTAURANT_ID);
  const now = new Date();

  // Deliberately not now_local: it changes every minute and would turn this
  // into a constant stream of API calls. The webhook path supplies the precise
  // time of day when it fires; these fallbacks only need the date to be right.
  const variables = {
    today: todayInTz(tz, now),
    tomorrow: tomorrowInTz(tz, now),
    weekday_local: dayNameInTz(tz, now)
  };

  const fingerprint = JSON.stringify(variables);
  if (fingerprint === lastPushed) return;

  const client = new Retell({ apiKey: env.RETELL_API_KEY! });
  await client.llm.update(env.RETELL_LLM_ID!, {
    default_dynamic_variables: variables
  });

  lastPushed = fingerprint;
  logger.info({ evt: "retell_variables_refreshed", llm_id: env.RETELL_LLM_ID, ...variables });
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await pushIfChanged();
  } catch (error) {
    // Never rethrow: an unhandled rejection here would take down the worker
    // process and every other worker with it. A failed refresh degrades to the
    // previous values, which the next tick retries in 15 minutes.
    logger.error({ evt: "retell_variables_refresh_failed", error });
  } finally {
    tickInFlight = false;
  }
}

export function startRetellVariablesWorker(): void {
  if (intervalHandle !== null) return;
  if (!isRetellVariableRefreshEnabled()) {
    logger.info({ evt: "retell_variables_worker_disabled" });
    return;
  }

  logger.info({ evt: "retell_variables_worker_starting", tick_interval_ms: TICK_INTERVAL_MS });
  // Push once on boot so a container restart immediately corrects anything that
  // drifted while it was down.
  currentTick = tick();
  intervalHandle = setInterval(() => {
    currentTick = tick();
  }, TICK_INTERVAL_MS);
  intervalHandle.unref();
}

export async function stopRetellVariablesWorker(): Promise<void> {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentTick) {
    await currentTick.catch(() => undefined);
    currentTick = null;
  }
}
