/**
 * Automated provisioning worker (Phase 4b). Drives `provisioning_jobs` through
 * buy_number → configure_voice → create_agent → bind, one step per claim so a
 * failure resumes from the last completed step: the payload records what has
 * already been acquired, and each step checks that before repeating work.
 * NO-OP when PROVISIONING_AUTO_ENABLED=false — provisioning stays
 * admin-assisted (4a).
 *
 * Buying a Twilio number is the one irreversible, billable step, and it is NOT
 * safe to retry blind: the purchase and the record of it are two separate
 * writes. So buy_number writes a `buy_started_at` marker first and refuses to
 * run again if it finds that marker without a number — that combination means
 * we crashed mid-purchase and cannot tell whether a number was bought. It fails
 * the job for a human to reconcile rather than risk paying for two.
 */

import { env } from "../config/env";
import { logger, withTickLogContext } from "../utils/logger";
import { registerTickExpectation } from "../utils/tickPulse";
import {
  advanceProvisioningStep,
  claimReadyProvisioningJobs,
  markProvisioningDone,
  markProvisioningFailed,
  markProvisioningRetry,
  clearProvisioningPayloadKey,
  patchProvisioningPayload,
  type ProvisioningJob
} from "../repositories/provisioning";
import { getOnboardingStatus, getRestaurantProfile, setProvisioningBindings } from "../repositories/restaurants";
import { notifyRestaurant } from "../services/notificationService";
import {
  configureVoiceWebhook,
  isDefinitelyNotPurchased,
  purchaseAuNumber,
  searchAuNumber
} from "../services/twilioProvisioning";
import { createAgentForRestaurant, importNumberToRetell } from "../services/retellProvisioning";

const TICK_INTERVAL_MS = 5_000;
const BATCH_SIZE = 2;
const MAX_ATTEMPTS = 6;

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let currentTick: Promise<void> | null = null;

function backoffMsForAttempt(attempts: number): number {
  return Math.min(30_000 * 2 ** attempts, 30 * 60 * 1000);
}

/**
 * A failure that retrying cannot fix — it needs a person. Fails the job on the
 * first occurrence instead of burning the retry budget on an identical error.
 */
class PermanentProvisioningError extends Error {}

