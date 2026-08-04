import { Router } from "express";

import { env } from "../config/env";
import { pool } from "../db/pool";
import { asyncHandler } from "../http/asyncHandler";

export const healthRouter = Router();

healthRouter.get("/", (_request, response) => {
  response.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>VoxTable Backend</title>
        <style>
          :root {
            color-scheme: dark;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #111;
            color: #f4f4f5;
          }

          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: #111;
          }

          main {
            width: min(720px, calc(100vw - 40px));
            border: 1px solid #2f3542;
            border-radius: 8px;
            padding: 32px;
            background: #1a1a1d;
            box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
          }

          h1 {
            margin: 0 0 8px;
            font-size: clamp(32px, 6vw, 56px);
            line-height: 1;
            letter-spacing: 0;
          }

          p {
            margin: 0;
            color: #cbd5e1;
            font-size: 18px;
            line-height: 1.6;
          }

          a {
            color: #67e8f9;
          }

          dl {
            display: grid;
            grid-template-columns: max-content 1fr;
            gap: 12px 20px;
            margin: 28px 0 0;
          }

          dt {
            color: #94a3b8;
          }

          dd {
            margin: 0;
          }

          code {
            color: #bfdbfe;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>VoxTable</h1>
          <p>Backend is running. Dashboard UI comes in the frontend phase.</p>
          <dl>
            <dt>Environment</dt>
            <dd><code>${env.APP_ENV}</code></dd>
            <dt>Version</dt>
            <dd><code>${env.APP_VERSION}</code></dd>
            <dt>Health</dt>
            <dd><a href="/health">/health</a></dd>
          </dl>
        </main>
      </body>
    </html>
  `);
});

/** Probe the database with a 2s deadline. Shared by /health and /readyz. */
export async function probeDatabase(): Promise<{ ok: true } | { ok: false; slow: boolean }> {
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("health-db-timeout")), 2_000)
      )
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, slow: error instanceof Error && error.message === "health-db-timeout" };
  }
}

healthRouter.get(
  "/health",
  asyncHandler(async (_request, response) => {
    const db = await probeDatabase();
    if (!db.ok) {
      response.status(503).json({
        status: "error",
        database: db.slow ? "slow" : "unavailable",
        message: db.slow
          ? "Postgres did not respond within 2s. Pool may be saturated."
          : "Backend is running, but Postgres is not reachable. Check DATABASE_URL and start Postgres."
      });
      return;
    }

    response.json({
      status: "ok",
      database: "ok"
    });
  })
);

// Liveness vs readiness, split (Cloud Run wires these as its probes; the
// distinction is a Block 8 platform primitive banked early):
//
//   /livez  — "is the process alive?" Deliberately touches NOTHING. A DB blip
//             must degrade traffic (readiness), never get the container
//             killed and restarted into the same blip (liveness).
//   /readyz — "should this instance receive traffic?" DB reachability, with
//             the same 2s deadline as /health.
healthRouter.get("/livez", (_request, response) => {
  response.json({ status: "ok" });
});

healthRouter.get(
  "/readyz",
  asyncHandler(async (_request, response) => {
    const db = await probeDatabase();
    if (!db.ok) {
      response.status(503).json({ status: "unready", database: db.slow ? "slow" : "unavailable" });
      return;
    }
    response.json({ status: "ok" });
  })
);
