import { env } from "./config/env";
import { closePool } from "./db/pool";
import { installProcessGuards } from "./runtime/processGuards";
import { startBackendWorkers, stopBackendWorkers } from "./runtime/workers";
import { verifyCalcomSchemasAgainstFixtures } from "./services/calcomSchemas";
import { initSentry } from "./utils/sentry";

let shuttingDown = false;

async function main(): Promise<void> {
  // One stray rejection in any of the seven workers must not take the other
  // six down. Guards go in before anything can schedule async work.
  installProcessGuards("worker");
  initSentry();

  try {
    verifyCalcomSchemasAgainstFixtures();
    console.log("[startup] calcom schemas verified against fixtures.");
  } catch (error) {
    console.error("[startup] FATAL - calcom schema fixture failed:", (error as Error).message);
    throw error;
  }

  startBackendWorkers();
  console.log(`VoxTable backend worker listening for jobs (${env.APP_ENV}).`);

  // Every worker unref()s its own timer — correct in the api process, which the
  // HTTP listener keeps alive. This process has no HTTP listener, so without a
  // ref'd handle Node's event loop drains and the process exits 0 right after
  // startup (Docker then restarts it in a loop). Hold the loop open until shutdown.
  const keepAlive = setInterval(() => {}, 1 << 30);

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] worker received ${signal}; draining...`);

    await stopBackendWorkers({
      onStopFailure(worker, reason) {
        console.warn(`[shutdown] worker ${worker.name} did not exit cleanly:`, reason);
      }
    });

    try {
      await closePool();
    } catch (error) {
      console.warn("[shutdown] closePool failed:", error);
    }

    clearInterval(keepAlive);
    console.log("[shutdown] worker done");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
