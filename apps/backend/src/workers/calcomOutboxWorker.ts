/**
 * Outbox worker — drains `outbox_calcom` into Cal.com.
 *
 * PR 1 scope (this file in its current form):
 *   - Lifecycle hooks (start, stop, graceful drain) are wired.
 *   - Worker is a NO-OP when `CALCOM_SYNC_ENABLED=false` — `start` returns
 *     immediately without scheduling an interval. This is the safe default
 *     for production until PR 2 turns the flag on.
 *
 * PR 2 will plug in the actual push logic (calcomService.executeOutboxRow).
 * The structure is here so PR 2 is a small, localized change.
 *
 * Concurrency: single-VM today. `claimReadyOutbox` uses FOR UPDATE SKIP
 * LOCKED so future horizontal scaling (multiple containers) is safe by
 * construction — workers will not double-push a row.
 */

import { env } from "../config/env";
import { pool } from "../db/pool";
import { claimReadyOutbox, markOutboxFailed, markOutboxRetry, markOutboxSucceeded } from "../repositories/outbox";

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

export interface OutboxRowExecutor {
  /**
   * Execute a single outbox row's intended op (push/cancel/reschedule).
   * Returns `succeeded` if Cal.com accepted; `transient` to retry; `permanent`
   * to dead-letter.
   *
   * PR 1 ships with a stub that always returns `permanent` so any row that
   * accidentally lands while sync is off doesn't loop forever. PR 2 will
   * replace this with the real implementation.
   */
  execute(row: {
    id: string;
    reservation_id: string;
    op: "create" | "cancel" | "reschedule";
    payload: Record<string, unknown>;
    attempts: number;
  }): Promise<{ outcome: "succeeded" | "transient" | "permanent"; error?: string }>;
}

// Stub executor for PR 1 — replaced in PR 2.
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
 * Swap the executor — PR 2 calls this from server.ts startup once the real
 * push implementation is in place. Kept as a setter so the worker module
 * doesn't have to import the Cal.com service (avoids a circular dep).
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
        const result = await executor.execute({
          id: row.id,
          reservation_id: row.reservation_id,
          op: row.op,
          payload: row.payload,
          attempts: row.attempts
        });

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
        console.error("[outbox-worker] executor threw — treating as transient:", error);
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
    console.error("[outbox-worker] batch failed:", error);
  } finally {
    client.release();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startOutboxWorker(): void {
  if (!env.CALCOM_SYNC_ENABLED) {
    console.log("[outbox-worker] CALCOM_SYNC_ENABLED=false; worker not started.");
    return;
  }
  if (intervalHandle !== null) {
    console.warn("[outbox-worker] start called twice; ignoring");
    return;
  }
  console.log(`[outbox-worker] starting; tick every ${TICK_INTERVAL_MS}ms, batch ${BATCH_SIZE}`);
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
