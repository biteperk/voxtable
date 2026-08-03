import assert from "node:assert/strict";
import test from "node:test";

import { isDefinitelyNotPurchased } from "./twilioProvisioning";

// The classification that decides whether the buy_started_at crash-window
// marker may be cleared. Wrong in the false-positive direction = possible
// double number purchase (monthly cost, forever). Wrong in the false-negative
// direction = a paying customer's provisioning permanently bricked by a
// rate-limit blip (audit B13). 4xx = provably rejected; anything else is
// ambiguous and must keep the marker.

test("a Twilio 429 rate-limit is provably not purchased", () => {
  assert.equal(isDefinitelyNotPurchased({ status: 429, message: "Too Many Requests" }), true);
});

test("other 4xx rejections are provably not purchased", () => {
  assert.equal(isDefinitelyNotPurchased({ status: 400 }), true);
  assert.equal(isDefinitelyNotPurchased({ status: 401 }), true);
  assert.equal(isDefinitelyNotPurchased({ status: 404 }), true);
});

test("5xx is ambiguous — the purchase may have executed", () => {
  assert.equal(isDefinitelyNotPurchased({ status: 500 }), false);
  assert.equal(isDefinitelyNotPurchased({ status: 503 }), false);
});

test("network errors with no status are ambiguous", () => {
  assert.equal(isDefinitelyNotPurchased(new Error("socket hang up")), false);
  assert.equal(isDefinitelyNotPurchased({ code: "ECONNRESET" }), false);
  assert.equal(isDefinitelyNotPurchased(null), false);
  assert.equal(isDefinitelyNotPurchased(undefined), false);
});

test("a non-numeric status is ambiguous", () => {
  assert.equal(isDefinitelyNotPurchased({ status: "429" }), false);
});
