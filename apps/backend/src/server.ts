import { env } from "./config/env";
import { createApp } from "./app";
import { closePool } from "./db/pool";
import { warmRestaurantCache } from "./repositories/restaurants";
import { installCalcomExecutor } from "./services/calcomService";
import { verifyCalcomSchemasAgainstFixtures } from "./services/calcomSchemas";
import { startOutboxWorker, stopOutboxWorker } from "./workers/calcomOutboxWorker";
import { startCleanupWorker, stopCleanupWorker } from "./workers/cleanupWorker";
import { startHealthAlerter, stopHealthAlerter } from "./workers/healthAlerter";

// Workers register their shutdown hooks here so server.ts doesn't have to know
// the full set. PR 1 leaves the array empty; PR 2 adds the Cal.com outbox
// worker. Each hook gets up to SHUTDOWN_WORKER_TIMEOUT_MS to drain.
type ShutdownHook = () => Promise<void>;
const shutdownHooks: ShutdownHook[] = [];

export function registerShutdownHook(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

const SHUTDOWN_WORKER_TIMEOUT_MS = 10_000;
const SHUTDOWN_HTTP_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  // Fail-loud check: every Zod schema for an external Cal.com payload must
  // parse a known-good fixture. If any schema regressed, fail to boot — that
  // turns a silent prod incident into a CrashLoop the deploy pipeline catches
  // before the new image ever serves traffic.
  try {
    verifyCalcomSchemasAgainstFixtures();
    console.log("[startup] calcom schemas verified against fixtures.");
  } catch (error) {
    console.error("[startup] FATAL — calcom schema fixture failed:", (error as Error).message);
    throw error;
  }

  // Warm memoized restaurant settings BEFORE binding the port so the very
  // first /retell/inbound request after a container restart doesn't burn a
  // cold DB hit while Retell holds the SIP leg open.
  try {
    await warmRestaurantCache(env.DEFAULT_RESTAURANT_ID);
  } catch (error) {
    console.warn("[startup] warmRestaurantCache failed (non-fatal):", error);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`VocoTable backend listening on port ${env.PORT}`);
  });

  // Cal.com executor is installed before the worker starts so the worker's
  // very first tick has the real implementation (not the dead-letter stub).
  // Both are no-ops when CALCOM_SYNC_ENABLED=false.
  installCalcomExecutor();
  startOutboxWorker();
  startHealthAlerter();
  startCleanupWorker();
  registerShutdownHook(async () => {
    await stopOutboxWorker();
  });
  registerShutdownHook(async () => {
    await stopHealthAlerter();
  });
  registerShutdownHook(async () => {
    await stopCleanupWorker();
  });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}; draining…`);

    // 1) Stop background workers first so they don't enqueue new DB work.
    const workerResults = await Promise.allSettled(
      shutdownHooks.map((hook) =>
        Promise.race([
          hook(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("worker shutdown timeout")), SHUTDOWN_WORKER_TIMEOUT_MS)
          )
        ])
      )
    );
    for (const [index, result] of workerResults.entries()) {
      if (result.status === "rejected") {
        console.warn(`[shutdown] worker ${index} did not exit cleanly:`, result.reason);
      }
    }

    // 2) Stop accepting new HTTP connections and drain in-flight ones.
    await new Promise<void>((resolve) => {
      const httpTimer = setTimeout(() => {
        console.warn(`[shutdown] HTTP drain hit ${SHUTDOWN_HTTP_TIMEOUT_MS}ms; forcing close`);
        resolve();
      }, SHUTDOWN_HTTP_TIMEOUT_MS);
      server.close(() => {
        clearTimeout(httpTimer);
        resolve();
      });
    });

    // 3) Tear down the DB pools last so worker writes can complete.
    try {
      await closePool();
    } catch (error) {
      console.warn("[shutdown] closePool failed:", error);
    }

    console.log("[shutdown] done");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
