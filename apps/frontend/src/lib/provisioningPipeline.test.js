import assert from "node:assert/strict";
import test from "node:test";

import { nextAction, pipelineFor, waitingHours } from "./provisioningPipeline.js";

const states = (venue) => pipelineFor(venue).map((s) => `${s.key}:${s.state}`).join(" ");

test("a venue with nothing bound is pending on the number", () => {
  assert.equal(
    states({ onboarding_status: "provisioning" }),
    "number:pending agent:waiting bound:waiting live:waiting"
  );
  assert.match(nextAction({ onboarding_status: "provisioning" }), /Twilio number/);
});

test("exactly one step is ever pending", () => {
  for (const venue of [
    {},
    { twilio_phone_number: "+61" },
    { twilio_phone_number: "+61", retell_agent_id: "agent_x" },
    { twilio_phone_number: "+61", retell_agent_id: "agent_x", onboarding_status: "live" }
  ]) {
    const pending = pipelineFor(venue).filter((s) => s.state === "pending");
    assert.ok(pending.length <= 1, `${JSON.stringify(venue)} had ${pending.length} pending steps`);
  }
});

test("half a binding does not count as bound", () => {
  // Camilo's venue on 7 Sep 2026 sat here. "Bound" must mean both halves,
  // because that is the state the API enforces and the wizard waits on.
  assert.equal(
    states({ twilio_phone_number: "+61468202846", onboarding_status: "provisioning" }),
    "number:done agent:pending bound:waiting live:waiting"
  );
});

test("both bindings stored leaves only go-live outstanding", () => {
  assert.equal(
    states({ twilio_phone_number: "+61", retell_agent_id: "agent_x", onboarding_status: "provisioning" }),
    "number:done agent:done bound:done live:pending"
  );
  assert.match(
    nextAction({ twilio_phone_number: "+61", retell_agent_id: "agent_x" }),
    /take this venue live/i
  );
});

test("a live venue has no next action", () => {
  const venue = { twilio_phone_number: "+61", retell_agent_id: "agent_x", onboarding_status: "live" };
  assert.equal(states(venue), "number:done agent:done bound:done live:done");
  assert.equal(nextAction(venue), null);
});

test("waiting hours floors, tolerates a missing date, and never goes negative", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  assert.equal(waitingHours("2026-09-07T08:30:00Z", now), 3);
  assert.equal(waitingHours(null, now), null);
  // Clock skew between the browser and the server must not print "-1h waiting".
  assert.equal(waitingHours("2026-09-07T12:05:00Z", now), 0);
});
