/**
 * `venue_faq` is venue-authored text that ends up inside the agent's prompt and
 * then in a caller's ear, so the interesting cases are all the malformed ones.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FAQ_MAX_ENTRIES, FAQ_MAX_TOTAL_CHARS, formatVenueFaq } from "./venueFaq";

test("an empty or missing FAQ yields an empty string, not a placeholder", () => {
  // "" is what makes the prompt fall through to "let me take a message".
  assert.equal(formatVenueFaq({}), "");
  assert.equal(formatVenueFaq(null), "");
  assert.equal(formatVenueFaq(undefined), "");
});

test("keys are humanised into something speakable", () => {
  // The rule: split camelCase and separators, capitalise the first character,
  // and leave the rest as the venue wrote it. Casing is inaudible, so the point
  // of leaving it alone is acronyms — see the BYO case below.
  assert.equal(formatVenueFaq({ parking: "Street parking nearby." }), "Parking: Street parking nearby.");
  assert.equal(
    formatVenueFaq({ wheelchair_access: "Step-free entry." }),
    "Wheelchair access: Step-free entry."
  );
  assert.equal(formatVenueFaq({ dogFriendly: "Dogs welcome outside." }), "Dog Friendly: Dogs welcome outside.");
});

test("acronym keys are not mangled", () => {
  // Force-lowercasing to make casing uniform would turn BYO into "Byo", which a
  // TTS voice reads as a word rather than three letters.
  assert.match(formatVenueFaq({ BYO: "BYO wine welcome." }), /^BYO: /);
});

test("hyphens survive sanitising", () => {
  // The control-character class must not eat ordinary punctuation — "Gluten-free"
  // becoming "Glutenfree" would be read aloud that way.
  const out = formatVenueFaq({ dietary: "Gluten-free and vegan options available." });
  assert.match(out, /Gluten-free/);
});

test("non-string values are skipped, never coerced", () => {
  // Otherwise a caller hears "[object Object]".
  const out = formatVenueFaq({ parking: { street: true }, dogs: "Dogs welcome." });
  assert.equal(out, "Dogs: Dogs welcome.");
  assert.doesNotMatch(out, /object/i);
});

test("braces are stripped so venue text cannot look like a template variable", () => {
  const out = formatVenueFaq({ note: "Ask for {{owner_name}} at the door." });
  assert.doesNotMatch(out, /[{}]/);
  assert.match(out, /Ask for owner_name at the door\./);
});

test("newlines and control characters collapse to single spaces", () => {
  const out = formatVenueFaq({ parking: "Street parking.\n\tRear lane after 6pm." });
  assert.equal(out, "Parking: Street parking. Rear lane after 6pm.");
});

test("an over-long single answer is dropped whole, never cut mid-sentence", () => {
  const long = `${"x".repeat(400)}.`;
  const out = formatVenueFaq({ rambling: long, parking: "Street parking." });
  assert.equal(out, "Parking: Street parking.");
  assert.doesNotMatch(out, /x/);
});

test("the total stays within budget and drops whole entries to get there", () => {
  const faq: Record<string, string> = {};
  for (let i = 0; i < 12; i += 1) faq[`fact${i}`] = "y".repeat(150);

  const out = formatVenueFaq(faq);
  assert.ok(out.length <= FAQ_MAX_TOTAL_CHARS, `expected <= ${FAQ_MAX_TOTAL_CHARS}, got ${out.length}`);
  // Whatever survived must be complete entries, so every 'y' run is full length.
  for (const run of out.match(/y+/g) ?? []) {
    assert.equal(run.length, 150, "an entry was truncated instead of dropped");
  }
});

test("entry count is capped", () => {
  const faq: Record<string, string> = {};
  for (let i = 0; i < 30; i += 1) faq[`k${i}`] = "short";
  const entries = formatVenueFaq(faq).split(/(?=\bK\d+: )/).filter(Boolean);
  assert.ok(entries.length <= FAQ_MAX_ENTRIES, `expected <= ${FAQ_MAX_ENTRIES}, got ${entries.length}`);
});

test("output is stable regardless of key insertion order", () => {
  // Postgres normalises jsonb key order, so the same FAQ can arrive with its
  // keys in a different sequence depending on how the row was written. The
  // rendered string must not change with it — otherwise an over-budget FAQ
  // drops a different answer each time and nothing about it is reproducible.
  const a = formatVenueFaq({ parking: "Street parking.", dogs: "Dogs welcome.", byo: "BYO wine." });
  const b = formatVenueFaq({ byo: "BYO wine.", parking: "Street parking.", dogs: "Dogs welcome." });
  assert.equal(a, b);
});

test("a realistic Mazcina FAQ fits comfortably", () => {
  const out = formatVenueFaq({
    parking: "Street parking on Palmer Street.",
    wheelchair_access: "Step-free access throughout.",
    dogs: "Dogs are welcome at the outdoor tables.",
    outdoor_seating: "Patio seating available.",
    byo: "BYO wine is welcome; a corkage fee applies.",
    dietary: "Gluten-free and vegan options are marked on the menu.",
    takeaway: "Takeaway is available for the whole menu.",
    payment: "We accept AMEX, Mastercard and Visa."
  });
  assert.ok(out.length <= FAQ_MAX_TOTAL_CHARS);
  assert.match(out, /Palmer Street/);
  assert.match(out, /corkage/);
});
