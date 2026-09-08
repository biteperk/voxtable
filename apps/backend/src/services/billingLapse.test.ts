import assert from "node:assert/strict";
import test from "node:test";

import { eventForSubscriptionStatus } from "./stripeService";

// The split that makes the 3-day recoverable pause possible: a failed payment is
// SOFT (start the grace clock, keep the venue live), and only a Stripe-side
// give-up is HARD (suspend at once). Before this, all four lapsed states
// suspended on the first failure.
test("past_due and unpaid are soft — they start the grace, not a suspend", () => {
  assert.equal(eventForSubscriptionStatus("past_due"), "subscription_past_due");
  assert.equal(eventForSubscriptionStatus("unpaid"), "subscription_past_due");
});

test("canceled and incomplete_expired are hard — Stripe gave up, suspend now", () => {
  assert.equal(eventForSubscriptionStatus("canceled"), "subscription_lapsed");
  assert.equal(eventForSubscriptionStatus("incomplete_expired"), "subscription_lapsed");
});

test("active and trialing are recovery/normal", () => {
  assert.equal(eventForSubscriptionStatus("active"), "subscription_active");
  assert.equal(eventForSubscriptionStatus("trialing"), "subscription_active");
});

test("statuses we don't act on return null", () => {
  assert.equal(eventForSubscriptionStatus("incomplete"), null);
  assert.equal(eventForSubscriptionStatus("paused"), null);
});
