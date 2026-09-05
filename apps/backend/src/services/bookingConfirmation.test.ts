import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenBookingChange, spokenBookingConfirmation } from "./bookingConfirmation";

test("booking confirmation carries the name and nothing else", () => {
  assert.equal(spokenBookingConfirmation("Megan"), "All set, Megan.");
  assert.equal(spokenBookingConfirmation("  "), "All set.");
  // The regression this guards: no date, time or party size in the sentence.
  assert.doesNotMatch(spokenBookingConfirmation("Megan"), /\d/);
});

test("a change confirms only the changed value", () => {
  assert.equal(spokenBookingChange({ time: "8 PM" }), "Done, moved to 8 PM.");
  assert.equal(spokenBookingChange({ partySize: 4 }), "Done, now for 4.");
  assert.equal(spokenBookingChange({ name: "Sarah" }), "Done, under Sarah now.");
  assert.equal(
    spokenBookingChange({ date: "Fri 5 Sep", time: "7:30 PM", partySize: 3 }),
    "Done, moved to Fri 5 Sep at 7:30 PM, now for 3."
  );
  assert.equal(spokenBookingChange({}), "Done, that's updated.");
});

import { availabilityNextStep } from "./retellService";

test("an available slot tells the agent to confirm once and wait before booking", () => {
  const step = availabilityNextStep({ available: true });
  assert.match(step ?? "", /Do NOT call create_booking in this turn/);
  assert.match(step ?? "", /shall I lock it in\?/);
});

test("an unavailable slot with alternatives still routes through the single confirm", () => {
  assert.match(availabilityNextStep({ available: false, suggestedTimes: ["19:00"] }) ?? "", /WAIT for their yes/);
  assert.equal(availabilityNextStep({ available: false, reason: "party_too_large" }), undefined);
  assert.equal(availabilityNextStep({ available: false, suggestedTimes: [] }), undefined);
});
