// Smoke for the new Retell tools: /retell/tools/menu-lookup and
// /retell/tools/create-order. Skips signature verification by hitting
// localhost (RETELL_VERIFY_SIGNATURE=false in dev) — for prod, point
// PUBLIC_API_BASE_URL at the live backend; signature is disabled on the
// VM today so the same script works.
//
// Asserts:
//   1. menu_lookup("fish and chips") returns Fish & Chips first match
//   2. menu_lookup("xyznonexistent") returns 0 matches + a fallback summary
//   3. create_order without reservation_id → 400 ORDER_REQUIRES_BOOKING
//   4. create_order with bogus item name → 404 MENU_ITEM_NOT_FOUND
//   5. create_order with Fish & Chips, no drink choice → 400 MODIFIER_REQUIRED
//   6. create_order with full happy path → 200 + order_id + confirmation_message
//   7. Replay same call_id → SAME order_id (idempotency)

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
const restaurantId =
  process.env.DEFAULT_RESTAURANT_ID ?? "11111111-1111-4111-8111-111111111111";

interface ToolResponse {
  // menu_lookup
  matches?: Array<{ id: string; name: string; price_cents: number }>;
  speakable_summary?: string;
  ambiguous?: boolean;
  // create_order
  order_id?: string;
  order_number?: number | null;
  confirmation_message?: string;
  is_replay?: boolean;
  // error
  error?: { code: string; message: string };
}

