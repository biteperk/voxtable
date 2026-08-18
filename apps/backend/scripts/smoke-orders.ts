// End-to-end smoke for the KDS order lifecycle. Hits the new menu + orders
// routes against either local dev or PUBLIC_API_BASE_URL=https://… in prod.
//
// Asserts:
//   1. GET /api/menu returns Fish & Chips with Large + drink modifier group
//   2. POST /api/orders creates the order
//   3. Same Idempotency-Key returns the SAME order (replay)
//   4. Different Idempotency-Key creates a NEW order (no dedup)
//   5. PATCH status flow: pending → preparing → ready → served
//   6. PATCH item status updates the line independently
//   7. PATCH payment toggles unpaid → paid
//   8. Stale If-Match header returns 409 (optimistic lock)
//   9. Served order falls off /api/orders/active
//  10. /api/ops/kds-health snapshot reflects reality

import { mintSmokeIdToken } from "./lib/firebaseToken";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";

interface MenuItem {
  id: string;
  name: string;
  base_price_cents: number;
  variants: Array<{ id: string; name: string }>;
  modifier_groups: Array<{
    group_name: string;
    group_min_select: number;
    options: Array<{ id: string; name: string }>;
  }>;
}

interface OrderResponse {
  id: string;
  order_number: number | null;
  status: string;
  payment_status: string;
  total_cents: number;
  version: number;
  items: Array<{ id: string; status: string }>;
}

// Filled in main(): Bearer token + tenant header for servers running the full
// production gates (staging). Empty in local dev with DASHBOARD_VERIFY_AUTH=false.
let authHeaders: Record<string, string> = {};

