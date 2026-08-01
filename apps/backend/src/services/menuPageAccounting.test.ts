import assert from "node:assert/strict";
import test from "node:test";

import type { MenuDraft, MenuOcrBatch } from "../http/schemas";
import {
  buildPageResults,
  lastCategoryOf,
  mergeAttributed,
  normaliseBatchOutput,
  parsePriceText,
  planBatches,
  unaccountedPages,
  verificationTargets,
  type PagePart,
  type PageStatus
} from "./menuPageAccounting";

/**
 * Per-page accounting. DB-free and provider-free.
 *
 * The incident these exist for: a five-page menu imported 59 of 65 items
 * because page 3 produced nothing at all, the batch containing it SUCCEEDED, and
 * the owner was told "everything looked clear". Every rule here is about being
 * able to tell "this page was blank" from "I missed this page".
 */

type Cat = [string, Array<[string, number]>];

function cats(list: Cat[]): MenuDraft["categories"] {
  return list.map(([name, items]) => ({
    name,
    items: items.map(([itemName, price]) => ({ name: itemName, price_cents: price }))
  }));
}

function part(page: number | null, list: Cat[]): PagePart {
  return { page, categories: cats(list) };
}

function itemNames(d: MenuDraft, category: string): string[] {
  return d.categories.find((c) => c.name === category)?.items.map((i) => i.name) ?? [];
}

// ---------------------------------------------------------------------------
// Merging — the invariants that survived from the old mergeDrafts
// ---------------------------------------------------------------------------

test("a heading repeated across pages becomes one category", () => {
  // "Desserts" on page 4 and again on page 11. Left unmerged, the commit hits
  // UNIQUE (restaurant_id, LOWER(name)) and the whole import dies with
  // "Something went wrong."
  const { draft } = mergeAttributed([
    part(4, [["Desserts", [["Tiramisu", 1400]]]]),
    part(11, [["Desserts", [["Affogato", 900]]]])
  ]);
  assert.equal(draft.categories.length, 1);
  assert.deepEqual(itemNames(draft, "Desserts"), ["Tiramisu", "Affogato"]);
});

test("categories differing only by case or spacing merge", () => {
  const { draft } = mergeAttributed([
    part(1, [["Sides", [["Fries", 900]]]]),
    part(2, [["SIDES", [["Slaw", 700]]]]),
    part(3, [["  sides  ", [["Bread", 500]]]])
  ]);
  assert.equal(draft.categories.length, 1, "three spellings of one heading");
  assert.equal(draft.categories[0]!.items.length, 3);
});

test("the first spelling of a category name wins", () => {
  const { draft } = mergeAttributed([
    part(1, [["Desserts", [["Tiramisu", 1400]]]]),
    part(2, [["DESSERTS", [["Gelato", 800]]]])
  ]);
  assert.equal(draft.categories[0]!.name, "Desserts", "not the shoutier later one");
});

test("an item repeated at a page boundary is not duplicated", () => {
  // A heading straddling two pages can make the model restate the last row.
  const { draft } = mergeAttributed([
    part(1, [["Starters", [["Mushroom Ceviche", 1900], ["Napo Chicken Bites", 1900]]]]),
    part(2, [["Starters", [["Napo Chicken Bites", 1900], ["Baked Feta Pot", 1800]]]])
  ]);
  assert.deepEqual(itemNames(draft, "Starters"), [
    "Mushroom Ceviche",
    "Napo Chicken Bites",
    "Baked Feta Pot"
  ]);
});

test("the same dish name under different categories is kept twice", () => {
  const { draft } = mergeAttributed([
    part(1, [["Starters", [["Garlic Bread", 900]]]]),
    part(2, [["Sides", [["Garlic Bread", 700]]]])
  ]);
  assert.equal(draft.categories.length, 2);
});

test("menu order is preserved across pages", () => {
  const { draft } = mergeAttributed([
    part(1, [["Starters", [["A", 100]]], ["Mains", [["B", 200]]]]),
    part(2, [["Desserts", [["C", 300]]]])
  ]);
  assert.deepEqual(draft.categories.map((c) => c.name), ["Starters", "Mains", "Desserts"]);
});

test("empty categories are dropped", () => {
  const { draft } = mergeAttributed([part(1, [["Mazcina", []]]), part(2, [["Starters", [["Ceviche", 1900]]]])]);
  assert.deepEqual(draft.categories.map((c) => c.name), ["Starters"]);
});

test("merging nothing yields nothing, without throwing", () => {
  assert.deepEqual(mergeAttributed([]).draft, { categories: [] });
  assert.deepEqual(mergeAttributed([part(1, [])]).draft, { categories: [] });
});

// ---------------------------------------------------------------------------
// Merging — what changed, and why
// ---------------------------------------------------------------------------

