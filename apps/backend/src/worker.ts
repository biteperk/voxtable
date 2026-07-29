import { env } from "./config/env";
import { closePool } from "./db/pool";
import { startBackendWorkers, stopBackendWorkers } from "./runtime/workers";
import { verifyCalcomSchemasAgainstFixtures } from "./services/calcomSchemas";
import { initSentry } from "./utils/sentry";

let shuttingDown = false;

async function main(): Promise<void> {
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

    console.log("[shutdown] worker done");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
