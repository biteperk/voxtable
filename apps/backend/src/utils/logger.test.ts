/**
 * Redaction rules.
 *
 * The logger is the one place every subsystem writes to, so a gap here leaks
 * from everywhere at once. These cover the four shapes that used to pass
 * through untouched — a plain email address, a bare Firebase ID token, a
 * Stripe webhook secret, and an Australian number written with the country
 * code but no plus — plus the fields that carry a caller's own words.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { logger, redactSecrets } from "./logger";

/** Capture one line of logger output without writing it to the test run. */
function captureLine(emit: () => void): Record<string, unknown> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  (process.stdout as NodeJS.WriteStream).write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    emit();
  } finally {
    (process.stdout as NodeJS.WriteStream).write = original;
  }
  return JSON.parse(captured.trim());
}

test("email addresses are masked in free text", () => {
  const out = redactSecrets("no membership for sam.k+test@example.com — refusing");
  assert.ok(!out.includes("sam.k+test@example.com"));
  assert.ok(out.includes("[REDACTED-EMAIL]"));
});

test("a bare JWT is masked even without the Bearer prefix", () => {
  const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1aWQtMSJ9.c2lnbmF0dXJlLWhlcmU";
  const out = redactSecrets(`verifyIdToken failed for ${jwt}`);
  assert.ok(!out.includes(jwt));
  assert.ok(out.includes("[REDACTED-JWT]"));
});

test("a Stripe webhook secret is masked", () => {
  const out = redactSecrets("whsec_abcdefghijklmnopqrstuvwxyz012345 rejected");
  assert.ok(!out.includes("abcdefghijklmnopqrstuvwxyz012345"));
  assert.ok(out.includes("whsec_[REDACTED]"));
});

test("phone numbers are masked in all three shapes we actually receive", () => {
  assert.ok(!redactSecrets("called +61412345678").includes("412345678"));
  assert.ok(!redactSecrets("called 0412345678").includes("0412345678"));
  assert.ok(!redactSecrets("called 61412345678").includes("61412345678"));
});

test("numbers that are not phone numbers stay readable", () => {
  // An epoch millisecond timestamp and a cents total are exactly the numbers an
  // incident is read with. A blanket "any 10-15 digits" rule would eat both.
  const out = redactSecrets("ordered_at=1754130000000 total_cents=1299000");
  assert.ok(out.includes("1754130000000"));
  assert.ok(out.includes("1299000"));
});

test("the existing API-key patterns still hold", () => {
  assert.ok(redactSecrets("cal_live_0123456789abcdef0123").includes("cal_live_[REDACTED]"));
  assert.ok(redactSecrets("sk_live_0123456789abcdefghijkl").includes("sk_live_[REDACTED]"));
  assert.ok(redactSecrets("Bearer abc.def.ghi").includes("Bearer [REDACTED]"));
});

test("keys carrying a caller's own words are redacted whole", () => {
  const line = captureLine(() =>
    logger.info({
      evt: "call_analyzed",
      transcript: "Hi, it's Sam, my mobile is 0412 345 678",
      special_requests: "wheelchair access, nut allergy",
      caller_name: "Sam Kalaliya"
    })
  );
  assert.equal(line.transcript, "[REDACTED]");
  assert.equal(line.special_requests, "[REDACTED]");
  assert.equal(line.caller_name, "[REDACTED]");
});

test("qualified key names are redacted, not just bare ones", () => {
  const line = captureLine(() =>
    logger.info({
      evt: "outbound",
      to_email: "guest@example.com",
      customerPhone: "+61412345678",
      webhook_secret: "whsec_something",
      idToken: "eyJ.a.b"
    })
  );
  assert.equal(line.to_email, "[REDACTED]");
  assert.equal(line.customerPhone, "[REDACTED]");
  assert.equal(line.webhook_secret, "[REDACTED]");
  assert.equal(line.idToken, "[REDACTED]");
});

test("keys that merely contain a sensitive word stay readable", () => {
  // Over-redaction is its own outage: these are the fields you read to work out
  // why auth is failing.
  const line = captureLine(() =>
    logger.info({ evt: "auth", email_verified: true, tokens_used: 42, restaurant_name: "Natalia" })
  );
  assert.equal(line.email_verified, true);
  assert.equal(line.tokens_used, 42);
  assert.equal(line.restaurant_name, "Natalia");
});

test("nested objects and arrays are redacted too", () => {
  const line = captureLine(() =>
    logger.info({ evt: "booking", customer: { email: "a@b.com", name: "Sam" } })
  );
  assert.deepEqual(line.customer, { email: "[REDACTED]", name: "Sam" });
});

// ---------------------------------------------------------------------------
// Log-context correlation (Block 5: provider_call_id + worker tick ids)
// ---------------------------------------------------------------------------

import { enrichLogContext, withLogContext, withTickLogContext } from "./logger";

test("provider_call_id pinned via enrichLogContext appears on every line", () => {
  const line = captureLine(() => {
    withLogContext({ request_id: "req-1" }, () => {
      enrichLogContext({ provider_call_id: "call_abc123" });
      logger.info({ evt: "retell_tool_call", tool: "create_booking" });
    });
  });
  assert.equal(line.request_id, "req-1");
  assert.equal(line.provider_call_id, "call_abc123");
});

test("lines outside a Retell context carry no provider_call_id key", () => {
  const line = captureLine(() => {
    withLogContext({ request_id: "req-2" }, () => {
      logger.info({ evt: "http_request" });
    });
  });
  assert.equal("provider_call_id" in line, false);
});

test("enrichLogContext outside any context is a safe no-op", () => {
  enrichLogContext({ provider_call_id: "call_orphan" });
  const line = captureLine(() => {
    logger.info({ evt: "no_context" });
  });
  assert.equal("provider_call_id" in line, false);
});

test("worker ticks get a distinguishable, monotonic request_id", () => {
  const first = captureLine(() => {
    withTickLogContext("health-alerter", () => logger.info({ evt: "tick" }));
  });
  const second = captureLine(() => {
    withTickLogContext("health-alerter", () => logger.info({ evt: "tick" }));
  });
  assert.match(String(first.request_id), /^health-alerter#\d+$/);
  assert.match(String(second.request_id), /^health-alerter#\d+$/);
  assert.notEqual(first.request_id, second.request_id);
});
