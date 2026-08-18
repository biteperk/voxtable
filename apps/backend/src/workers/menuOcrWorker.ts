/**
 * Menu OCR worker — drains `menu_ingestion_jobs` through the vision LLM.
 *
 * NO-OP when MENU_OCR_ENABLED=false (or no API key): `start` returns without
 * scheduling, mirroring the Cal.com outbox worker. Claims jobs with FOR UPDATE
 * SKIP LOCKED so multiple ticks / instances never double-parse. Transient
 * upstream errors (429/5xx/timeout) retry with backoff up to a cap; everything
 * else dead-letters to 'failed' so the owner falls back to the manual editor.
 */

import { logger, withTickLogContext } from "../utils/logger";
import { registerTickExpectation } from "../utils/tickPulse";
import { AppError } from "../domain/errors";
import {
  claimReadyJobs,
  heartbeatIngestionJob,
  markFailed,
  markParsed,
  markRetry,
  pagesForJob
} from "../repositories/menuIngestion";
import { isMenuOcrEnabled, parseMenu } from "../services/menuOcrClient";
import { unaccountedPages } from "../services/menuPageAccounting";

const TICK_INTERVAL_MS = 3_000;
/** Menus parsed at once. Replaces the old per-tick batch size — see processBatch. */
const MAX_CONCURRENT_JOBS = 3;
const MAX_ATTEMPTS = 4;

/** In-flight job promises, so shutdown can wait for them and capacity is known. */
const inFlight = new Set<Promise<void>>();

let intervalHandle: NodeJS.Timeout | null = null;
let claimInFlight = false;
let currentTick: Promise<void> | null = null;

function backoffMsForAttempt(attempts: number): number {
  const base = 30_000;
  const max = 15 * 60 * 1000;
  return Math.min(base * 2 ** attempts, max);
}

/**
 * Transient = worth retrying: a 503 AppError (rate limit / timeout / upstream
 * 5xx). A 502 "bad output" or a 4xx won't fix itself, so it dead-letters to the
 * manual editor.
 *
 * Unknown throws used to default to transient "so we don't lose the job". That
 * was backwards for the case that actually happened: a truncated model reply
 * threw a raw SyntaxError, which is perfectly deterministic, so the job burned
 * every retry — four paid vision calls over seven minutes — reproducing the same
 * error. The parser now raises typed AppErrors for its own failures, so an
 * unknown throw here is a genuine bug in our code, and repeating it costs money
 * without ever succeeding. Retry only what we know is worth retrying.
 */
function isTransient(error: unknown): boolean {
  return error instanceof AppError && error.statusCode === 503;
}

/** Run one job to completion, recording the outcome. Never throws. */
async function runJob(job: Awaited<ReturnType<typeof claimReadyJobs>>[number]): Promise<void> {
  try {
      const pages = pagesForJob(job);
      const result = await parseMenu({
        sourceUrls: pages,
        sourceKind: job.source_kind,
        // Was omitted, so per-restaurant vision-spend logging always recorded null.
        restaurantId: job.restaurant_id,
        // Proves the job is alive between batches. A 48-page menu can run past
        // the 10-minute stuck-job window, and without this a second worker would
        // claim a job still in flight: double the vision spend, racing commits.
        onBatchDone: () => heartbeatIngestionJob(job.id)
      });
      await markParsed(job.id, result.draft, result.pageResults);
      const unaccounted = unaccountedPages(result.pageResults);
      logger.info({
        evt: "menu_ocr_parsed",
        job_id: job.id,
        restaurant_id: job.restaurant_id,
        pages: pages.length,
        // The ops metric for this whole class of problem: how often are we
        // handing an owner a menu with pages we could not account for?
        unaccounted_pages: unaccounted,
        page_statuses: result.pageResults.map((p) => p.status),
        categories: result.draft.categories.length
      });
      if (unaccounted.length > 0) {
        logger.warn({
          evt: "menu_ocr_unaccounted_pages",
          job_id: job.id,
          restaurant_id: job.restaurant_id,
          pages: unaccounted
        });
      }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const transient = isTransient(error);
    // The outcome writes themselves can reject (a DB blip during error
    // handling), which would make "Never throws" above a lie — and an
    // unhandled rejection from the per-job chain kills the worker process.
    // Swallow-and-log: the 10-minute stuck-job reaper reclaims the job.
    try {
      if (transient && job.attempts < MAX_ATTEMPTS) {
        await markRetry(job.id, message, new Date(Date.now() + backoffMsForAttempt(job.attempts)));
        logger.warn({ evt: "menu_ocr_retry", job_id: job.id, attempts: job.attempts, error: message });
      } else {
        await markFailed(job.id, message);
        logger.error({ evt: "menu_ocr_failed", job_id: job.id, error: message });
      }
    } catch (recordError) {
      logger.error({ evt: "menu_ocr_outcome_write_failed", job_id: job.id, error: recordError });
    }
  }
}

/**
 * Claim and start whatever capacity allows, WITHOUT waiting for the jobs to
 * finish.
 *
 * Jobs used to be claimed in threes and awaited one after another under a single
 * in-flight flag, so one long import blocked every other restaurant: a 48-page
 * menu is eight vision calls, and nothing else in the queue moved until it was
 * done. Now each job runs on its own and the tick returns immediately, with a
 * concurrency ceiling standing in for the old batch size.
 */
async function processBatch(): Promise<void> {
  const capacity = MAX_CONCURRENT_JOBS - inFlight.size;
  if (capacity <= 0) return;

  let jobs;
  try {
    jobs = await claimReadyJobs(capacity);
  } catch (error) {
    logger.error({ evt: "menu_ocr_claim_failed", error });
    return;
  }

  for (const job of jobs) {
    // Belt-and-braces on top of runJob's internal handling: the per-job chain
    // runs detached from the tick, so a rejection here has nothing above it.
    const task = runJob(job)
      .catch((error) => logger.error({ evt: "menu_ocr_job_crashed", job_id: job.id, error }))
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
}

export function startMenuOcrWorker(): void {
  if (!isMenuOcrEnabled()) {
    logger.info({ evt: "menu_ocr_worker_disabled" });
    return;
  }
  if (intervalHandle !== null) return;
  logger.info({ evt: "menu_ocr_worker_started", tick_ms: TICK_INTERVAL_MS, max_concurrent: MAX_CONCURRENT_JOBS });
  // Only registered once the worker genuinely starts ticking, so a
  // flag-disabled no-op is never reported as stalled.
  registerTickExpectation("menu-ocr", TICK_INTERVAL_MS);
  intervalHandle = setInterval(() => {
    // Guards only the CLAIM, which is fast. The jobs themselves run outside it,
    // so a long menu no longer stops the next tick from picking up other work.
    if (claimInFlight) return;
    claimInFlight = true;
    // See provisioningWorker: an unhandled rejection here kills the process.
    currentTick = withTickLogContext("menu-ocr", () => processBatch())
      .catch((error) => logger.error({ evt: "menu_ocr_tick_failed", error }))
      .finally(() => {
        claimInFlight = false;
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
  if (currentTick) await currentTick.catch(() => {});
  // Let running imports finish rather than orphaning them in 'processing' and
  // waiting on the 10-minute reaper after a deploy.
  if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
