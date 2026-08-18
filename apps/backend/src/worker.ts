import { createServer, type Server } from "node:http";

import { env } from "./config/env";
import { closePool } from "./db/pool";
import { installProcessGuards } from "./runtime/processGuards";
import { startBackendWorkers, stopBackendWorkers } from "./runtime/workers";
import { probeDatabase } from "./routes/health";
import { verifyCalcomSchemasAgainstFixtures } from "./services/calcomSchemas";
import { initSentry } from "./utils/sentry";
import { stalledWorkers, tickPulseSnapshot } from "./utils/tickPulse";

let shuttingDown = false;

/**
 * The worker's health surface. Until now this process had no HTTP listener at
 * all, so "the worker is up" was unfalsifiable from outside — a worker whose
 * ticks all silently no-op looked identical to a healthy one. Cloud Run also
 * requires every service to listen on $PORT, so this replaces the old
 * keep-alive interval hack as what holds the event loop open.
 *
 *   /livez   — process alive; touches nothing.
 *   /readyz  — database reachable (same 2s deadline as the api's).
 *   /workerz — per-worker tick counts and last-tick age, fed by
 *              withTickLogContext. THE line to read when the worker "runs
 *              fine" but nothing is happening. Returns 503 once a started
 *              worker has missed STALE_INTERVAL_MULTIPLE of its own tick
 *              interval, so a probe that reads status codes can see a wedge.
 *              It used to answer 200 unconditionally, which made it useless
 *              for precisely the failure it was built to expose.
 */
function startHealthServer(): Server {
  const server = createServer((request, response) => {
    const respond = (status: number, body: Record<string, unknown>): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.url === "/livez") {
      respond(200, { status: "ok" });
      return;
    }
    if (request.url === "/readyz") {
      void probeDatabase().then((db) =>
        db.ok
          ? respond(200, { status: "ok" })
          : respond(503, { status: "unready", database: db.slow ? "slow" : "unavailable" })
      );
      return;
    }
    if (request.url === "/workerz") {
      // 503 when a started worker has missed too many ticks. This used to
      // answer 200 unconditionally, which made it useless for the one job it
      // exists to do: a worker wedged mid-tick — an outbox push hung inside an
      // open transaction, say — reported "ok" for the life of the container
      // while nothing was being processed.
      const workers = tickPulseSnapshot();
      const stalled = stalledWorkers();
      if (stalled.length > 0) {
        respond(503, { status: "stalled", stalled, workers });
        return;
      }
      respond(200, { status: "ok", workers });
      return;
    }
    respond(404, { error: "not found" });
  });
  // Falls back to PORT so Cloud Run (separate container, injected PORT) needs no
  // extra config; locally WORKER_HEALTH_PORT keeps this off the api's PORT.
  const port = env.WORKER_HEALTH_PORT ?? env.PORT;
  server.listen(port, () => {
    console.log(`[startup] worker health surface on :${port} (/livez /readyz /workerz)`);
  });
  return server;
}

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

  // Holds the event loop open (every worker unref()s its own timer) AND gives
  // the process a health surface — see startHealthServer above.
  const healthServer = startHealthServer();

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] worker received ${signal}; draining...`);

    healthServer.close();

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
