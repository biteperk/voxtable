/**
 * The staging pass, machine half — one command, one verdict.
 *
 *   PUBLIC_API_BASE_URL=https://voxtable-stg-api-….run.app \
 *   SMOKE_RESTAURANT_ID=33333333-3333-4333-8333-333333333333 \
 *   SMOKE_RETELL_SIGNING_KEY=… TWILIO_AUTH_TOKEN=… TWILIO_PHONE_NUMBER=+61468203234 \
 *   RETELL_PHONE_NUMBER=+61468203234 \
 *   SMOKE_FIREBASE_API_KEY=… SMOKE_FIREBASE_EMAIL=… SMOKE_FIREBASE_PASSWORD=… \
 *   npm run smoke:staging
 *
 * Sequences the HTTP smokes against ONE base URL, each in its signed /
 * token-carrying mode, and prints a pass/fail table. Exits nonzero on any
 * failure. This is the repeatable machine half of "staging passed end to
 * end"; the human half is deploy/runbooks/staging-call-battery.md.
 *
 * Env not set → the corresponding smoke still runs in its degraded local mode
 * (unsigned / unauthenticated), which will FAIL against staging's enforced
 * gates — that failure is correct, not noise: a green staging verdict must
 * mean every gate was exercised.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeSmokeTarget } from "./lib/smokeTarget";

const here = dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
assertSafeSmokeTarget(baseUrl);

const SUITES: Array<{ name: string; script: string }> = [
  { name: "retell signed (inbound + booking + negative control)", script: "smoke-retell-signed.ts" },
  { name: "retell orders (menu + pickup + idempotency, signed)", script: "smoke-retell-orders.ts" },
  { name: "twilio webhooks (signed + negative control)", script: "smoke-twilio.ts" },
  { name: "orders API + KDS chain (Firebase token)", script: "smoke-orders.ts" },
  { name: "cal.com webhook gate (signature + replay)", script: "smoke-calcom.ts" }
];

async function health(): Promise<boolean> {
  // Staging runs min-instances=0 — the first request of a run can land in the
  // cold-start window and see a 503 that means "waking up", not "broken".
  // Retry a few times before judging.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const h = await fetch(`${baseUrl}/health`);
      if (h.ok) {
        const r = await fetch(`${baseUrl}/readyz`).catch(() => null);
        console.log(`/health → ${h.status}${r ? ` · /readyz → ${r.status}` : ""}`);
        return true;
      }
      console.log(`/health → ${h.status} (attempt ${attempt}/4 — cold start?)`);
    } catch (error) {
      console.log(`health unreachable (attempt ${attempt}/4): ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return false;
}

async function main(): Promise<void> {
  console.log(`\n═══ staging smoke battery → ${baseUrl} ═══\n`);
  const results: Array<{ name: string; ok: boolean }> = [];

  const healthy = await health();
  results.push({ name: "health + readyz", ok: healthy });

  if (healthy) {
    for (const suite of SUITES) {
      console.log(`\n─── ${suite.name} ───`);
      const run = spawnSync("npx", ["tsx", join(here, suite.script)], {
        stdio: "inherit",
        env: process.env
      });
      results.push({ name: suite.name, ok: run.status === 0 });
    }
  }

  console.log("\n═══ verdict ═══");
  for (const r of results) {
    console.log(`${r.ok ? "  PASS" : "✗ FAIL"}  ${r.name}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} suite(s) failed.`);
    process.exit(1);
  }
  console.log("\n✅ machine half of the staging pass is green — run the call battery next.");
}

main().catch((error) => {
  console.error("smoke-staging crashed:", error);
  process.exit(1);
});
