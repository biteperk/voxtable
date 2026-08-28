import assert from "node:assert/strict";
import test from "node:test";

import {
  migrateStorageKey,
  readStorageKey,
  storageKey,
  writeStorageKey
} from "./storageKeys.js";

/**
 * The only meaningful test here is the one that starts with the OLD key already
 * present — a user who has used the dashboard before. A fresh profile passes
 * trivially and proves nothing, which is exactly how a silent forget ships.
 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() {
      return map.size;
    }
  };
  return map;
}

test("an existing user keeps their selected restaurant across the rename", () => {
  const map = fakeStorage({ "vocotable.activeRestaurantId": "rest-42" });
  assert.equal(readStorageKey("activeRestaurantId"), "rest-42");
  assert.equal(map.get("voxtable.activeRestaurantId"), "rest-42");
  assert.equal(map.has("vocotable.activeRestaurantId"), false, "old key must be cleaned up");
});

test("migration is idempotent — a second run is a no-op", () => {
  const map = fakeStorage({ "vocotable.lastProduct": "/live-feed" });
  migrateStorageKey("lastProduct");
  migrateStorageKey("lastProduct");
  assert.equal(map.get("voxtable.lastProduct"), "/live-feed");
  assert.equal(map.size, 1);
});

test("a value already under the new key is never clobbered by a stale old one", () => {
  const map = fakeStorage({
    "vocotable.activeRestaurantId": "stale",
    "voxtable.activeRestaurantId": "current"
  });
  assert.equal(readStorageKey("activeRestaurantId"), "current");
  assert.equal(map.has("vocotable.activeRestaurantId"), false);
});

test("a first-time visitor reads null rather than throwing", () => {
  fakeStorage();
  assert.equal(readStorageKey("activeRestaurantId"), null);
});

test("the colon-separated key migrates too", () => {
  // verify-email-sent-at used ':' rather than '.'; losing it unlocks the resend
  // button early, which is a rate-limit hole rather than a cosmetic reset.
  const map = fakeStorage({ "vocotable:verify-email-sent-at": "1756000000000" });
  assert.equal(readStorageKey("verify-email-sent-at", ":"), "1756000000000");
  assert.equal(map.get("voxtable:verify-email-sent-at"), "1756000000000");
});

test("writing null removes the key", () => {
  const map = fakeStorage({ "voxtable.activeRestaurantId": "rest-1" });
  writeStorageKey("activeRestaurantId", null);
  assert.equal(map.has("voxtable.activeRestaurantId"), false);
});

test("storage that throws does not take the dashboard down with it", () => {
  // Safari private mode and some embedded webviews throw on access. Losing the
  // whole app to a storage exception would be worse than the bug this fixes.
  globalThis.localStorage = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("SecurityError");
    },
    removeItem() {
      throw new Error("SecurityError");
    }
  };
  assert.equal(readStorageKey("activeRestaurantId"), null);
  assert.doesNotThrow(() => writeStorageKey("activeRestaurantId", "rest-1"));
  assert.doesNotThrow(() => migrateStorageKey("activeRestaurantId"));
  assert.equal(storageKey("activeRestaurantId"), "voxtable.activeRestaurantId");
});
