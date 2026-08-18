/**
 * The SMS sender decision.
 *
 * This exists for one Twilio behaviour that is invisible in our own code:
 * passing `messagingServiceSid` and `from` TOGETHER switches OFF the Messaging
 * Service's automatic sender selection and pins the `From`. Production already
 * has NOTIFICATIONS_SMS_FROM set, so a naive spread of both would have pinned
 * the phone number permanently — and adding the ACMA-approved `BitePerk`
 * alphanumeric sender to the pool would then have done nothing at all, with no
 * error anywhere. These tests are the guard for that.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveSmsSender } from "./notificationService";

const MG = "MG7ceaa2aaa3cea6195ea7979d57b78b14";
const NUMBER = "+61468202846";

test("the Messaging Service wins when both senders are configured", () => {
  const sender = resolveSmsSender({ messagingServiceSid: MG, smsFrom: NUMBER });
  assert.deepEqual(sender, { messagingServiceSid: MG });
});

test("never returns both parameters — that would pin the sender and un-brand every message", () => {
  const sender = resolveSmsSender({ messagingServiceSid: MG, smsFrom: NUMBER });
  assert.ok(sender !== null);
  assert.deepEqual(Object.keys(sender), ["messagingServiceSid"]);
  assert.ok(!("from" in sender));
});

test("falls back to the bare from when no Messaging Service is set", () => {
  assert.deepEqual(resolveSmsSender({ smsFrom: NUMBER }), { from: NUMBER });
});

test("returns null when neither sender is configured, so the channel stays unclaimed", () => {
  // The worker leaves rows for an unsendable channel pending rather than
  // burning attempts, so null here means "wait", not "fail".
  assert.equal(resolveSmsSender({}), null);
  assert.equal(resolveSmsSender({ messagingServiceSid: "", smsFrom: "" }), null);
});
