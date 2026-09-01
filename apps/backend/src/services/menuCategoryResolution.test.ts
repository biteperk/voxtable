/**
 * Answering a section request with the wrong section.
 *
 * Mazcina's owner asked Bella for STARTER suggestions and was offered one
 * starter, one side and one salad. The categories were never wrong: the bug was
 * precedence in lookupMenu — a non-generic `query` returned before the category
 * parameter was read, so "suggestions for starters" was searched as a dish name
 * by trigram similarity across all 97 items.
 *
 * The DB half is covered by smoke:menu-recommendations. These are the two pure
 * decisions underneath it: is the caller naming a section, and which section.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { categoryShapedQuery, resolveCategoryHits } from "./menuService";

// Mazcina's real sections, as imported.
const MAZCINA = [
  "Starters",
  "Mains",
  "Sides",
  "Salads",
  "Sandwiches",
  "Desserts",
  "Kids Menu",
  "Chef Suggestions for Sharing",
  "Cocktails",
  "Mocktails & Frappes",
  "Juices & Soft Drinks",
  "Beer, Wine & Spirits"
].map((name) => ({ name }));

const hits = (word: string) => resolveCategoryHits(MAZCINA, word).map((c) => c.name);

test("the owner's own question resolves to the starters section", () => {
  const word = categoryShapedQuery("Can I have some suggestions for starters?");
  assert.equal(word, "starters");
  assert.deepEqual(hits(word!), ["Starters"]);
});

test("plain substring matching still works, and is not regressed by synonyms", () => {
  for (const [word, expected] of [
    ["starters", "Starters"],
    ["mains", "Mains"],
    ["sides", "Sides"],
    ["salads", "Salads"],
    ["desserts", "Desserts"],
    ["kids", "Kids Menu"],
    // Both already matched as substrings of "Chef Suggestions for Sharing".
    ["sharing", "Chef Suggestions for Sharing"],
    ["chef", "Chef Suggestions for Sharing"]
  ] as const) {
    assert.deepEqual(hits(word), [expected], `${word} should reach ${expected}`);
  }
});

test("the words callers actually use for starters reach the starters section", () => {
  // Every one of these returned "we don't have a starters section" before.
  // "entree" is a STARTER in Australian usage — this venue is in Sydney.
  for (const word of [
    "entree",
    "entrees",
    "entrée",
    "appetiser",
    "appetizers",
    "small plates",
    "nibbles",
    "to start",
    "something to start"
  ]) {
    assert.deepEqual(hits(word), ["Starters"], `${word} should reach Starters`);
  }
});

test("words for the sharing section reach it", () => {
  for (const word of ["platter", "boards", "share plates", "to share"]) {
    assert.deepEqual(hits(word), ["Chef Suggestions for Sharing"], `${word} should reach sharing`);
  }
});

test("a section that genuinely is not on the menu still misses honestly", () => {
  // Answering these from the nearest section would be worse than admitting it.
  for (const word of ["ramen", "sushi", "pizza"]) {
    assert.deepEqual(hits(word), [], `${word} must not resolve to a section`);
  }
});

test("the drinks umbrella still fans out across every bar section", () => {
  assert.deepEqual(hits("drinks"), [
    "Cocktails",
    "Mocktails & Frappes",
    "Juices & Soft Drinks",
    "Beer, Wine & Spirits"
  ]);
});

test("a dish name is not mistaken for a section", () => {
  // These must fall through to the name search. Treating "Chilena Salad" as the
  // Salads section would answer a specific dish question with a list.
  for (const q of ["chilena salad", "mazcina salad", "salmon ceviche", "four milks"]) {
    const word = categoryShapedQuery(q);
    assert.deepEqual(hits(word ?? q), [], `${q} must not resolve to a section`);
  }
});

test("polite scaffolding is stripped so the section survives", () => {
  for (const [asked, expected] of [
    ["What starters do you have?", "starters"],
    ["do you have any desserts", "desserts"],
    ["Could I get some recommendations for mains?", "mains"],
    ["what's on the sides", "sides"]
  ] as const) {
    assert.equal(categoryShapedQuery(asked), expected, asked);
  }
});

test("quality adjectives and copulas are stripped, not treated as the section", () => {
  // Every one of these reached the dish search and missed before.
  for (const [asked, expected] of [
    ["what's good to share?", "to share"],
    ["what is good to share", "to share"],
    ["what's good for sharing?", "sharing"],
    ["your best starters", "starters"],
    ["your top mains", "mains"]
  ] as const) {
    assert.equal(categoryShapedQuery(asked), expected, asked);
  }
  assert.deepEqual(hits("to share"), ["Chef Suggestions for Sharing"]);
});

test("a long sentence is not treated as a section name", () => {
  // Guards the 40-char cap: free speech must reach the dish search, not be
  // resolved as a section and then reported as a missing one.
  assert.equal(
    categoryShapedQuery("my wife is coeliac and we were wondering about the fish"),
    null
  );
});