async function callTool(
  toolName: string,
  args: unknown,
  callId?: string
): Promise<{ status: number; body: ToolResponse }> {
  const path = `/retell/tools/${toolName.replace(/_/g, "-")}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: toolName,
      call: callId ? { call_id: callId } : undefined,
      args
    })
  });
  const body = (await response.json().catch(() => ({}))) as ToolResponse;
  return { status: response.status, body };
}

async function createTestBooking(): Promise<string> {
  // Bookings the smoke order against; uses a date 30 days out so it never
  // collides with real bookings.
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  const dateIso = date.toISOString().slice(0, 10);
  const response = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      restaurant_id: restaurantId,
      customer_name: "Smoke Retell Order",
      customer_phone: "+61400000099",
      date: dateIso,
      time: "20:30",
      party_size: 2,
      source: "voice",
      notes: "smoke-retell-orders.ts test booking"
    })
  });
  const body = (await response.json()) as { booking_id?: string; error?: unknown };
  if (!response.ok || !body.booking_id) {
    throw new Error(`Could not create test booking: ${JSON.stringify(body)}`);
  }
  return body.booking_id;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function main(): Promise<void> {
  console.log(`Smoking ${baseUrl}`);

  // Probe: the /retell/* router is HMAC-protected in prod. Check before
  // running so the operator sees a clear "run me locally" message instead
  // of a wall of 500s.
  const probe = await fetch(`${baseUrl}/retell/tools/menu-lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "menu_lookup", args: { query: "fish" } })
  });
  if (probe.status === 500 || probe.status === 401) {
    const body = await probe.text();
    if (body.includes("RETELL_SIGNATURE") || body.includes("signature")) {
      console.log(
        "Retell signature verification is enabled on this target — this smoke\n" +
        "is intended for LOCAL dev where RETELL_VERIFY_SIGNATURE=false. To smoke\n" +
        "the real Retell tools in prod, place a real test call from the Retell\n" +
        "console with the v3 prompt installed and verify the order on the KDS."
      );
      return;
    }
  }

  // 1) menu_lookup happy path
  const lookup = await callTool("menu_lookup", { query: "fish and chips" });
  assert(lookup.status === 200, `menu_lookup status ${lookup.status}`);
  assert(
    lookup.body.matches && lookup.body.matches.length > 0,
    `menu_lookup should return matches: ${JSON.stringify(lookup.body)}`
  );
  assert(
    lookup.body.matches![0]!.name === "Fish & Chips",
    `top match should be Fish & Chips, got ${lookup.body.matches![0]?.name}`
  );
  assert(
    typeof lookup.body.speakable_summary === "string" && lookup.body.speakable_summary.length > 0,
    "speakable_summary must be present"
  );
  console.log(`✓ menu_lookup("fish and chips") → top=${lookup.body.matches![0]!.name}`);

  // 2) menu_lookup zero matches
  const noMatch = await callTool("menu_lookup", { query: "xyznonexistent" });
  assert(noMatch.status === 200, `menu_lookup zero-match status ${noMatch.status}`);
  assert(
    noMatch.body.matches !== undefined && noMatch.body.matches.length === 0,
    "should return zero matches"
  );
  assert(
    typeof noMatch.body.speakable_summary === "string",
    "should still return a speakable summary so Bella can recover"
  );
  console.log("✓ menu_lookup zero matches returns fallback summary");

  // Test booking for the order flow
  const bookingId = await createTestBooking();
  console.log(`✓ test booking ${bookingId}`);

  // 3) create_order without reservation_id → 400 ORDER_REQUIRES_BOOKING
  const noBooking = await callTool(
    "create_order",
    {
      call_id: "smoke-noreservation-" + Date.now(),
      items: [{ name: "Fish & Chips", quantity: 1, variant_name: "Large", modifier_choices: { Drink: "Coke" } }]
    },
    "smoke-noreservation"
  );
  assert(noBooking.status === 400, `expected 400, got ${noBooking.status}: ${JSON.stringify(noBooking.body)}`);
  assert(
    noBooking.body.error?.code === "ORDER_REQUIRES_BOOKING",
    `expected ORDER_REQUIRES_BOOKING, got ${noBooking.body.error?.code}`
  );
  console.log("✓ create_order without reservation → 400 ORDER_REQUIRES_BOOKING");

  // 4) create_order with bogus item name → 404 MENU_ITEM_NOT_FOUND
  const bogusItem = await callTool(
    "create_order",
    {
      call_id: "smoke-bogus-" + Date.now(),
      reservation_id: bookingId,
      items: [{ name: "Magical Phoenix Soup", quantity: 1 }]
    },
    "smoke-bogus"
  );
  assert(bogusItem.status === 404, `expected 404, got ${bogusItem.status}: ${JSON.stringify(bogusItem.body)}`);
  assert(
    bogusItem.body.error?.code === "MENU_ITEM_NOT_FOUND",
    `expected MENU_ITEM_NOT_FOUND, got ${bogusItem.body.error?.code}`
  );
  console.log("✓ bogus item name → 404 MENU_ITEM_NOT_FOUND");

  // 5) Fish & Chips with no drink → 400 MODIFIER_REQUIRED
  const noDrink = await callTool(
    "create_order",
    {
      call_id: "smoke-nodrink-" + Date.now(),
      reservation_id: bookingId,
      items: [{ name: "Fish & Chips", quantity: 1, variant_name: "Large" }]
    },
    "smoke-nodrink"
  );
  assert(noDrink.status === 400, `expected 400, got ${noDrink.status}: ${JSON.stringify(noDrink.body)}`);
  assert(
    noDrink.body.error?.code === "MODIFIER_REQUIRED",
    `expected MODIFIER_REQUIRED, got ${noDrink.body.error?.code}`
  );
  console.log("✓ missing required drink → 400 MODIFIER_REQUIRED");

  // 6) Full happy path
  const callId = `smoke-happy-${Date.now()}`;
  const happy = await callTool(
    "create_order",
    {
      call_id: callId,
      reservation_id: bookingId,
      items: [
        {
          name: "Fish & Chips",
          quantity: 1,
          variant_name: "Large",
          modifier_choices: { Drink: "Coke" },
          special_requests: "smoke test"
        }
      ],
      special_instructions: "Smoke happy-path order from smoke-retell-orders.ts"
    },
    callId
  );
  assert(happy.status === 200, `expected 200, got ${happy.status}: ${JSON.stringify(happy.body)}`);
  assert(happy.body.order_id, "should return order_id");
  assert(happy.body.confirmation_message?.includes("Order #"), "confirmation should include order number");
  console.log(
    `✓ happy path → ${happy.body.confirmation_message}`
  );

  // 7) Replay same call_id → same order
  const replay = await callTool(
    "create_order",
    {
      call_id: callId,
      reservation_id: bookingId,
      items: [
        {
          name: "Fish & Chips",
          quantity: 1,
          variant_name: "Large",
          modifier_choices: { Drink: "Coke" }
        }
      ]
    },
    callId
  );
  assert(replay.status === 200, `replay status ${replay.status}: ${JSON.stringify(replay.body)}`);
  assert(
    replay.body.order_id === happy.body.order_id,
    `replay should return same order_id (got ${replay.body.order_id}, want ${happy.body.order_id})`
  );
  assert(replay.body.is_replay === true, "replay must report is_replay=true");
  console.log("✓ idempotent replay returns same order_id");

  console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err.message);
  process.exit(1);
});
