import assert from "node:assert/strict";
import test from "node:test";

import { lineState, readinessChecks } from "./venueLine.js";

test("an unbound venue is not live, even when nothing is paused", () => {
  // The exact bug this replaces: the old panel read voice_paused_at alone and
  // rendered a green "Live" pill for this venue.
  assert.equal(lineState({ twilio_phone_number: null, retell_agent_id: null }), "no_line");
});

test("both bindings and no pause is live", () => {
  assert.equal(
    lineState({ twilio_phone_number: "+61468202846", retell_agent_id: "agent_x" }),
    "live"
  );
});

test("a pause only counts once the line is actually bound", () => {
  const paused = new Date().toISOString();
  assert.equal(
    lineState({ twilio_phone_number: "+61468202846", retell_agent_id: "agent_x", voice_paused_at: paused }),
    "paused"
  );
  assert.equal(
    lineState({ twilio_phone_number: null, retell_agent_id: null, voice_paused_at: paused }),
    "no_line"
  );
});

test("half a binding is its own state, never 'live'", () => {
  assert.equal(lineState({ twilio_phone_number: "+61468202846" }), "half_bound");
  assert.equal(lineState({ retell_agent_id: "agent_x" }), "half_bound");
});

test("a missing venue is treated as having no line rather than throwing", () => {
  assert.equal(lineState(undefined), "no_line");
  assert.equal(lineState(null), "no_line");
});

test("readiness reports each missing piece separately", () => {
  const checks = readinessChecks({
    provisioning: { twilio_phone_number: "+61", retell_agent_id: "agent_x" },
    readiness: { menu_items: 39, tables: 0, hours_set: true, faq_set: false }
  });
  const byKey = Object.fromEntries(checks.map((c) => [c.key, c.ok]));
  // Camilo's venue on 7 Sep 2026: a clean 39-item menu and no tables at all,
  // which the old screen showed as simply "live".
  assert.equal(byKey.menu, true);
  assert.equal(byKey.tables, false);
  assert.equal(byKey.hours, true);
  assert.equal(byKey.faq, false);
  assert.equal(byKey.line, true);
});

test("readiness on an empty payload is all-false rather than a crash", () => {
  const checks = readinessChecks({});
  assert.equal(checks.length, 5);
  assert.ok(checks.every((c) => c.ok === false));
});