async function runStep(job: ProvisioningJob): Promise<void> {
  switch (job.step) {
    case "buy_number": {
      if (job.payload.twilio_number) {
        await advanceProvisioningStep(job.id, "configure_voice", {});
        return;
      }
      // B3 cost gate: buying a Twilio number costs real money. The enqueue only
      // happens from the Stripe webhook on a trialing|active subscription, but a
      // subscription can lapse/cancel between enqueue and this (possibly
      // retried/backed-off) step. Re-check the restaurant is STILL in
      // `provisioning` immediately before the purchase; if it regressed
      // (suspended/cancelled), fail the job rather than buy a number for a
      // tenant that's no longer paying. This is the only step that spends money,
      // so it's the only one that needs the guard.
      const status = await getOnboardingStatus(job.restaurant_id);
      if (status !== "provisioning") {
        throw new Error(
          `Provisioning aborted: restaurant ${job.restaurant_id} is '${status}', not 'provisioning' (subscription likely lapsed). Not buying a number.`
        );
      }

      // Crash-window guard. We buy from Twilio, THEN record the number. If the
      // process dies in between, the payload still looks untouched and the
      // 10-minute reaper would happily buy a second number that we then pay for
      // every month, forever. So: write "I am about to buy" first. If we come
      // back and that marker is set but no number was recorded, we cannot tell
      // whether the purchase went through — stop and let a human check Twilio.
      // A job that needs one minute of attention beats a silent double charge.
      if (job.payload.buy_started_at) {
        throw new PermanentProvisioningError(
          `Provisioning halted: a number purchase for restaurant ${job.restaurant_id} was started at ` +
            `${job.payload.buy_started_at} but never recorded (worker likely crashed mid-purchase). ` +
            `Check the Twilio console for an unassigned AU number before retrying — this job will NOT ` +
            `buy another one.`
        );
      }

      // Search OUTSIDE the marker — it's read-only, and a 429 on the search
      // used to trip the marker: the retry then found buy_started_at set,
      // concluded "possible double-purchase", and permanently failed a paying
      // customer's provisioning over a rate-limit blip. The marker's job is to
      // guard the one call that spends money, nothing else.
      const candidate = await searchAuNumber();

      await patchProvisioningPayload(job.id, { buy_started_at: new Date().toISOString() });
      try {
        const { phoneNumber, sid } = await purchaseAuNumber(candidate);
        await advanceProvisioningStep(job.id, "configure_voice", { twilio_number: phoneNumber, twilio_sid: sid });
      } catch (error) {
        // A 4xx (incl. 429) means Twilio REJECTED the purchase — nothing was
        // bought, so clear the marker and let the normal retry policy run.
        // 5xx / network stays ambiguous: the marker holds and the next
        // attempt halts for a human, exactly as designed for crash windows.
        if (isDefinitelyNotPurchased(error)) {
          await clearProvisioningPayloadKey(job.id, "buy_started_at");
        }
        throw error;
      }
      return;
    }
    case "configure_voice": {
      if (job.payload.twilio_sid) await configureVoiceWebhook(job.payload.twilio_sid);
      await advanceProvisioningStep(job.id, "create_agent", {});
      return;
    }
    case "create_agent": {
      if (job.payload.retell_agent_id) {
        await advanceProvisioningStep(job.id, "bind", {});
        return;
      }
      const profile = await getRestaurantProfile(job.restaurant_id);
      const agentId = await createAgentForRestaurant(profile?.name ?? "Restaurant");
      await advanceProvisioningStep(job.id, "bind", { retell_agent_id: agentId });
      return;
    }
    case "bind": {
      const number = job.payload.twilio_number;
      const agentId = job.payload.retell_agent_id;
      if (!number || !agentId) throw new Error("Provisioning bind: missing number or agent in payload.");
      await importNumberToRetell(number, agentId);
      // Persist bindings on the restaurant so inbound calls route correctly, and
      // tell the owner their line is ready to forward + verify.
      await setProvisioningBindings(job.restaurant_id, {
        twilioPhoneNumber: number,
        retellPhoneNumber: number,
        retellAgentId: agentId
      });
      await markProvisioningDone(job.id);
      void notifyRestaurant("number_ready", job.restaurant_id, { number });
      logger.info({ evt: "provisioning_complete", restaurant_id: job.restaurant_id, number });
      return;
    }
    case "complete":
      await markProvisioningDone(job.id);
      return;
  }
}

async function processBatch(): Promise<void> {
  let jobs: ProvisioningJob[];
  try {
    jobs = await claimReadyProvisioningJobs(BATCH_SIZE);
  } catch (error) {
    logger.error({ evt: "provisioning_claim_failed", error });
    return;
  }
  for (const job of jobs) {
    try {
      await runStep(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : "provisioning step failed";
      if (error instanceof PermanentProvisioningError) {
        await markProvisioningFailed(job.id, message);
        logger.error({ evt: "provisioning_failed_permanent", job_id: job.id, step: job.step, restaurant_id: job.restaurant_id, error: message });
      } else if (job.attempts < MAX_ATTEMPTS) {
        await markProvisioningRetry(job.id, message, new Date(Date.now() + backoffMsForAttempt(job.attempts)));
        logger.warn({ evt: "provisioning_retry", job_id: job.id, step: job.step, attempts: job.attempts, error: message });
      } else {
        await markProvisioningFailed(job.id, message);
        logger.error({ evt: "provisioning_failed", job_id: job.id, step: job.step, error: message });
      }
    }
  }
}

export function startProvisioningWorker(): void {
  if (!env.PROVISIONING_AUTO_ENABLED) {
    logger.info({ evt: "provisioning_worker_disabled" });
    return;
  }
  if (intervalHandle !== null) return;
  logger.info({ evt: "provisioning_worker_started" });
  // Only registered once the worker genuinely starts ticking, so a
  // flag-disabled no-op is never reported as stalled.
  registerTickExpectation("provisioning", TICK_INTERVAL_MS);
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    // processBatch awaits DB writes outside its own try/catch, so a database
    // blip there rejects. An unhandled rejection kills the worker process on
    // Node >= 15 — taking notifications and provisioning down with it.
    currentTick = withTickLogContext("provisioning", () => processBatch())
      .catch((error) => logger.error({ evt: "provisioning_tick_failed", error }))
      .finally(() => {
        tickInFlight = false;
        currentTick = null;
      });
  }, TICK_INTERVAL_MS);
  intervalHandle.unref();
}

export async function stopProvisioningWorker(): Promise<void> {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentTick) await currentTick.catch(() => {});
}