test("the same name at different prices is two rows, not one", () => {
  // THE SECOND SILENT-LOSS BUG. The lost page printed BURGER $10, BURGER $20 and
  // BURGER $10. Keying dedupe on name alone collapsed all three to one row, so
  // even a perfect read of that page would have lost two thirds of it.
  const { draft } = mergeAttributed([
    part(3, [["Menu", [["Burger", 1000], ["Pizza", 5000], ["Burger", 2000]]]])
  ]);
  assert.deepEqual(itemNames(draft, "Menu"), ["Burger", "Pizza", "Burger"]);
  assert.deepEqual(draft.categories[0]!.items.map((i) => i.price_cents), [1000, 5000, 2000]);
});

test("an identical row printed twice on one page survives twice", () => {
  // Two $10 burgers side by side really are two rows on that page. Dedupe is for
  // an artefact ACROSS calls; inside one page it would be us overruling the menu.
  const { draft } = mergeAttributed([part(3, [["Menu", [["Burger", 1000], ["Burger", 1000]]]])]);
  assert.equal(draft.categories[0]!.items.length, 2);
});

test("a recovered item is not eaten by an identical name elsewhere", () => {
  // The trap that would make the whole recovery pass a no-op: page 3 is re-read,
  // finds "Burger", and an earlier page already contributed a "Burger" at a
  // different price. Under the old name-only key this silently vanished — so
  // recovery would log a success and change nothing.
  const first = part(1, [["Menu", [["Burger", 1000]]]]);
  const recovered = part(3, [["Menu", [["Burger", 2000]]]]);
  const { draft, perPage } = mergeAttributed([first, recovered]);
  assert.equal(draft.categories[0]!.items.length, 2);
  assert.equal(perPage.get(3), 1, "page 3 must be credited with what it contributed");
});

test("page counts come from what survived, not from what the model said", () => {
  // A page whose every row was already in the draft contributed nothing the
  // owner will see. Counting raw output would mark it accounted for while they
  // see none of it.
  const { perPage } = mergeAttributed([
    part(1, [["Starters", [["Ceviche", 1900]]]]),
    part(2, [["Starters", [["Ceviche", 1900]]]])
  ]);
  assert.equal(perPage.get(1), 1);
  assert.equal(perPage.get(2) ?? 0, 0, "page 2 restated page 1 and added nothing");
});

