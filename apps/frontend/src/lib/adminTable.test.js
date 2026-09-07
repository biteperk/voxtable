/**
 * Admin table sorting. The two rules worth locking are that empty values sort
 * last in BOTH directions, and that numeric-looking strings compare
 * numerically — venue names, phone numbers and versions all trip the latter.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compareRows, nextSort, sortRows } from "./adminTable";

const names = (rows) => rows.map((r) => r.name);

test("sorts strings ascending and descending", () => {
  const rows = [{ name: "Mazcina" }, { name: "Cuban Corner" }, { name: "Zeta" }];
  assert.deepEqual(names(sortRows(rows, { key: "name", direction: "ascending" })), [
    "Cuban Corner",
    "Mazcina",
    "Zeta"
  ]);
  assert.deepEqual(names(sortRows(rows, { key: "name", direction: "descending" })), [
    "Zeta",
    "Mazcina",
    "Cuban Corner"
  ]);
});

test("sorts numbers numerically, not lexically", () => {
  const rows = [{ calls: 9 }, { calls: 10 }, { calls: 1 }];
  assert.deepEqual(
    sortRows(rows, { key: "calls", direction: "ascending" }).map((r) => r.calls),
    [1, 9, 10]
  );
});

test("numeric-looking STRINGS also compare numerically", () => {
  // Lexical sorting would put "10" between "1" and "9".
  const rows = [{ n: "9" }, { n: "10" }, { n: "1" }];
  assert.deepEqual(
    sortRows(rows, { key: "n", direction: "ascending" }).map((r) => r.n),
    ["1", "9", "10"]
  );
});

test("empty values sort LAST in both directions", () => {
  const rows = [{ name: null }, { name: "Mazcina" }, { name: "" }, { name: "Cuban Corner" }];
  assert.deepEqual(names(sortRows(rows, { key: "name", direction: "ascending" })).slice(0, 2), [
    "Cuban Corner",
    "Mazcina"
  ]);
  // Descending must not float the blanks to the top.
  assert.deepEqual(names(sortRows(rows, { key: "name", direction: "descending" })).slice(0, 2), [
    "Mazcina",
    "Cuban Corner"
  ]);
});

test("two empties are equal, and undefined counts as empty", () => {
  assert.equal(compareRows({ a: null }, { a: "" }, "a", "ascending"), 0);
  assert.equal(compareRows({}, { a: "x" }, "a", "ascending"), 1);
  assert.equal(compareRows({ a: "x" }, {}, "a", "ascending"), -1);
});

test("zero is a value, not an emptiness", () => {
  // A venue with 0 calls must sort as a real number, not drop to the bottom.
  const rows = [{ calls: 5 }, { calls: 0 }, { calls: null }];
  assert.deepEqual(
    sortRows(rows, { key: "calls", direction: "ascending" }).map((r) => r.calls),
    [0, 5, null]
  );
});

test("clicking a new column starts ascending; the same column flips", () => {
  assert.deepEqual(nextSort(null, "name"), { key: "name", direction: "ascending" });
  assert.deepEqual(nextSort({ key: "calls", direction: "descending" }, "name"), {
    key: "name",
    direction: "ascending"
  });
  assert.deepEqual(nextSort({ key: "name", direction: "ascending" }, "name"), {
    key: "name",
    direction: "descending"
  });
});

test("sorting does not mutate the caller's array", () => {
  const rows = [{ name: "b" }, { name: "a" }];
  sortRows(rows, { key: "name", direction: "ascending" });
  assert.deepEqual(names(rows), ["b", "a"]);
});

test("no sort returns the rows untouched, and missing rows are safe", () => {
  const rows = [{ name: "b" }, { name: "a" }];
  assert.equal(sortRows(rows, null), rows);
  assert.deepEqual(sortRows(undefined, { key: "name", direction: "ascending" }), []);
});
