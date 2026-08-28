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

import { resolveSmsSender, shouldTextOrderConfirmation } from "./notificationService";

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

// --- shouldTextOrderConfirmation ---------------------------------------------
// Each of these is a bug that was shipped or nearly shipped.

const TEXTABLE = {
  isTakeaway: true,
  isReplay: false,
  flagEnabled: true,
  senderConfigured: true,
  hasPhone: true
};

test("texts the guest for a takeaway order when everything is configured", () => {
  assert.equal(shouldTextOrderConfirmation(TEXTABLE), true);
});

test("no text without a configured sender — otherwise rows queue and flush later", () => {
  // The failure this prevents is silent: the worker leaves unsendable rows
  // pending, and switching a sender on days later texts everyone at once about
  // orders they already collected.
  assert.equal(shouldTextOrderConfirmation({ ...TEXTABLE, senderConfigured: false }), false);
});

test("no text when the flag is off, even with a sender configured", () => {
  assert.equal(shouldTextOrderConfirmation({ ...TEXTABLE, flagEnabled: false }), false);
});

test("no text on a replayed tool call — a retry must not text twice", () => {
  assert.equal(shouldTextOrderConfirmation({ ...TEXTABLE, isReplay: true }), false);
});

test("no text for a dine-in pre-order — its booking already confirmed", () => {
  assert.equal(shouldTextOrderConfirmation({ ...TEXTABLE, isTakeaway: false }), false);
});

test("no text for a withheld caller ID", () => {
  assert.equal(shouldTextOrderConfirmation({ ...TEXTABLE, hasPhone: false }), false);
});
