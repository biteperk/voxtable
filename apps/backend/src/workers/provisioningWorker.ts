/**
 * Automated provisioning worker (Phase 4b). Drives `provisioning_jobs` through
 * buy_number → configure_voice → create_agent → bind, one step per claim so a
 * failure resumes from the last completed step (the job payload records what's
 * already acquired, so a retry NEVER re-buys a number). NO-OP when
 * PROVISIONING_AUTO_ENABLED=false — provisioning stays admin-assisted (4a).
 */

import { env } from "../config/env";
import { logger } from "../utils/logger";
import {
  advanceProvisioningStep,
  claimReadyProvisioningJobs,
  markProvisioningDone,
  markProvisioningFailed,
  markProvisioningRetry,
  type ProvisioningJob
} from "../repositories/provisioning";
import { getRestaurantProfile, setProvisioningBindings } from "../repositories/restaurants";
import { notifyRestaurant } from "../services/notificationService";
import { buyAuNumber, configureVoiceWebhook } from "../services/twilioProvisioning";
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

async function runStep(job: ProvisioningJob): Promise<void> {
  switch (job.step) {
    case "buy_number": {
      if (job.payload.twilio_number) {
        await advanceProvisioningStep(job.id, "configure_voice", {});
        return;
      }
      const { phoneNumber, sid } = await buyAuNumber();
      await advanceProvisioningStep(job.id, "configure_voice", { twilio_number: phoneNumber, twilio_sid: sid });
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
      if (job.attempts < MAX_ATTEMPTS) {
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
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    currentTick = processBatch().finally(() => {
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
