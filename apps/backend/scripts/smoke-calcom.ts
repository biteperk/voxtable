/**
 * Smoke test for the Cal.com hybrid integration. Hits a running backend on
 * `PUBLIC_API_BASE_URL` (default http://localhost:3050).
 *
 * Cases covered without Cal.com credentials:
 *   1. /cal/webhook flag-off → 410 Gone (when CALCOM_SYNC_ENABLED=false)
 *   2. /cal/webhook missing signature → 401
 *   3. /cal/webhook bad signature → 401
 *   4. /cal/webhook stale createdAt → 400 (replay window)
 *   5. /cal/webhook valid + replayed → first 200/processed, second 200/duplicate
 *      (requires CALCOM_SYNC_ENABLED=true AND CALCOM_WEBHOOK_SECRET set in env
 *      of this script's process; we sign the body ourselves)
 *   6. /api/ops/calcom-health requires auth → 401 without bearer
 *
 * Skipped without credentials/Cal.com: actual outbox push, real BOOKING_CREATED
 * round-trip. Those require a Cal.com sandbox event type and are part of the
 * canary in PR 2 rollout.
 */

import crypto from "node:crypto";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
const webhookSecret = process.env.CALCOM_WEBHOOK_SECRET ?? "";

function signBody(body: string): string {
  if (!webhookSecret) return "";
  return crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
}

interface RawResponse {
  status: number;
  body: string;
}

async function rawPost(path: string, body: string, headers: Record<string, string>): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  });
  return { status: response.status, body: await response.text() };
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`Smoke FAIL: ${message}`);
}

function freshEventBody(triggerEvent: string, uid: string): string {
  return JSON.stringify({
    triggerEvent,
    createdAt: new Date().toISOString(),
    payload: {
      uid,
      startTime: "2026-12-01T08:00:00.000Z",
      endTime: "2026-12-01T09:30:00.000Z",
      attendees: [{ name: "Smoke User", email: "smoke@example.com", phoneNumber: "+61400000001" }],
      responses: { "party-size": "2", name: "Smoke User" }
    }
  });
}

async function main(): Promise<void> {
  console.log(`Smoke target: ${baseUrl}`);

  // Case 1+2: signature missing → 401 (or 410 if flag off).
  const noSig = await rawPost("/cal/webhook", freshEventBody("BOOKING_CREATED", "uid-smoke-noSig"), {});
  console.log(`[1] no-signature → ${noSig.status}`);
  assert(noSig.status === 401 || noSig.status === 410, `expected 401 or 410, got ${noSig.status}`);

  // Case 3: bad signature.
  const badBody = freshEventBody("BOOKING_CREATED", "uid-smoke-badSig");
  const badSig = await rawPost("/cal/webhook", badBody, { "x-cal-signature-256": "deadbeef" });
  console.log(`[2] bad-signature → ${badSig.status}`);
  assert(badSig.status === 401 || badSig.status === 410, `expected 401 or 410, got ${badSig.status}`);

  if (!webhookSecret) {
    console.log("[3-5] skipped (CALCOM_WEBHOOK_SECRET not set in env)");
    console.log("Smoke OK (signature negative-path only)");
    return;
  }

  // Case 4: stale createdAt → 400.
  const staleBody = JSON.stringify({
    triggerEvent: "BOOKING_CREATED",
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    payload: {
      uid: "uid-smoke-stale",
      startTime: "2026-12-01T08:00:00.000Z",
      attendees: [],
      responses: {}
    }
  });
  const stale = await rawPost("/cal/webhook", staleBody, {
    "x-cal-signature-256": signBody(staleBody)
  });
  console.log(`[3] stale-createdAt → ${stale.status}`);
  // 410 if flag off — that's also acceptable (the flag check wins).
  assert(stale.status === 400 || stale.status === 410, `expected 400/410, got ${stale.status}`);

  // Case 5: idempotency — same body twice. Skipped here because BOOKING_CREATED
  // would call into bookingService and require valid dates / DB seed data.
  // Use BOOKING_RESCHEDULED (ignored by handler, still recorded in inbox) to
  // confirm dedup without side effects.
  const replayBody = JSON.stringify({
    triggerEvent: "BOOKING_RESCHEDULED",
    createdAt: new Date().toISOString(),
    payload: {
      uid: `uid-smoke-replay-${Date.now()}`,
      startTime: "2026-12-01T08:00:00.000Z",
      attendees: [],
      responses: {}
    }
  });
  const sig = signBody(replayBody);
  const first = await rawPost("/cal/webhook", replayBody, { "x-cal-signature-256": sig });
  console.log(`[4] first delivery → ${first.status} ${first.body}`);
  const second = await rawPost("/cal/webhook", replayBody, { "x-cal-signature-256": sig });
  console.log(`[5] replay delivery → ${second.status} ${second.body}`);
  if (first.status === 410) {
    console.log("Skipping idempotency assert — flag off");
  } else {
    assert(first.status === 200, `expected 200, got ${first.status}`);
    assert(second.status === 200, `expected 200, got ${second.status}`);
    assert(/duplicate/.test(second.body), `expected duplicate marker, got ${second.body}`);
  }

  // Case 6: health endpoint requires auth.
  const healthResp = await fetch(`${baseUrl}/api/ops/calcom-health`);
  console.log(`[6] health no-auth → ${healthResp.status}`);
  assert(healthResp.status === 401, `expected 401, got ${healthResp.status}`);

  console.log("Smoke OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
