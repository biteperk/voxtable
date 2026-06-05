/**
 * Outbox worker — drains `outbox_calcom` into Cal.com.
 *
 * The push logic itself lives in calcomService and is injected at startup via
 * `setOutboxExecutor` (keeps this module free of a Cal.com-service import, so
 * there's no circular dep). Until an executor is installed the worker holds a
 * stub that dead-letters every row, so an accidentally-started worker can't
 * silently lose data.
 *
 * Worker is a NO-OP when `CALCOM_SYNC_ENABLED=false` — `start` returns
 * immediately without scheduling an interval.
 *
 * Concurrency: single-VM today. `claimReadyOutbox` uses FOR UPDATE SKIP
 * LOCKED so future horizontal scaling (multiple containers) is safe by
 * construction — workers will not double-push a row.
 */

import { env } from "../config/env";
import { DbClient, pool } from "../db/pool";
import { claimReadyOutbox, markOutboxFailed, markOutboxRetry, markOutboxSucceeded } from "../repositories/outbox";
import { logger } from "../utils/logger";

const TICK_INTERVAL_MS = 2_000;
const BATCH_SIZE = 20;
// Token-bucket throttle so we never exceed Cal.com's free-tier rate limit
// (verify exact ceiling on setup; ~10 req/s is the documented bound).
const MAX_PUSHES_PER_SECOND = 5;

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
// Promise resolved when the current tick (if any) finishes — `stop()` awaits
// this so SIGTERM doesn't kill mid-batch.
let currentTick: Promise<void> | null = null;

export interface OutboxExecutorRow {
  id: string;
  reservation_id: string;
  op: "create" | "cancel" | "reschedule";
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxExecutionResult {
  outcome: "succeeded" | "transient" | "permanent";
  error?: string;
}

export interface OutboxRowExecutor {
  /**
   * Execute one outbox row's intended op. Receives the worker's txn `db`
   * client so the executor can update the reservation (uid stamping) inside
   * the same transaction that marks the outbox row succeeded — atomic.
   *
   * Returns `succeeded` if Cal.com accepted; `transient` to retry with
   * backoff; `permanent` to dead-letter. Until `setOutboxExecutor` is called
   * the default stub dead-letters every row.
   */
  execute(row: OutboxExecutorRow, db: DbClient): Promise<OutboxExecutionResult>;
}

const stubExecutor: OutboxRowExecutor = {
  async execute(row) {
    return {
      outcome: "permanent",
      error: `Outbox worker stub: refusing to push row ${row.id}; PR 2 wires the real executor.`
    };
  }
};

let executor: OutboxRowExecutor = stubExecutor;

/**
 * Swap the executor — calcomService installs the real push implementation at
 * startup. Kept as a setter so the worker module doesn't have to import the
 * Cal.com service (avoids a circular dep).
 */
export function setOutboxExecutor(next: OutboxRowExecutor): void {
  executor = next;
}

/**
 * Compute exponential backoff for the next retry attempt:
 *   60s × 2^attempts, capped at 1 hour.
 * Up to 8 attempts ≈ 24h retry window.
 */
function backoffMsForAttempt(attempts: number): number {
  const base = 60_000;
  const max = 60 * 60 * 1000;
  return Math.min(base * 2 ** attempts, max);
}

async function processBatch(): Promise<void> {
  // One outer transaction per tick so SKIP LOCKED can do its job.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await claimReadyOutbox(BATCH_SIZE, client);
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    // Throttle inside the batch: minimum interval between push starts.
    const intervalBetweenPushesMs = Math.ceil(1000 / MAX_PUSHES_PER_SECOND);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (index > 0) await delay(intervalBetweenPushesMs);

      try {
        const result = await executor.execute(
          {
            id: row.id,
            reservation_id: row.reservation_id,
            op: row.op,
            payload: row.payload,
            attempts: row.attempts
          },
          client
        );

        if (result.outcome === "succeeded") {
          await markOutboxSucceeded(row.id, client);
        } else if (result.outcome === "transient") {
          const nextAttempt = row.attempts + 1;
          if (nextAttempt >= env.CALCOM_OUTBOX_MAX_ATTEMPTS) {
            await markOutboxFailed(
              row.id,
              `Max attempts reached (${env.CALCOM_OUTBOX_MAX_ATTEMPTS}). Last error: ${result.error ?? "unknown"}`,
              client
            );
          } else {
            await markOutboxRetry(row.id, result.error ?? "transient", backoffMsForAttempt(row.attempts), client);
          }
        } else {
          await markOutboxFailed(row.id, result.error ?? "permanent error", client);
        }
      } catch (error) {
        // Defensive: if the executor itself throws, treat as transient so
        // we don't lose visibility, but log loudly.
        logger.error({ evt: "outbox_executor_threw", error });
        await markOutboxRetry(
          row.id,
          (error as Error).message ?? "executor threw",
          backoffMsForAttempt(row.attempts),
          client
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallowed — already in error path */
    }
    logger.error({ evt: "outbox_batch_failed", error });
  } finally {
    client.release();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startOutboxWorker(): void {
  if (!env.CALCOM_SYNC_ENABLED) {
    logger.info({ evt: "outbox_worker_not_started", reason: "CALCOM_SYNC_ENABLED=false" });
    return;
  }
  if (intervalHandle !== null) {
    logger.warn({ evt: "outbox_worker_start_ignored", reason: "already running" });
    return;
  }
  logger.info({ evt: "outbox_worker_starting", tick_interval_ms: TICK_INTERVAL_MS, batch_size: BATCH_SIZE });
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    currentTick = processBatch().finally(() => {
      tickInFlight = false;
      currentTick = null;
    });
  }, TICK_INTERVAL_MS);
  // Don't keep Node alive purely for this interval — server.close() should be
  // the thing that ends the process lifecycle.
  intervalHandle.unref();
}

/**
 * Graceful shutdown — stop scheduling new batches and wait for the current
 * tick (if any) to finish. Bounded by the caller's overall timeout.
 */
export async function stopOutboxWorker(): Promise<void> {
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
