/**
 * `/cal/webhook` signature verification.
 *
 * The verifier length-checked the signature STRING and then compared the
 * decoded BUFFERS. `Buffer.from(s, "hex")` stops at the first character that
 * isn't a hex digit, so a 64-character signature made of anything else decoded
 * to zero bytes, `timingSafeEqual` threw RangeError on the length mismatch, and
 * an unauthenticated caller got a 500 out of the webhook for one request. The
 * first test below is that exact input.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { env } from "../config/env";
import { verifyCalcomSignature } from "./calcomService";

const SECRET = env.CALCOM_WEBHOOK_SECRET;
const BODY = JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: { uid: "abc" } });

const sign = (body: string): string =>
  crypto.createHmac("sha256", SECRET!).update(body).digest("hex");

test("the test environment supplies a webhook secret", () => {
  // Without it every assertion below would pass for the wrong reason: the
  // verifier returns false whenever the secret is unset.
  assert.ok(SECRET, "CALCOM_WEBHOOK_SECRET must be set by the test script");
});

test("a 64-character non-hex signature is rejected, not raised", () => {
  const garbage = "z".repeat(64);
  assert.equal(garbage.length, sign(BODY).length);
  assert.doesNotThrow(() => verifyCalcomSignature(BODY, garbage));
  assert.equal(verifyCalcomSignature(BODY, garbage), false);
});

test("a signature of the right length with some non-hex characters is rejected", () => {
  const valid = sign(BODY);
  const tainted = `${valid.slice(0, 60)}zzzz`;
  assert.doesNotThrow(() => verifyCalcomSignature(BODY, tainted));
  assert.equal(verifyCalcomSignature(BODY, tainted), false);
});

test("a correct signature is accepted", () => {
  assert.equal(verifyCalcomSignature(BODY, sign(BODY)), true);
});

test("a correct signature with the sha256= prefix is accepted", () => {
  assert.equal(verifyCalcomSignature(BODY, `sha256=${sign(BODY)}`), true);
});

test("a signature for a different body is rejected", () => {
  assert.equal(verifyCalcomSignature(BODY, sign(`${BODY} `)), false);
});

test("short, empty and missing signatures are rejected", () => {
  assert.equal(verifyCalcomSignature(BODY, "abcd"), false);
  assert.equal(verifyCalcomSignature(BODY, ""), false);
  assert.equal(verifyCalcomSignature(BODY, undefined), false);
});

test("an odd-length hex string is rejected", () => {
  // Buffer.from drops the trailing nibble, which is another way to arrive at
  // two buffers of different lengths.
  assert.doesNotThrow(() => verifyCalcomSignature(BODY, sign(BODY).slice(0, 63)));
  assert.equal(verifyCalcomSignature(BODY, sign(BODY).slice(0, 63)), false);
});
