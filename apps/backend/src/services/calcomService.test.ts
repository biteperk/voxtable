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
import { AppError } from "../domain/errors";
import {
  isSynthesizedEmail,
  isTerminalBookingRefusal,
  synthesizedEmail,
  verifyCalcomSignature
} from "./calcomService";

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

// --- inbound failure classification (the cancel-back decision) ---------------
//
// This is the test that matters most on the inbound path, because getting it
// wrong is not a crash — it is cancelling a real guest's table.
//
// TABLE_JUST_TAKEN is a 409, so the old statusCode-based test called it a
// refusal and cancelled the guest's Cal.com booking. But it is raised ONLY by
// the overlap constraint firing, i.e. a concurrent writer beat us. That is
// contention, and it must be retried.

test("a genuine 'no table' refusal is terminal — the guest is told", () => {
  assert.equal(isTerminalBookingRefusal(new AppError(409, "BOOKING_NOT_AVAILABLE", "full")), true);
  assert.equal(isTerminalBookingRefusal(new AppError(400, "BOOKING_DATE_IN_PAST", "past")), true);
  assert.equal(isTerminalBookingRefusal(new AppError(409, "TABLE_NOT_AVAILABLE", "no fit")), true);
});

test("TABLE_JUST_TAKEN is contention, not a decision — it must be retried", () => {
  // Same HTTP status as a real refusal. Only the code tells them apart.
  assert.equal(isTerminalBookingRefusal(new AppError(409, "TABLE_JUST_TAKEN", "raced")), false);
});

test("infrastructure failures are never treated as a refusal", () => {
  assert.equal(isTerminalBookingRefusal(new Error("connection terminated")), false);
  assert.equal(isTerminalBookingRefusal(new AppError(500, "INTERNAL", "boom")), false);
  // An unlisted code defaults to retry: a retry costs work, a wrong refusal
  // costs a guest their table.
  assert.equal(isTerminalBookingRefusal(new AppError(409, "SOME_NEW_CODE", "?")), false);
});

// --- synthetic attendee addresses ---------------------------------------------
// The domain moved off another company's name. What matters is not the new value
// but that the OLD one is still recognised: those addresses live in Cal.com's
// records, not ours, and a booking made under the old domain can be cancelled or
// rescheduled long after the rename.

const LEGACY_DOMAIN = "bookings.vocotable.algorythmos.com.au";
const CURRENT_DOMAIN = "bookings.voxtable.biteperk.com.au";

test("mints addresses under the current domain", () => {
  assert.equal(synthesizedEmail("+61450011140"), `61450011140@${CURRENT_DOMAIN}`);
  assert.equal(synthesizedEmail(null), `unknown@${CURRENT_DOMAIN}`);
});

test("recognises addresses minted under the CURRENT domain", () => {
  assert.equal(isSynthesizedEmail(`61450011140@${CURRENT_DOMAIN}`), true);
});

test("still recognises addresses minted under the LEGACY domain", () => {
  // The regression test for the rename. Without this, a historical booking's
  // synthetic address reads as a real customer contact detail.
  assert.equal(isSynthesizedEmail(`61450011140@${LEGACY_DOMAIN}`), true);
  assert.equal(isSynthesizedEmail(`unknown@${LEGACY_DOMAIN}`), true);
});

test("a real customer address is not synthetic", () => {
  assert.equal(isSynthesizedEmail("diner@gmail.com"), false);
  assert.equal(isSynthesizedEmail(""), false);
  assert.equal(isSynthesizedEmail(null), false);
  assert.equal(isSynthesizedEmail(undefined), false);
});
