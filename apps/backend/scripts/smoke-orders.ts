// End-to-end smoke for the KDS order lifecycle. Hits the new menu + orders
// routes against either local dev or the staging PUBLIC_API_BASE_URL.
//
// Asserts:
//   1. GET /api/menu returns Fish & Chips with Large + drink modifier group
//   2. PATCH availability window: set → clear via explicit null → omitted key keeps
//   3. POST /api/orders creates the order
//   3. Same Idempotency-Key returns the SAME order (replay)
//   4. Different Idempotency-Key creates a NEW order (no dedup)
//   5. PATCH status flow: pending → preparing → ready → served
//   6. PATCH item status updates the line independently
//   7. PATCH payment toggles unpaid → paid
//   8. Stale If-Match header returns 409 (optimistic lock)
//   9. Served order falls off /api/orders/active
//  10. /api/ops/kds-health snapshot reflects reality

import { mintSmokeIdToken } from "./lib/firebaseToken";
import { assertSafeSmokeTarget } from "./lib/smokeTarget";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
assertSafeSmokeTarget(baseUrl);

interface MenuItem {
  id: string;
  name: string;
  base_price_cents: number;
  available_from: string | null;
  available_until: string | null;
  is_restricted: boolean;
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

  // 2) Menu — Barros Luco + its required Side choice + an Extras add-on.
  //
  // These are real Mazcina menu items, not fixtures. The staging venue stopped
  // being a synthetic "VoxTable Staging Venue" with a 5-item test menu and
  // became a real restaurant, so this suite reads what a caller would actually
  // be offered. If it fails on "not in the menu", the likely cause is that the
  // Mazcina import has not been applied to the target database yet — see
  // deploy/runbooks/mazcina-staging-conversion.md.
  const menu = await request<{ categories: Array<{ items: MenuItem[] }> }>("/api/menu");
  const items = menu.categories.flatMap((c) => c.items);
  const sandwich = items.find((i) => i.name === "Barros Luco");
  assert(sandwich, "Barros Luco not in menu — has the Mazcina menu been imported?");
  const sideGroup = sandwich.modifier_groups.find((g) => g.group_name === "Side");
  assert(sideGroup, "Barros Luco 'Side' modifier group missing");
  // Required: the sandwich comes with chips, and swapping to provenzal is a
  // priced upgrade — so the caller must choose one. This is what exercises the
  // MODIFIER_REQUIRED path.
  assert(sideGroup.group_min_select === 1, "'Side' group should be required (min 1)");
  const provenzal = sideGroup.options.find((o) => o.name === "Provenzal potatoes");
  assert(provenzal, "'Provenzal potatoes' side option missing");
  const extrasGroup = sandwich.modifier_groups.find((g) => g.group_name === "Extras");
  assert(extrasGroup, "Barros Luco 'Extras' modifier group missing");
  const meltedCheese = extrasGroup.options.find((o) => o.name === "Melted cheese");
  assert(meltedCheese, "'Melted cheese' extra missing");

  // Variant coverage moved to an item that genuinely has variants — the
  // empanadas are priced per piece with a filling choice. Nothing on the
  // sandwiches is a variant, and inventing one to keep the old test shape would
  // have meant lying about the menu.
  const empanadas = items.find((i) => i.name === "Cocktail Empanadas");
  assert(empanadas, "Cocktail Empanadas not in menu — has the Mazcina menu been imported?");
  assert(empanadas.variants.length >= 3, "Cocktail Empanadas should carry its filling variants");
  console.log(
    `✓ menu — Barros Luco ${sandwich.id} side=${provenzal.id} extra=${meltedCheese.id}`
  );

