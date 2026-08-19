/**
 * Inbox worker — retries inbound Cal.com webhooks that failed to process.
 *
 * Why this exists. `/cal/webhook` persists every event, then processes it
 * inline, and converts every failure into a 200 — a 5xx would make Cal.com
 * retry forever, which is worse. The consequence was that a failed inbound
 * booking was simply lost: we did not retry it, and neither did Cal.com. The
 * repository function this worker claims with (`claimRetryableInbox`, formerly
 * `claimUnprocessedInbox`) was written for a worker that was never built and
 * had zero callers; cleanupWorker carried a comment saying exactly that.
 *
 * The failures are ordinary, not exotic: a day-lock wait that outlives
 * statement_timeout, pool exhaustion under a burst, a transient Cal.com call
 * inside the handler. That was tolerable while Cal.com mirrored bookings taken
 * by phone. It is not tolerable now guests book through it, because a lost row
 * is a guest holding a confirmation for a table the restaurant never heard of.
 *
 * Shape deliberately mirrors calcomOutboxWorker: same tick discipline, same
 * per-row savepoint, same backoff, same attempts ceiling. Two workers that read
 * the same way are two workers one person can hold in their head.
 */

import { env } from "../config/env";
import { PermanentInboxError } from "../domain/errors";
import { pool } from "../db/pool";
import {
  claimRetryableInbox,
  markInboxDeadLettered,
  markInboxProcessed,
  markInboxRetry
} from "../repositories/inbox";
import { processInboxEvent } from "../services/calcomService";
import type { CalcomWebhookPayload } from "../services/calcomService";
import { logger, withTickLogContext } from "../utils/logger";
import { registerTickExpectation } from "../utils/tickPulse";

// Slower than the outbox's 2 s: this queue is empty in the normal case, and a
// row only lands here after an attempt has already failed, so there is nothing
// to gain from tight polling.
const TICK_INTERVAL_MS = 10_000;
const BATCH_SIZE = 10;

/**
 * The processor, injectable for tests only.
 *
 * Same seam, and the same reason, as calcomOutboxWorker's setOutboxExecutor:
 * the retry and dead-letter policy is the part that has historically gone
 * wrong, and it cannot be exercised through the real handler without a network
 * and a fixture for every failure mode. Production never calls the setter.
 */
type InboxProcessor = (event: CalcomWebhookPayload) => Promise<void>;
let processor: InboxProcessor = processInboxEvent;

/** Test-only. Returns the previous processor so a test can restore it. */
export function setInboxProcessor(next: InboxProcessor): InboxProcessor {
  const previous = processor;
  processor = next;
  return previous;
}

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let currentTick: Promise<void> | null = null;

/**
 * Exponential from one minute, capped at an hour — identical to the outbox, so
 * the attempts ceiling buys roughly the same day-long window to recover from an
 * outage before a booking is declared unrecoverable.
 */
function backoffMsForAttempt(attempts: number): number {
  const base = 60_000;
  const max = 60 * 60 * 1000;
  return Math.min(base * 2 ** attempts, max);
}

async function processBatch(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await claimRetryableInbox(BATCH_SIZE, client);
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    for (const row of rows) {
      // Per-row savepoint, for the reason the outbox worker documents at
      // length: a Postgres error thrown from the handler aborts the batch
      // transaction, and every later query on this client fails — including the
      // markInboxRetry in the catch. The row would then be re-claimed every
      // tick with its attempts counter rolled back, forever.
      await client.query("SAVEPOINT inbox_row");
      const envelope = row.raw_payload as {
        triggerEvent?: unknown;
        createdAt?: unknown;
        payload?: unknown;
      };

      try {
        await processor({
          triggerEvent: String(envelope.triggerEvent ?? row.trigger_event),
          // The stored envelope is the full webhook body, so createdAt is
          // normally present. Fall back to when we received it rather than
          // refusing to retry over a missing timestamp — the replay window is
          // enforced at the route, on the original delivery, not here.
          createdAt:
            typeof envelope.createdAt === "string" ? envelope.createdAt : row.received_at,
          payload: (envelope.payload ?? {}) as Record<string, unknown>
        });
        await markInboxProcessed(row.event_id, client);
        logger.info({
          evt: "calcom_inbox_retry_succeeded",
          event_id: row.event_id,
          attempts: row.attempts + 1
        });
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT inbox_row");
        const message = (error as Error).message ?? String(error);
        const nextAttempt = row.attempts + 1;

        // A refusal, an unmapped venue or a payload the schema rejects will
        // fail identically on every attempt. Worse, the refusal paths have
        // already cancelled the booking back on Cal.com — a retry that later
        // succeeded would create a reservation for a booking the guest has
        // been told is off. Dead-letter on sight; do not burn the ceiling.
        const isPermanent = error instanceof PermanentInboxError;

        if (isPermanent || nextAttempt >= env.CALCOM_INBOX_MAX_ATTEMPTS) {
          // Terminal. Loud, because the guest end of this is a person who
          // believes they have a table. The row keeps its payload so the
          // booking can be recreated by hand.
          await markInboxDeadLettered(
            row.event_id,
            isPermanent
              ? `Not retryable: ${message}`
              : `Max attempts reached (${env.CALCOM_INBOX_MAX_ATTEMPTS}). Last error: ${message}`,
            client
          );
          logger.error({
            evt: "calcom_inbox_dead_lettered",
            event_id: row.event_id,
            trigger_event: row.trigger_event,
            attempts: nextAttempt,
            permanent: isPermanent,
            error: message
          });
        } else {
          await markInboxRetry(row.event_id, message, backoffMsForAttempt(row.attempts), client);
          logger.warn({
            evt: "calcom_inbox_retry_failed",
            event_id: row.event_id,
            attempts: nextAttempt,
            error: message
          });
        }
      }
      await client.query("RELEASE SAVEPOINT inbox_row");
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallowed — already in the error path */
    }
    logger.error({ evt: "calcom_inbox_batch_failed", error });
  } finally {
    client.release();
  }
}

export function startInboxWorker(): void {
  if (!env.CALCOM_SYNC_ENABLED) {
    logger.info({ evt: "inbox_worker_not_started", reason: "CALCOM_SYNC_ENABLED=false" });
    return;
  }
  if (intervalHandle !== null) {
    logger.warn({ evt: "inbox_worker_start_ignored", reason: "already running" });
    return;
  }
  logger.info({
    evt: "inbox_worker_starting",
    tick_interval_ms: TICK_INTERVAL_MS,
    batch_size: BATCH_SIZE
  });
  registerTickExpectation("calcom-inbox", TICK_INTERVAL_MS);
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    // processBatch's try/catch begins AFTER pool.connect(), so a connect
    // timeout rejects outside it — and an unhandled rejection would take the
    // whole worker process down.
    currentTick = withTickLogContext("calcom-inbox", () => processBatch())
      .catch((error) => logger.error({ evt: "inbox_tick_failed", error }))
      .finally(() => {
        tickInFlight = false;
        currentTick = null;
      });
  }, TICK_INTERVAL_MS);
  intervalHandle.unref();
}

/** Test-only: one batch, no interval. Drives the real retry/dead-letter policy. */
export async function processInboxBatchOnce(): Promise<void> {
  await processBatch();
}

export async function stopInboxWorker(): Promise<void> {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentTick) {
    await currentTick.catch(() => {
      /* already logged inside processBatch */
    });
  }
}