test("items with no usable page attribution count towards no page", () => {
  const { draft, perPage } = mergeAttributed([part(null, [["Menu", [["Soup", 800]]]])]);
  assert.equal(draft.categories[0]!.items.length, 1, "the items are still kept");
  assert.equal(perPage.size, 0, "but no page may claim credit for them");
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test("a page the model omitted entirely still shows up as zero", () => {
  // The incident, as a unit test. The model returned pages 1, 2, 4 and 5 and
  // simply never mentioned 3.
  const raw: MenuOcrBatch = {
    pages: [
      { page: 1, categories: cats([["Starters", [["A", 100]]]]) },
      { page: 2, categories: cats([["Mains", [["B", 200]]]]) }
    ]
  } as MenuOcrBatch;
  const { parts } = normaliseBatchOutput(raw, [1, 2, 3]);
  const { perPage } = mergeAttributed(parts);
  const { targets } = verificationTargets(3, perPage, 8);
  assert.deepEqual(targets, [3], "the page nobody mentioned must be re-read");
});

test("a page number outside the batch is treated as unattributed, never clamped", () => {
  const raw: MenuOcrBatch = {
    pages: [{ page: 9, categories: cats([["Menu", [["A", 100]]]]) }]
  } as MenuOcrBatch;
  const { parts } = normaliseBatchOutput(raw, [1, 2, 3]);
  assert.equal(parts[0]!.page, null);
  const { perPage } = mergeAttributed(parts);
  const { targets } = verificationTargets(3, perPage, 8);
  assert.deepEqual(targets, [1, 2, 3], "a typo must not mark a real page accounted for");
});

test("the old flat shape still parses, and forces every page to be verified", () => {
  const raw: MenuOcrBatch = { categories: cats([["Menu", [["A", 100]]]]) } as MenuOcrBatch;
  const { parts, attributed } = normaliseBatchOutput(raw, [1, 2]);
  assert.equal(attributed, false);
  assert.equal(parts[0]!.page, null);
  const { draft } = mergeAttributed(parts);
  assert.equal(draft.categories.length, 1, "items are kept — a model that ignores the envelope is not a failure");
});

test("a page reported with no categories is a candidate, not an accounted page", () => {
  const raw: MenuOcrBatch = {
    pages: [
      { page: 1, categories: cats([["Menu", [["A", 100]]]]) },
      { page: 2, categories: [] }
    ]
  } as MenuOcrBatch;
  const { parts } = normaliseBatchOutput(raw, [1, 2]);
  const { targets } = verificationTargets(2, mergeAttributed(parts).perPage, 8);
  assert.deepEqual(targets, [2]);
});

// ---------------------------------------------------------------------------
// Verification targeting and the report
// ---------------------------------------------------------------------------

test("only pages that produced nothing are re-read", () => {
  const perPage = new Map([[1, 5], [3, 2]]);
  const { targets } = verificationTargets(4, perPage, 8);
  assert.deepEqual(targets, [2, 4]);
});

test("pages past the verification cap are reported, never quietly dropped", () => {
  const { targets, skipped } = verificationTargets(6, new Map(), 2);
  assert.deepEqual(targets, [1, 2]);
  assert.deepEqual(skipped, [3, 4, 5, 6], "the ones we ran out of room for");
});

test("a recovered page is accounted for and not shown as a problem", () => {
  const outcomes = new Map<number, { status: PageStatus; note?: string }>([[3, { status: "recovered" }]]);
  const results = buildPageResults(3, new Map([[1, 4], [2, 3], [3, 6]]), outcomes);
  assert.equal(results[2]!.status, "recovered");
  assert.deepEqual(unaccountedPages(results), []);
});

test("a confirmed cover page is accounted for, and keeps what it was", () => {
  const outcomes = new Map<number, { status: PageStatus; note?: string }>([
    [1, { status: "empty_confirmed", note: "cover page" }]
  ]);
  const results = buildPageResults(2, new Map([[2, 9]]), outcomes);
  assert.equal(results[0]!.status, "empty_confirmed");
  assert.equal(results[0]!.note, "cover page");
  assert.deepEqual(unaccountedPages(results), [], "a real cover must not be reported as a loss");
});

test("a page we could not settle is unverified, and the owner is told", () => {
  // The distinction the whole module exists for: running out of budget must
  // never be recorded as "there was nothing on that page".
  const results = buildPageResults(3, new Map([[1, 4], [2, 3]]), new Map());
  assert.equal(results[2]!.status, "unverified");
  assert.deepEqual(unaccountedPages(results), [3]);
});

test("a page whose call errored is unread, and the owner is told", () => {
  const outcomes = new Map<number, { status: PageStatus; note?: string }>([[2, { status: "unread" }]]);
  const results = buildPageResults(2, new Map([[1, 4]]), outcomes);
  assert.deepEqual(unaccountedPages(results), [2]);
});

test("every source page appears exactly once, in order", () => {
  const results = buildPageResults(5, new Map([[1, 18], [2, 8], [4, 5], [5, 28]]), new Map());
  assert.deepEqual(results.map((r) => r.page), [1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((r) => r.items), [18, 8, 0, 5, 28]);
  assert.deepEqual(unaccountedPages(results), [3], "the incident, end to end");
});

// ---------------------------------------------------------------------------
// Batching and carry-forward
// ---------------------------------------------------------------------------

test("batches cover every page once, in order", () => {
  const batches = planBatches(48, 3);
  assert.equal(batches.length, 16);
  assert.deepEqual(batches[0], { firstPage: 1, pages: [1, 2, 3] });
  assert.deepEqual(batches[15], { firstPage: 46, pages: [46, 47, 48] });
  const seen = batches.flatMap((b) => b.pages);
  assert.equal(seen.length, 48);
  assert.equal(new Set(seen).size, 48, "no page batched twice or missed");
});

test("a short menu is one short batch, and no pages is no batches", () => {
  assert.deepEqual(planBatches(1, 3), [{ firstPage: 1, pages: [1] }]);
  assert.deepEqual(planBatches(0, 3), []);
  assert.deepEqual(planBatches(4, 3), [
    { firstPage: 1, pages: [1, 2, 3] },
    { firstPage: 4, pages: [4] }
  ]);
});

test("the heading carried into the next batch is the last one that had items", () => {
  const parts = [
    part(1, [["Starters", [["A", 100]]]]),
    part(2, [["Mains", [["B", 200]]]]),
    part(3, [["Desserts", []]])
  ];
  assert.equal(lastCategoryOf(parts), "Mains", "an empty heading is not where the menu got to");
  assert.equal(lastCategoryOf([]), null);
  assert.equal(lastCategoryOf([part(null, [["Menu", [["A", 100]]]])]), null, "unattributed parts can't anchor");
});

// ---------------------------------------------------------------------------
// Prices as printed
// ---------------------------------------------------------------------------

test("printed prices convert the way the menu means them", () => {
  assert.equal(parsePriceText("$10"), 1000);
  assert.equal(parsePriceText("12.50"), 1250);
  assert.equal(parsePriceText("12,50"), 1250, "comma decimal");
  assert.equal(parsePriceText("99.–"), 9900, "the dash stands in for the cents");
  assert.equal(parsePriceText("10.-"), 1000);
  assert.equal(parsePriceText("1,299"), 129_900, "three trailing digits are never cents");
  assert.equal(parsePriceText("  $ 8.25 "), 825);
});

test("a price we cannot read returns nothing rather than a guess", () => {
  assert.equal(parsePriceText(""), null);
  assert.equal(parsePriceText("   "), null);
  assert.equal(parsePriceText("market price"), null);
  assert.equal(parsePriceText(undefined as unknown as string), null);
});
