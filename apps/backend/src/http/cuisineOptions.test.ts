/**
 * The cuisine list exists twice: the backend enum that VALIDATES a profile save,
 * and the array the onboarding form OFFERS. They are not imported from one
 * another — the frontend is a separate Vite app — so they can drift silently.
 *
 * Drift is one-directional and quiet: an option present in the backend but
 * missing from the form is simply an option no venue can ever pick, and an
 * option present in the form but missing from the backend is a 400 at the end
 * of a wizard step the user has already filled in.
 *
 * Same shape as envExample.test.ts, which guards .env.example against env.ts
 * for the same reason.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CUISINE_OPTIONS } from "./schemas";

const PROFILE_STEP = path.join(
  __dirname,
  "../../../frontend/src/pages/onboarding/steps/ProfileStep.jsx"
);

function cuisinesOfferedByTheForm(): string[] {
  const source = readFileSync(PROFILE_STEP, "utf8");
  const match = /const ONBOARDING_CUISINES = \[([\s\S]*?)\];/.exec(source);
  assert.ok(match, "could not find ONBOARDING_CUISINES in ProfileStep.jsx — has it been renamed?");
  return Array.from(match[1]!.matchAll(/"([^"]+)"/g)).map((m) => m[1]!);
}

test("the onboarding form offers exactly the cuisines the backend accepts", () => {
  const offered = cuisinesOfferedByTheForm();
  const accepted = [...CUISINE_OPTIONS];

  const notOffered = accepted.filter((c) => !offered.includes(c));
  const notAccepted = offered.filter((c) => !accepted.includes(c));

  assert.deepEqual(notOffered, [], `accepted by the backend but never offered: ${notOffered.join(", ")}`);
  assert.deepEqual(notAccepted, [], `offered by the form but rejected on save: ${notAccepted.join(", ")}`);
});

test("the list can describe a Mediterranean / South American venue", () => {
  // Mazcina, the first real venue to reach this step, is exactly that fusion.
  assert.ok(CUISINE_OPTIONS.includes("Mediterranean"));
  assert.ok(CUISINE_OPTIONS.includes("South American"));
});
