/**
 * The "your number is ready" email must fire on a TRANSITION, never on a state.
 *
 * The admin bind route used to send it whenever the venue currently held both a
 * Twilio number and a Retell agent. That is equally true on every subsequent
 * bind, so correcting a typo in the Cal.com field re-sent the launch email to a
 * live venue's owner — and enqueueNotification has no per-kind dedupe, so
 * nothing downstream caught it. These cases lock the rule.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { becameLineReady } from "./onboardingService";

const bound = { twilio_phone_number: "+61468202846", retell_agent_id: "agent_abc" };
const unbound = { twilio_phone_number: null, retell_agent_id: null };

test("binding a previously unbound venue notifies", () => {
  assert.equal(becameLineReady(unbound, bound), true);
});

test("re-binding an already-ready venue does NOT notify — the bug this fixes", () => {
  assert.equal(becameLineReady(bound, bound), false);
});

test("editing another field on a ready venue does NOT notify", () => {
  // What actually happened: only calcom_event_type_id changed, both line
  // columns unchanged, and the owner got the launch email a second time.
  assert.equal(becameLineReady(bound, { ...bound }), false);
});

test("a half-bind does not notify — the line cannot ring yet", () => {
  assert.equal(
    becameLineReady(unbound, { twilio_phone_number: "+61468202846", retell_agent_id: null }),
    false
  );
  assert.equal(
    becameLineReady(unbound, { twilio_phone_number: null, retell_agent_id: "agent_abc" }),
    false
  );
});

test("completing a half-bind notifies once", () => {
  const half = { twilio_phone_number: "+61468202846", retell_agent_id: null };
  assert.equal(becameLineReady(half, bound), true);
});

test("clearing a ready line does not notify", () => {
  assert.equal(becameLineReady(bound, unbound), false);
});

test("a missing row on either side is not a transition", () => {
  assert.equal(becameLineReady(null, null), false);
  assert.equal(becameLineReady(bound, null), false);
  assert.equal(becameLineReady(undefined, bound), true);
});

test("empty strings count as unbound, not bound", () => {
  // The columns are plain TEXT; an empty string is not a dialable number.
  assert.equal(becameLineReady(unbound, { twilio_phone_number: "", retell_agent_id: "" }), false);
});