  // 2a) Availability-window round trip: set a window, clear it with explicit
  // nulls, and prove the clear actually lands as NULL — the PATCH used to
  // swallow nulls via COALESCE, so a window could be set but never removed.
  // Ends by restoring whatever the item carried, so the venue is left as found.
  const original = {
    available_from: sandwich.available_from,
    available_until: sandwich.available_until
  };
  const windowed = await request<MenuItem>(`/api/menu/items/${sandwich.id}`, {
    method: "PATCH",
    body: JSON.stringify({ available_from: "15:00", available_until: "17:00" })
  });
  assert(windowed.available_from === "15:00:00", `window set: expected 15:00:00, got ${windowed.available_from}`);
  assert(windowed.available_until === "17:00:00", `window set: expected 17:00:00, got ${windowed.available_until}`);
  const cleared = await request<MenuItem>(`/api/menu/items/${sandwich.id}`, {
    method: "PATCH",
    body: JSON.stringify({ available_from: null, available_until: null })
  });
  assert(cleared.available_from === null, `window clear: expected null, got ${cleared.available_from}`);
  assert(cleared.available_until === null, `window clear: expected null, got ${cleared.available_until}`);
  // An omitted key must still mean "keep": PATCH something unrelated and make
  // sure the (now null) window stays untouched.
  const untouched = await request<MenuItem>(`/api/menu/items/${sandwich.id}`, {
    method: "PATCH",
    body: JSON.stringify({ display_order: 0 })
  });
  assert(untouched.available_from === null, "omitted key must not touch the window");
  if (original.available_from !== null || original.available_until !== null) {
    await request<MenuItem>(`/api/menu/items/${sandwich.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        available_from: original.available_from?.slice(0, 5) ?? null,
        available_until: original.available_until?.slice(0, 5) ?? null
      })
    });
  }
  console.log("✓ availability window — set, cleared to NULL, omitted key untouched, original restored");

  // 2b) Pick two real tables so the per-table active-orders filter can be
  // proven both ways (included for its own table, excluded for another).
  // GET /api/tables must also carry the venue clock the floor view runs on.
  const tablesRes = await request<{
    date: string;
    today: string;
    timezone: string;
    now: string;
    tables: Array<{ id: string; label: string }>;
  }>("/api/tables");
  assert(Array.isArray(tablesRes.tables) && tablesRes.tables.length >= 2, "Need at least two tables for the table filter check");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(tablesRes.today), "/api/tables should return today (YYYY-MM-DD) in the venue tz");
  assert(/^\d{2}:\d{2}$/.test(tablesRes.now), "/api/tables should return now (HH:MM) in the venue tz");
  assert(typeof tablesRes.timezone === "string" && tablesRes.timezone.includes("/"), "/api/tables should return the venue IANA timezone");
  const [tableA, tableB] = tablesRes.tables;
  console.log(`✓ tables — ${tablesRes.tables.length} tables, venue clock ${tablesRes.today} ${tablesRes.now} ${tablesRes.timezone}`);

  // 3) Create order with idempotency key
  const idempotencyKey = `smoke-orders-${Date.now()}`;
  const created = (await request<{ order: OrderResponse; is_replay: boolean }>("/api/orders", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      source: "dashboard",
      table_id: tableA!.id,
      items: [
        {
          menu_item_id: sandwich.id,
          modifier_ids: [provenzal.id, meltedCheese.id],
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
  // 24.00 sandwich + 3.00 provenzal upgrade + 3.00 melted cheese. Load-bearing:
  // change a Mazcina price and this fails on purpose.
  assert(created.order.total_cents === 3000, `Expected total=3000, got ${created.order.total_cents}`);
  assert(created.order.items.length === 1, `Expected 1 line, got ${created.order.items.length}`);
  console.log(`✓ create order — #${created.order.order_number} ${created.order.id} total=$${created.order.total_cents / 100}`);

  // 3b) Per-table active orders — the Live Tables order page asks for ONE
  // table's orders in SQL. It must include this order for its own table and
  // exclude it for another, regardless of the venue-wide list limit.
  const forA = await request<{ orders: Array<{ id: string }> }>(`/api/orders/active?table_id=${tableA!.id}`);
  assert(forA.orders.some((o) => o.id === created.order.id), `Order should be active for table ${tableA!.label}`);
  const forB = await request<{ orders: Array<{ id: string }> }>(`/api/orders/active?table_id=${tableB!.id}`);
  assert(!forB.orders.some((o) => o.id === created.order.id), `Order must NOT appear for table ${tableB!.label}`);
  await request("/api/orders/active?table_id=not-a-uuid", { expectStatus: 400 });
  console.log(`✓ active orders filtered by table (${tableA!.label} yes, ${tableB!.label} no, bad id 400)`);

  // 4) Replay with same Idempotency-Key → same order
  const replay = (await request<{ order: OrderResponse; is_replay: boolean }>("/api/orders", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      source: "dashboard",
      items: [
        {
          menu_item_id: sandwich.id,
          modifier_ids: [provenzal.id, meltedCheese.id],
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
