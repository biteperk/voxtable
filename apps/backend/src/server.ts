import { env } from "./config/env";
import { createApp } from "./app";
import { closePool } from "./db/pool";
import { warmRestaurantCache } from "./repositories/restaurants";
import { installProcessGuards } from "./runtime/processGuards";
import { verifyCalcomSchemasAgainstFixtures } from "./services/calcomSchemas";
import { initSentry } from "./utils/sentry";

const SHUTDOWN_HTTP_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  // Guards first — a rejection escaping anything below must be logged, not
  // silently exit the process. (Sentry does NOT wire these hooks when
  // SENTRY_DSN is unset, which an earlier comment here wrongly assumed.)
  installProcessGuards("api");
  initSentry();

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
    console.log(`VoxTable backend listening on port ${env.PORT}`);
  });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}; draining…`);

    // 1) Stop accepting new HTTP connections and drain in-flight ones.
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

    // 2) Tear down the DB pool after in-flight requests have drained.
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
