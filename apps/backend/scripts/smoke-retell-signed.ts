/**
 * Signed Retell smoke test — exercises the FULL signature path that the plain
 * `smoke:retell` script skips.
 *
 * `smoke:retell` sends no `x-retell-signature` header and only works when the
 * server runs with `RETELL_VERIFY_SIGNATURE=false`. That left the production
 * signature gate (`assertRetellSignature` → `Retell.verify`) completely
 * unexercised — which is how a wrong `RETELL_API_KEY` silently 401'd every
 * tool call in prod and dropped every booking with no test catching it.
 *
 * This script signs each request body with `Retell.sign(body, RETELL_API_KEY)`
 * — the exact scheme Retell uses (`v={ts},d=hmac_sha256_hex(body+ts)`) — so we
 * can prove the verify / raw-body / header wiring end-to-end WITHOUT a phone
 * call. It also fires one deliberately-tampered request and asserts a 401, so
 * the test can't false-pass against a server that has verification turned off.
 *
 * Run against a server started with verification ON and a MATCHING key, e.g.:
 *
 *   RETELL_VERIFY_SIGNATURE=true RETELL_API_KEY=smoke-test-key npm run dev:backend
 *   RETELL_API_KEY=smoke-test-key npm run smoke:retell-signed
 *
 * The key is only a shared secret for the local round-trip — it does NOT need
 * to be a real Retell key. Validate the real integration with a staging call.
 * Production credentials are checked by non-mutating read-back only.
 */

import { Retell } from "retell-sdk";

import { mintSmokeIdToken } from "./lib/firebaseToken";
import { assertSafeSmokeTarget } from "./lib/smokeTarget";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
assertSafeSmokeTarget(baseUrl);
const restaurantId =
  process.env.SMOKE_RESTAURANT_ID ??
  process.env.DEFAULT_RESTAURANT_ID ??
  "11111111-1111-4111-8111-111111111111";
// The server verifies with RETELL_WEBHOOK_SECRET ?? RETELL_API_KEY — sign with
// whichever value the TARGET actually verifies against. Staging has a separate
// webhook secret, so SMOKE_RETELL_SIGNING_KEY takes precedence.
const signingKey = process.env.SMOKE_RETELL_SIGNING_KEY ?? process.env.RETELL_API_KEY;

if (!signingKey) {
  console.error(
    [
      "smoke:retell-signed requires SMOKE_RETELL_SIGNING_KEY (or RETELL_API_KEY) — the SAME",
      "value the server verifies with (RETELL_WEBHOOK_SECRET ?? RETELL_API_KEY on the server).",
      "Start the server with verification on and a matching key, then run this:",
      "",
      "  RETELL_VERIFY_SIGNATURE=true RETELL_API_KEY=smoke-test-key npm run dev:backend",
      "  SMOKE_RETELL_SIGNING_KEY=smoke-test-key npm run smoke:retell-signed"
    ].join("\n")
  );
  process.exit(1);
}

const key = signingKey;

/** POST with a valid Retell signature over the exact body bytes sent. */
async function signedRequest<T>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const signature = await Retell.sign(body, key);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-retell-signature": signature
    },
    body
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    throw new Error(
      `SIGNED ${path} unexpectedly failed (${response.status}): ${JSON.stringify(parsed)}` +
        ` — is the server running with RETELL_VERIFY_SIGNATURE=true and the SAME RETELL_API_KEY?`
    );
  }
  return parsed;
}

/** Negative control: a tampered signature MUST be rejected with 401. */
async function expectRejected(path: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const goodSig = await Retell.sign(body, key);
  // Corrupt the digest so the HMAC no longer matches the body.
  const badSig = goodSig.replace(/d=.*/, "d=deadbeefdeadbeefdeadbeefdeadbeef");
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-retell-signature": badSig },
    body
  });
  if (response.status !== 401) {
    throw new Error(
      `NEGATIVE ${path}: expected 401 for a tampered signature, got ${response.status}. ` +
        `Verification may be OFF — this smoke would false-pass. Set RETELL_VERIFY_SIGNATURE=true.`
    );
  }
  console.log(`negative-control ${path} → 401 (tampered signature rejected) ✓`);
}

function getSmokeDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const callId = `retell-signed-smoke-${Date.now()}`;
  let date = getSmokeDate(31);

  // 0) Negative control FIRST — prove the gate actually rejects bad signatures.
  await expectRejected("/retell/tools/check-availability", {
    name: "check_availability",
    call: { call_id: callId, metadata: { restaurant_id: restaurantId } },
    args: { restaurant_id: restaurantId, date, time: "19:00", party_size: 2 }
  });

  // 1) Inbound webhook — binds the agent + injects fresh dynamic variables.
  const inbound = await signedRequest<unknown>("/retell/inbound", {
    event: "call_inbound",
    call_inbound: {
      from_number: "+61400000001",
      to_number: process.env.RETELL_PHONE_NUMBER ?? "+61200000000"
    }
  });
  console.log("signed inbound ✓", JSON.stringify(inbound).slice(0, 120));

  // 2) check_availability — the tool that 401'd in production. The venue's
  // opening days are DATA, not a constant: a fixed date+time false-failed the
  // whole battery whenever day 31 landed on a closed day (30 Aug 2026). Walk
  // forward up to a week and book the first slot the venue itself says is
  // open, taking its suggested_time when the requested one is busy.
  let time = "19:00";
  let availability: { available?: boolean; suggested_time?: string | null } = {};
  let found = false;
  for (let offset = 31; offset < 38; offset += 1) {
    date = getSmokeDate(offset);
    availability = await signedRequest("/retell/tools/check-availability", {
      name: "check_availability",
      call: { call_id: callId, metadata: { restaurant_id: restaurantId } },
      args: { restaurant_id: restaurantId, date, time, party_size: 2 }
    });
    if (availability.available === true) {
      found = true;
      break;
    }
    if (availability.suggested_time) {
      time = availability.suggested_time;
      found = true;
      break;
    }
  }
  if (!found) {
    throw new Error(
      "check-availability found no open slot in a whole week of dates — either the venue's " +
        "opening hours are empty or availability is genuinely broken. Both deserve a human."
    );
  }
  console.log(
    `signed check-availability ✓ (${date} ${time})`,
    JSON.stringify(availability).slice(0, 160)
  );

  // 3) create_booking — the write that never happened on the failed call.
  const booking = await signedRequest<unknown>("/retell/tools/create-booking", {
    name: "create_booking",
    call: {
      call_id: callId,
      from_number: "+61400000001",
      metadata: { restaurant_id: restaurantId }
    },
    args: {
      restaurant_id: restaurantId,
      customer_name: "SMOKE Retell Signed",
      customer_phone: "+61400000001",
      date,
      time,
      party_size: 2,
      notes: "SMOKE — created by npm run smoke:retell-signed"
    }
  });
  console.log("signed create-booking ✓", JSON.stringify(booking).slice(0, 160));

  // Cleanup: cancel the smoke booking so repeated runs against a shared
  // staging database don't slowly eat the venue's tables. /bookings is a
  // Firebase-gated dashboard route, so this needs the smoke token; without
  // one the booking stays behind, marker-named for manual cleanup.
  const bookingId = (booking as { booking_id?: string }).booking_id;
  if (bookingId) {
    const token = await mintSmokeIdToken();
    if (token) {
      const cancel = await fetch(`${baseUrl}/bookings/${bookingId}/cancel`, {
        // The route is POST (routes/bookings.ts); this said PATCH and 404'd,
        // so every smoke run left its booking behind despite "cleanup".
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-restaurant-id": restaurantId
        },
        body: JSON.stringify({})
      });
      console.log(
        cancel.ok
          ? `cleanup: booking ${bookingId} cancelled ✓`
          : `cleanup: cancel returned ${cancel.status} — remove SMOKE bookings manually`
      );
    } else {
      console.log(`[SKIP] cleanup — no SMOKE_FIREBASE_* env; SMOKE booking ${bookingId} left behind`);
    }
  }

  console.log("\n✅ signature path verified end-to-end (gate rejects bad sigs, accepts good ones).");
}

main().catch((error) => {
  console.error("\n❌ smoke:retell-signed failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
