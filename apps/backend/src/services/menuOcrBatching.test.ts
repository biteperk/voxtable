import assert from "node:assert/strict";
import test from "node:test";

import type { MenuDraft } from "../http/schemas";
import { mergeDrafts, outputTokenBudget, PAGES_PER_BATCH } from "./menuOcrClient";

/**
 * Multi-page menu parsing. DB-free and provider-free — these are the pure
 * decisions that decide whether a real 12-page menu imports correctly, so they
 * must be testable without a vision model.
 *
 * Written after a 12-page, 413 MB restaurant menu failed to import. The output
 * budget was a flat 4096 tokens (about a third of what that menu needs), and a
 * repeated section heading across pages later broke the commit outright.
 */

function draft(categories: Array<[string, Array<[string, number]>]>): MenuDraft {
  return {
    categories: categories.map(([name, items]) => ({
      name,
      items: items.map(([itemName, price]) => ({ name: itemName, price_cents: price }))
    }))
  } as MenuDraft;
}

function itemNames(d: MenuDraft, category: string): string[] {
  return d.categories.find((c) => c.name === category)?.items.map((i) => i.name) ?? [];
}

// ---------------------------------------------------------------------------
// Output budget — the cap that truncated the original menu
// ---------------------------------------------------------------------------

test("the output budget scales with how many pages a call reads", () => {
  assert.ok(outputTokenBudget(6) > outputTokenBudget(1), "6 pages must get more room than 1");
  assert.ok(outputTokenBudget(1) >= 4096, "even a single page keeps the old floor");
});

test("a full batch gets far more room than the old flat 4096", () => {
  // The regression. A 12-page menu needs roughly 11,000 output tokens; the old
  // hardcoded 4096 cut the reply off mid-item, which then crashed the parser.
  assert.ok(
    outputTokenBudget(PAGES_PER_BATCH) >= 11_000,
    `a ${PAGES_PER_BATCH}-page batch must comfortably exceed a real menu's needs`
  );
});

test("the budget is capped so a runaway reply cannot bill unbounded", () => {
  assert.ok(outputTokenBudget(1000) <= 32_000);
  assert.equal(outputTokenBudget(1000), outputTokenBudget(10_000), "the cap is a hard ceiling");
});

test("the budget never returns something nonsensical", () => {
  for (const pages of [0, -1, 1, 48]) {
    const budget = outputTokenBudget(pages);
    assert.ok(Number.isInteger(budget) && budget >= 4096, `pages=${pages} gave ${budget}`);
  }
});

// ---------------------------------------------------------------------------
// Merging batches — the repeated-heading bug
// ---------------------------------------------------------------------------

test("a heading repeated across batches becomes one category", () => {
  // "Desserts" on page 4 and again on page 11. Left unmerged, the commit hits
  // UNIQUE (restaurant_id, LOWER(name)) and the whole import dies with
  // "Something went wrong."
  const merged = mergeDrafts([
    draft([["Desserts", [["Tiramisu", 1400]]]]),
    draft([["Desserts", [["Affogato", 900]]]])
  ]);
  assert.equal(merged.categories.length, 1);
  assert.deepEqual(itemNames(merged, "Desserts"), ["Tiramisu", "Affogato"]);
});

test("categories differing only by case or spacing merge", () => {
  const merged = mergeDrafts([
    draft([["Sides", [["Fries", 900]]]]),
    draft([["SIDES", [["Slaw", 700]]]]),
    draft([["  sides  ", [["Bread", 500]]]])
  ]);
  assert.equal(merged.categories.length, 1, "three spellings of one heading");
  assert.equal(merged.categories[0]!.items.length, 3);
});

test("the first spelling of a category name wins", () => {
  const merged = mergeDrafts([draft([["Desserts", [["Tiramisu", 1400]]]]), draft([["DESSERTS", [["Gelato", 800]]]])]);
  assert.equal(merged.categories[0]!.name, "Desserts", "not the shoutier later one");
});

test("an item repeated at a page boundary is not duplicated", () => {
  // A heading straddling two pages can make the model restate the last row.
  const merged = mergeDrafts([
    draft([["Starters", [["Mushroom Ceviche", 1900], ["Napo Chicken Bites", 1900]]]]),
    draft([["Starters", [["Napo Chicken Bites", 1900], ["Baked Feta Pot", 1800]]]])
  ]);
  assert.deepEqual(itemNames(merged, "Starters"), [
    "Mushroom Ceviche",
    "Napo Chicken Bites",
    "Baked Feta Pot"
  ]);
});

test("the same dish name under different categories is kept twice", () => {
  // "Garlic Bread" as both a Starter and a Side is two real menu rows.
  const merged = mergeDrafts([
    draft([["Starters", [["Garlic Bread", 900]]]]),
    draft([["Sides", [["Garlic Bread", 700]]]])
  ]);
  assert.equal(merged.categories.length, 2);
  assert.equal(merged.categories[0]!.items.length, 1);
  assert.equal(merged.categories[1]!.items.length, 1);
});

test("menu order is preserved across batches", () => {
  const merged = mergeDrafts([
    draft([["Starters", [["A", 100]]], ["Mains", [["B", 200]]]]),
    draft([["Desserts", [["C", 300]]]])
  ]);
  assert.deepEqual(merged.categories.map((c) => c.name), ["Starters", "Mains", "Desserts"]);
});

test("empty categories are dropped", () => {
  // A cover page contributes a heading with nothing under it; it should not
  // reach the review screen as a blank section.
  const merged = mergeDrafts([draft([["Mazcina", []]]), draft([["Starters", [["Ceviche", 1900]]]])]);
  assert.deepEqual(merged.categories.map((c) => c.name), ["Starters"]);
});

test("merging nothing yields nothing, without throwing", () => {
  assert.deepEqual(mergeDrafts([]), { categories: [] });
  assert.deepEqual(mergeDrafts([draft([])]), { categories: [] });
});

test("a realistic 12-page split merges to one clean menu", () => {
  // Page 1 is a cover (no items) — the shape of the actual incident file.
  const batches = [
    draft([
      ["Starters", [["Mushroom Ceviche", 1900], ["Napo Chicken Bites", 1900]]],
      ["Chef Suggestions", [["Mazcina Earth Board", 7400]]]
    ]),
    draft([["Mains", [["Chorrillana", 3200]]], ["Starters", [["Crab Gratin", 2300]]]])
  ];
  const merged = mergeDrafts(batches);
  assert.deepEqual(merged.categories.map((c) => c.name), ["Starters", "Chef Suggestions", "Mains"]);
  assert.deepEqual(itemNames(merged, "Starters"), [
    "Mushroom Ceviche",
    "Napo Chicken Bites",
    "Crab Gratin"
  ]);
  const total = merged.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(total, 5);
});
