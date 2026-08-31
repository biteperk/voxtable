/**
 * The owner's ranked picks, as the agent receives them.
 *
 * Mazcina's owner ranked his dishes per section and explained the reasoning:
 * empanadas and sopaipillas go out first because they are quick to make and
 * keep a table happy while the mains cook. That pairing crosses sections, which
 * is why quick bites are a flag rather than a rank.
 *
 * The formatter is pure so it can be covered without a database; the query
 * behind it is covered by the smoke script.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatMenuHighlights, type RecommendableItem } from "./menuService";

const item = (o: Partial<RecommendableItem> & { name: string; category_name: string }): RecommendableItem => ({
  base_price_cents: 1000,
  recommend_rank: 1,
  is_signature: false,
  is_quick_bite: false,
  available_from: null,
  available_until: null,
  ...o
});

// Mazcina's real ranked list, as imported.
const MAZCINA: RecommendableItem[] = [
  item({ name: "Cocktail Empanadas", category_name: "Starters", recommend_rank: 1, base_price_cents: 500, is_quick_bite: true }),
  item({ name: "Mazcina Salmon Ceviche", category_name: "Starters", recommend_rank: 2, base_price_cents: 2900, is_signature: true }),
  item({ name: "Mazcina Garlic Prawns", category_name: "Starters", recommend_rank: 3, base_price_cents: 2300 }),
  item({ name: "Mazcina Salmon Cancato", category_name: "Mains", recommend_rank: 1, base_price_cents: 3600, is_signature: true }),
  item({ name: "Saltado", category_name: "Mains", recommend_rank: 4, base_price_cents: 2000 }),
  item({ name: "Sopaipillas", category_name: "Sides", recommend_rank: 1, base_price_cents: 150, is_quick_bite: true })
];

test("each section is listed in the owner's order, not the menu's", () => {
  const out = formatMenuHighlights(MAZCINA);
  assert.match(
    out,
    /Starters — 1\. Cocktail Empanadas \(\$5\) 2\. Mazcina Salmon Ceviche \(\$29, signature\) 3\. Mazcina Garlic Prawns \(\$23\)/
  );
  // Rank 4 with nothing between it and rank 1 still reads as second.
  assert.match(out, /Mains — 1\. Mazcina Salmon Cancato \(\$36, signature\) 2\. Saltado \(\$20\)/);
});

test("input order does not decide output order — the rank does", () => {
  const shuffled = [MAZCINA[2]!, MAZCINA[0]!, MAZCINA[1]!];
  assert.match(
    formatMenuHighlights(shuffled),
    /Starters — 1\. Cocktail Empanadas .*2\. Mazcina Salmon Ceviche .*3\. Mazcina Garlic Prawns/
  );
});

test("the quick-to-make pair leads, and crosses sections", () => {
  const first = formatMenuHighlights(MAZCINA).split("\n")[0]!;
  // A Starter and a Side named together: the reason the flag exists.
  assert.match(first, /^Quick to make, good while mains cook: Cocktail Empanadas \(\$5\), Sopaipillas \(\$1\.50\)\.$/);
});

test("prices are spoken, not printed", () => {
  const out = formatMenuHighlights(MAZCINA);
  // "$5.00" is read aloud as "five point zero zero dollars".
  assert.ok(!out.includes("$5.00"), "whole dollars must not carry cents");
  assert.ok(out.includes("$1.50"), "real cents must survive");
});

test("nothing ranked produces an empty string, not a broken sentence", () => {
  // "" makes the prompt fall back to menu_lookup. Any other value would be
  // read out as if it were a recommendation.
  assert.equal(formatMenuHighlights([]), "");
});

test("a dish outside its serving window is dropped, not annotated", () => {
  // These are recommended UNPROMPTED, so offering a breakfast dish at 8 PM and
  // having create_order refuse it is worse here than in a lookup — the caller
  // never asked for it.
  const breakfast = [
    item({ name: "Breakfast Toastie", category_name: "Starters", available_from: "07:00", available_until: "11:00" })
  ];
  assert.equal(formatMenuHighlights(breakfast, "20:00"), "");
  assert.match(formatMenuHighlights(breakfast, "09:00"), /Breakfast Toastie/);
});

test("with no reference time every ranked dish is offered", () => {
  const breakfast = [
    item({ name: "Breakfast Toastie", category_name: "Starters", available_from: "07:00", available_until: "11:00" })
  ];
  assert.match(formatMenuHighlights(breakfast), /Breakfast Toastie/);
});

test("an over-long list is cut at a section boundary, never mid-dish", () => {
  const many: RecommendableItem[] = [];
  for (let s = 0; s < 12; s += 1) {
    for (let r = 1; r <= 4; r += 1) {
      many.push(
        item({
          name: `A Reasonably Long Dish Name Number ${s}-${r}`,
          category_name: `Section Number ${s}`,
          recommend_rank: r
        })
      );
    }
  }
  const out = formatMenuHighlights(many);
  assert.ok(out.length <= 800, `expected <= 800 chars, got ${out.length}`);
  // Every surviving line is a whole section: no trailing partial dish or price.
  for (const line of out.split("\n")) {
    assert.match(line, /\)$/, `line ends mid-dish: ${line}`);
  }
});
