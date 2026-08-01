import assert from "node:assert/strict";
import test from "node:test";

import { outputTokenBudget, PAGES_PER_BATCH } from "./menuOcrClient";

/**
 * The output-token budget. DB-free and provider-free.
 *
 * Written after a 12-page, 413 MB restaurant menu failed to import: the budget
 * was a flat 4096 tokens, about a third of what that menu needed, so the reply
 * was cut off mid-item and the truncated JSON crashed the parser.
 *
 * Merging and page attribution moved to menuPageAccounting.test.ts.
 */

test("the output budget scales with how many pages a call reads", () => {
  assert.ok(outputTokenBudget(6) > outputTokenBudget(1), "6 pages must get more room than 1");
  assert.ok(outputTokenBudget(1) >= 4096, "even a single page keeps the old floor");
});

test("a batch always gets more room than it can plausibly need", () => {
  // This used to assert a bare `>= 11_000`, which silently encoded the old
  // six-page batch. The intent was never the number — it was that a batch's
  // allowance comfortably exceeds what that batch can produce.
  assert.ok(
    outputTokenBudget(PAGES_PER_BATCH) >= 3_000 * PAGES_PER_BATCH,
    `a ${PAGES_PER_BATCH}-page batch must scale with its own size`
  );
});

test("four pages still clear the old flat 4096 — the original regression", () => {
  assert.ok(outputTokenBudget(4) > 4_096);
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
