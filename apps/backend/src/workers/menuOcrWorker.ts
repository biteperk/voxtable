/**
 * Menu OCR worker — drains `menu_ingestion_jobs` through the vision LLM.
 *
 * NO-OP when MENU_OCR_ENABLED=false (or no API key): `start` returns without
 * scheduling, mirroring the Cal.com outbox worker. Claims jobs with FOR UPDATE
 * SKIP LOCKED so multiple ticks / instances never double-parse. Transient
 * upstream errors (429/5xx/timeout) retry with backoff up to a cap; everything
 * else dead-letters to 'failed' so the owner falls back to the manual editor.
 */

import { logger } from "../utils/logger";
import { AppError } from "../domain/errors";
import { claimReadyJobs, markFailed, markParsed, markRetry } from "../repositories/menuIngestion";
import { isMenuOcrEnabled, parseMenu } from "../services/menuOcrClient";

const TICK_INTERVAL_MS = 3_000;
const BATCH_SIZE = 3;
const MAX_ATTEMPTS = 4;

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let currentTick: Promise<void> | null = null;

function backoffMsForAttempt(attempts: number): number {
  const base = 30_000;
  const max = 15 * 60 * 1000;
  return Math.min(base * 2 ** attempts, max);
}

// Transient = worth retrying: a 503 AppError (rate-limit / timeout / upstream
// 5xx) or any unknown throw (don't lose the job). A 502 "bad output" or a 4xx
// won't fix itself on retry, so it dead-letters to the manual editor.
function isTransient(error: unknown): boolean {
  if (error instanceof AppError) return error.statusCode === 503;
  return true;
}

async function processBatch(): Promise<void> {
  let jobs;
  try {
    jobs = await claimReadyJobs(BATCH_SIZE);
  } catch (error) {
    logger.error({ evt: "menu_ocr_claim_failed", error });
    return;
  }
  if (jobs.length === 0) return;

  for (const job of jobs) {
    try {
      const draft = await parseMenu({ sourceUrl: job.source_url, sourceKind: job.source_kind });
      await markParsed(job.id, draft);
      logger.info({
        evt: "menu_ocr_parsed",
        job_id: job.id,
        restaurant_id: job.restaurant_id,
        categories: draft.categories.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      const transient = isTransient(error);
      if (transient && job.attempts < MAX_ATTEMPTS) {
        await markRetry(job.id, message, new Date(Date.now() + backoffMsForAttempt(job.attempts)));
        logger.warn({ evt: "menu_ocr_retry", job_id: job.id, attempts: job.attempts, error: message });
      } else {
        await markFailed(job.id, message);
        logger.error({ evt: "menu_ocr_failed", job_id: job.id, error: message });
      }
    }
  }
}

export function startMenuOcrWorker(): void {
  if (!isMenuOcrEnabled()) {
    logger.info({ evt: "menu_ocr_worker_disabled" });
    return;
  }
  if (intervalHandle !== null) return;
  logger.info({ evt: "menu_ocr_worker_started", tick_ms: TICK_INTERVAL_MS, batch: BATCH_SIZE });
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    // See provisioningWorker: an unhandled rejection here kills the process.
    currentTick = processBatch()
      .catch((error) => logger.error({ evt: "menu_ocr_tick_failed", error }))
      .finally(() => {
        tickInFlight = false;
        currentTick = null;
      });
  }, TICK_INTERVAL_MS);
  intervalHandle.unref();
}

export async function stopMenuOcrWorker(): Promise<void> {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentTick) {
    await currentTick.catch(() => {});
  }
}
