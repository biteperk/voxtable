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
 *
 * The heartbeat-map behaviour tests that used to live here moved to
 * scripts/smoke-ops-state.ts when the store became DB-backed (ops_state,
 * migration 028) — tenant scoping, overwrite-on-reping and TTL aging are now
 * asserted against a live Postgres.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ordersRouter } from "./orders";

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
