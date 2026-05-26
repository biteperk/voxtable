import { env } from "./config/env";
import { createApp } from "./app";
import { closePool } from "./db/pool";
import { warmRestaurantCache } from "./repositories/restaurants";
import { startOutboxWorker, stopOutboxWorker } from "./workers/calcomOutboxWorker";

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

  // Start background workers. Each registers its own drain hook so SIGTERM
  // halts the interval and waits for in-flight work to settle before the
  // pool closes. No-op when CALCOM_SYNC_ENABLED=false.
  startOutboxWorker();
  registerShutdownHook(async () => {
    await stopOutboxWorker();
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
