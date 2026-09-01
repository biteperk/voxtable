/**
 * Whether the agent knows the caller's number.
 *
 * A withheld caller ID arrives as "anonymous" and is normalised to "" before it
 * reaches the agent, because passing the literal string through made the agent
 * feed "anonymous" to create_booking (400, live call 19 Aug 2026).
 *
 * The prompt then has to decide whether to ask for a number. Branching on "is
 * {{caller_phone}} empty" asks a model to reason about the absence of a value,
 * and it guesses — so it gets a literal "yes"/"no" to match instead. The
 * staging prompt already relies on this variable; the backend was not sending
 * it, so a withheld-ID caller could be booked with no way to reach them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { callerPhoneKnownFlag } from "./retellService";

test("a usable number is known", () => {
  assert.equal(callerPhoneKnownFlag("+61400000000"), "yes");
});

test("a withheld caller ID is not known", () => {
  // normalizePhone returns null for anonymous/unknown/private/blocked/
  // restricted, and the caller then reaches this as "".
  assert.equal(callerPhoneKnownFlag(""), "no");
});

test("the answer is always a literal the prompt can match", () => {
  // Never a boolean, never empty. Retell renders variables as strings, and a
  // prompt comparing against "yes"/"no" must get exactly those.
  for (const input of ["", "+61400000000"]) {
    const flag = callerPhoneKnownFlag(input);
    assert.ok(flag === "yes" || flag === "no", `got ${JSON.stringify(flag)}`);
  }
});