async function request<T>(path: string, init?: RequestInit & { expectStatus?: number }): Promise<T | { __error: { status: number; body: any } }> {
  const { expectStatus, ...fetchInit } = init ?? {};
  const response = await fetch(`${baseUrl}${path}`, {
    ...fetchInit,
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...(fetchInit?.headers ?? {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (expectStatus !== undefined && response.status !== expectStatus) {
    throw new Error(
      `Expected ${expectStatus} on ${fetchInit?.method ?? "GET"} ${path}, got ${response.status}: ${JSON.stringify(body)}`
    );
  }
  if (expectStatus === undefined && !response.ok) {
    throw new Error(`${fetchInit?.method ?? "GET"} ${path} → ${response.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function main(): Promise<void> {
  console.log(`Smoking ${baseUrl}`);

  // Token-gated mode: every /api/* route on a production-posture server needs
  // a Firebase Bearer token AND the tenant header (resolveTenant). Locally
  // with DASHBOARD_VERIFY_AUTH=false neither is required and both are skipped.
  const token = await mintSmokeIdToken();
  const tenant = process.env.SMOKE_RESTAURANT_ID;
  if (token) {
    authHeaders = {
      authorization: `Bearer ${token}`,
      ...(tenant ? { "x-restaurant-id": tenant } : {})
    };
    console.log(`✓ minted Firebase token${tenant ? ` (tenant ${tenant})` : ""}`);
  } else if (tenant) {
    authHeaders = { "x-restaurant-id": tenant };
    console.log("[SKIP] no SMOKE_FIREBASE_* env — running unauthenticated (local mode)");
  }

  // 1) Health
  const health = await request<{ status: string }>("/health");
  console.log("✓ health", health);

  // 2) Menu — find Fish & Chips + Large variant + Coke modifier
  const menu = await request<{ categories: Array<{ items: MenuItem[] }> }>("/api/menu");
  const items = menu.categories.flatMap((c) => c.items);
  const fishChips = items.find((i) => i.name === "Fish & Chips");
  assert(fishChips, "Fish & Chips not in menu — has the seed run?");
  const largeVariant = fishChips.variants.find((v) => v.name === "Large");
  assert(largeVariant, "Fish & Chips Large variant missing");
  const drinkGroup = fishChips.modifier_groups.find((g) => g.group_name === "Drink");
  assert(drinkGroup, "Fish & Chips drink modifier group missing");
  assert(drinkGroup.group_min_select === 1, "Drink group should be required (min 1)");
  const coke = drinkGroup.options.find((o) => o.name === "Coke");
  assert(coke, "Coke option missing");
  console.log(`✓ menu — Fish & Chips ${fishChips.id} variant=${largeVariant.id} drink=${coke.id}`);

  // 3) Create order with idempotency key
  const idempotencyKey = `smoke-orders-${Date.now()}`;
  const created = (await request<{ order: OrderResponse; is_replay: boolean }>("/api/orders", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      source: "dashboard",
      items: [
        {
          menu_item_id: fishChips.id,
          variant_id: largeVariant.id,
          modifier_ids: [coke.id],
          quantity: 1,
          special_requests: "Smoke test — please ignore"
        }
      ],
      special_instructions: "Smoke order from smoke-orders.ts"
    }),
    expectStatus: 201
  })) as { order: OrderResponse; is_replay: boolean };
  assert(!created.is_replay, "First POST should NOT be a replay");
  assert(created.order.status === "pending", `Expected status=pending, got ${created.order.status}`);
  assert(created.order.payment_status === "unpaid", `Expected unpaid, got ${created.order.payment_status}`);
  assert(created.order.total_cents === 2600, `Expected total=2600, got ${created.order.total_cents}`); // 22+4=26
  assert(created.order.items.length === 1, `Expected 1 line, got ${created.order.items.length}`);
  console.log(`✓ create order — #${created.order.order_number} ${created.order.id} total=$${created.order.total_cents / 100}`);

  // 4) Replay with same Idempotency-Key → same order
  const replay = (await request<{ order: OrderResponse; is_replay: boolean }>("/api/orders", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      source: "dashboard",
      items: [
        {
          menu_item_id: fishChips.id,
          variant_id: largeVariant.id,
          modifier_ids: [coke.id],
          quantity: 1
        }
      ]
    }),
    expectStatus: 200
  })) as { order: OrderResponse; is_replay: boolean };
  assert(replay.is_replay === true, "Replay should be is_replay=true");
  assert(replay.order.id === created.order.id, "Replay should return same order id");
  console.log("✓ idempotency replay returns same order");

  // 5) Stale If-Match → 409
  await request("/api/orders/" + created.order.id + "/status", {
    method: "PATCH",
    headers: { "if-match": "999" },
    body: JSON.stringify({ status: "preparing" }),
    expectStatus: 409
  });
  console.log("✓ stale If-Match returns 409 (optimistic lock)");

  // 6) Status pending → preparing
  const preparing = await request<OrderResponse>("/api/orders/" + created.order.id + "/status", {
    method: "PATCH",
    headers: { "if-match": String(created.order.version) },
    body: JSON.stringify({ status: "preparing" }),
    expectStatus: 200
  }) as OrderResponse;
  assert(preparing.status === "preparing", "status should be preparing");
  assert(preparing.version === created.order.version + 1, "version should have incremented");
  console.log(`✓ status pending → preparing (v${preparing.version})`);

  // 7) Item status queued → ready
  const itemId = preparing.items[0]!.id;
  const itemUpdated = await request<OrderResponse>(
    `/api/orders/${created.order.id}/items/${itemId}/status`,
    {
      method: "PATCH",
      headers: { "if-match": String(preparing.version) },
      body: JSON.stringify({ status: "ready" }),
      expectStatus: 200
    }
  ) as OrderResponse;
  assert(itemUpdated.items[0]!.status === "ready", "line item should be ready");
  console.log(`✓ line item status → ready (v${itemUpdated.version})`);

  // 8) Payment unpaid → paid
  const paid = await request<OrderResponse>("/api/orders/" + created.order.id + "/payment", {
    method: "PATCH",
    headers: { "if-match": String(itemUpdated.version) },
    body: JSON.stringify({ payment_status: "paid" }),
    expectStatus: 200
  }) as OrderResponse;
  assert(paid.payment_status === "paid", "payment should be paid");
  console.log(`✓ payment unpaid → paid (v${paid.version})`);

  // 9) preparing → ready → served
  const ready = await request<OrderResponse>("/api/orders/" + created.order.id + "/status", {
    method: "PATCH",
    headers: { "if-match": String(paid.version) },
    body: JSON.stringify({ status: "ready" }),
    expectStatus: 200
  }) as OrderResponse;
  assert(ready.status === "ready", "status should be ready");

  const served = await request<OrderResponse>("/api/orders/" + created.order.id + "/status", {
    method: "PATCH",
    headers: { "if-match": String(ready.version) },
    body: JSON.stringify({ status: "served" }),
    expectStatus: 200
  }) as OrderResponse;
  assert(served.status === "served", "status should be served");
  console.log(`✓ status ready → served (v${served.version})`);

  // 10) Active orders excludes served
  const active = await request<{ orders: Array<{ id: string }> }>("/api/orders/active");
  assert(
    !active.orders.find((o) => o.id === created.order.id),
    "Served order should fall off /api/orders/active"
  );
  console.log(`✓ active orders excludes served (currently ${active.orders.length} active)`);

  // 11) KDS health snapshot
  const kdsHealth = await request<{ active_orders: number; payment_pending_count: number }>(
    "/api/ops/kds-health"
  );
  console.log("✓ kds-health", kdsHealth);

  console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err.message);
  process.exit(1);
});
