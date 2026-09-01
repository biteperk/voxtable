/**
 * The largest party the agent may book without a human.
 *
 * Mazcina's owner asked for anything above a small party to reach him
 * personally. Enforced in the backend rather than the prompt because
 * check_availability would otherwise report a genuinely free table for a larger
 * party — and an agent that has just been told a table is free will book it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { exceedsAutoBookCap, partyTooLargeResponse } from "./retellService";

test("parties at or under the cap are booked as normal", () => {
  for (const size of [1, 2, 3, 4]) {
    assert.equal(exceedsAutoBookCap(size, 4), false, `${size} should be auto-booked`);
  }
});

test("parties above the cap are handed to the venue", () => {
  for (const size of [5, 6, 12]) {
    assert.equal(exceedsAutoBookCap(size, 4), true, `${size} should hand off`);
  }
});

test("a cap of 0 disables the rule entirely", () => {
  // The shipped default. A venue that never set a cap must not suddenly start
  // refusing parties.
  assert.equal(exceedsAutoBookCap(50, 0), false);
});

test("an unusable party size never triggers a handoff", () => {
  // The size arrives from tool arguments, so it can be missing or unparseable.
  // Refusing on NaN would hand off every caller.
  for (const size of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(exceedsAutoBookCap(size as number | undefined, 4), false, String(size));
  }
});

test("the handoff names the owner and asks for a number", () => {
  const r = partyTooLargeResponse(8, "Camilo");
  assert.equal(r.available, false);
  assert.equal(r.reason, "party_needs_venue");
  assert.match(r.message, /group of 8/);
  assert.match(r.message, /Camilo/);
  assert.match(r.message, /number/i);
  // Every field the prompt might read must carry the same words, so the agent
  // cannot pick one that still sounds like a refusal to book.
  assert.equal(r.natural_alternatives_message, r.message);
  assert.equal(r.confirmation_message, r.message);
});

test("a venue with no owner name still hands off gracefully", () => {
  for (const name of [null, "", "   "]) {
    const r = partyTooLargeResponse(8, name);
    assert.match(r.message, /the team/);
    assert.ok(!r.message.includes("null"), "must never speak a null owner name");
  }
});
