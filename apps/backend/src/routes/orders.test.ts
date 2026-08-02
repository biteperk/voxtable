/**
 * The two things that were wrong with the KDS ops endpoints.
 *
 *   1. `/api/ops/kds-health` had no auth middleware at all and read the default
 *      tenant, so a venue's live order counts were public, and with a second
 *      venue everyone would have been reading restaurant #1's.
 *   2. The heartbeat map was keyed on a caller-supplied string with no
 *      eviction and no ceiling — any account that could reach the endpoint
 *      could grow it until the api ran out of memory — and the key had no
 *      tenant in it, so two venues each calling a tablet "kitchen-1"
 *      overwrote each other and masked each other's outages.
 *
 * The first test walks the router rather than checking one route, because the
 * class of bug is "someone adds an ops route and forgets the middleware".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getKdsHeartbeats,
  ordersRouter,
  recordKdsHeartbeat,
  resetKdsHeartbeats
} from "./orders";

interface RouterLayer {
  route?: { path: string; stack: Array<{ name: string }> };
}

test("every /api/ route on this router authenticates", () => {
  const unguarded: string[] = [];
  for (const layer of (ordersRouter as unknown as { stack: RouterLayer[] }).stack) {
    const route = layer.route;
    if (!route?.path.startsWith("/api/")) continue;
    if (!route.stack.some((handler) => handler.name === "requireFirebaseAuth")) {
      unguarded.push(route.path);
    }
  }
  assert.deepEqual(unguarded, [], `unauthenticated routes: ${unguarded.join(", ")}`);
});

test("every /api/ route on this router resolves a tenant", () => {
  // Without this, a handler reaching for tenantId() throws 500 and a handler
  // reaching for DEFAULT_RESTAURANT_ID quietly serves the wrong venue.
  const tenantBlind: string[] = [];
  for (const layer of (ordersRouter as unknown as { stack: RouterLayer[] }).stack) {
    const route = layer.route;
    if (!route?.path.startsWith("/api/")) continue;
    if (!route.stack.some((handler) => handler.name === "resolveTenant")) {
      tenantBlind.push(route.path);
    }
  }
  assert.deepEqual(tenantBlind, [], `tenant-blind routes: ${tenantBlind.join(", ")}`);
});

test("two venues can use the same tablet name without shadowing each other", () => {
  resetKdsHeartbeats();
  const now = 1_000_000;
  recordKdsHeartbeat("restaurant-a", "kitchen-1", now);
  recordKdsHeartbeat("restaurant-b", "kitchen-1", now);

  assert.deepEqual(getKdsHeartbeats("restaurant-a", now), [
    { tablet_id: "kitchen-1", last_seen_ms_ago: 0 }
  ]);
  assert.deepEqual(getKdsHeartbeats("restaurant-b", now), [
    { tablet_id: "kitchen-1", last_seen_ms_ago: 0 }
  ]);
});

test("a venue never sees another venue's tablets", () => {
  resetKdsHeartbeats();
  const now = 1_000_000;
  recordKdsHeartbeat("restaurant-a", "pass", now);
  recordKdsHeartbeat("restaurant-b", "grill", now);

  assert.deepEqual(
    getKdsHeartbeats("restaurant-a", now).map((h) => h.tablet_id),
    ["pass"]
  );
  assert.deepEqual(getKdsHeartbeats("restaurant-c", now), []);
});

test("a re-ping updates the existing entry rather than adding one", () => {
  resetKdsHeartbeats();
  recordKdsHeartbeat("restaurant-a", "pass", 1_000_000);
  recordKdsHeartbeat("restaurant-a", "pass", 1_060_000);
  const beats = getKdsHeartbeats("restaurant-a", 1_060_000);
  assert.equal(beats.length, 1);
  assert.equal(beats[0]!.last_seen_ms_ago, 0);
});

test("a tablet that stops pinging ages out instead of accumulating", () => {
  resetKdsHeartbeats();
  recordKdsHeartbeat("restaurant-a", "pass", 1_000_000);
  // Still there inside the window — the alerter needs to see it as silent, not
  // as absent, or it can never report "no tablet has checked in".
  const stillThere = getKdsHeartbeats("restaurant-a", 1_000_000 + 10 * 60_000);
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0]!.last_seen_ms_ago, 10 * 60_000);

  assert.deepEqual(getKdsHeartbeats("restaurant-a", 1_000_000 + 20 * 60_000), []);
});

test("a flood of invented tablet ids cannot grow the map without limit", () => {
  resetKdsHeartbeats();
  const now = 1_000_000;
  for (let i = 0; i < 1000; i += 1) {
    recordKdsHeartbeat("restaurant-a", `spoof-${i}`, now + i);
  }
  const beats = getKdsHeartbeats("restaurant-a", now + 1000);
  assert.ok(beats.length <= 200, `map grew to ${beats.length}`);
  // The ceiling drops the least recently seen, so the newest ping survives.
  assert.ok(beats.some((h) => h.tablet_id === "spoof-999"));
});
