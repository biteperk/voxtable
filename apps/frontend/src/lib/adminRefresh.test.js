import assert from "node:assert/strict";
import test from "node:test";

import { applyResult, isStale, shouldBlockPage, shouldRefetchOnVisible } from "./adminRefresh.js";

const loaded = { data: { calls: 7 }, error: null, lastUpdatedAt: 1000 };

test("an out-of-order response cannot overwrite newer data", () => {
  // The exact race this exists for: a manual Refresh at t=29.5s meets the 30s
  // poll, both batches are in flight, and the OLDER one resolves last.
  assert.equal(isStale(1, 2), true, "request 1 arriving after request 2 is stale");
  assert.equal(isStale(3, 2), false, "request 3 is news");
  assert.equal(isStale(2, 2), true, "the sequence already applied is a duplicate, not news");
});

test("a failed refresh keeps the data that is already on screen", () => {
  const next = applyResult(loaded, { ok: false, error: "Failed to load" });
  assert.deepEqual(next.data, { calls: 7 }, "the operator does not lose what they were reading");
  assert.equal(next.error, "Failed to load");
});

test("lastUpdatedAt only advances on success", () => {
  // It means "when the data below was last known good", so a failure must not
  // move it — otherwise the stamp claims freshness the data does not have.
  const failed = applyResult(loaded, { ok: false, error: "boom" });
  assert.equal(failed.lastUpdatedAt, 1000);

  const ok = applyResult(loaded, { ok: true, data: { calls: 9 }, at: 2000 });
  assert.equal(ok.lastUpdatedAt, 2000);
  assert.deepEqual(ok.data, { calls: 9 });
});

test("a success clears a previous error", () => {
  const recovered = applyResult(
    { data: { calls: 7 }, error: "Failed to load", lastUpdatedAt: 1000 },
    { ok: true, data: { calls: 8 }, at: 3000 }
  );
  assert.equal(recovered.error, null);
});

test("the page is only replaced by an error when there is nothing to show", () => {
  assert.equal(shouldBlockPage({ data: null, error: "Failed to load" }), true);
  // The defect: this used to be true, so one flaky endpoint out of five wiped a
  // fully-loaded overview.
  assert.equal(shouldBlockPage({ data: { calls: 7 }, error: "Failed to load" }), false);
  assert.equal(shouldBlockPage({ data: null, error: null }), false);
});

test("a hidden tab re-fetches on return only once its data is older than one poll", () => {
  const now = 100_000;
  assert.equal(shouldRefetchOnVisible(now - 45_000, 30_000, now), true, "45s old, 30s poll");
  assert.equal(shouldRefetchOnVisible(now - 5_000, 30_000, now), false, "still fresh");
  // A screen with no poll made no freshness promise, so returning to it does
  // not silently spend a request.
  assert.equal(shouldRefetchOnVisible(now - 999_999, undefined, now), false);
  // And nothing to compare against yet.
  assert.equal(shouldRefetchOnVisible(null, 30_000, now), false);
});
