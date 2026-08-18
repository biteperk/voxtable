// Smoke for the Retell tools: /retell/tools/menu-lookup and
// /retell/tools/create-order.
//
// Two modes:
//   * SMOKE_RETELL_SIGNING_KEY (or RETELL_API_KEY) set → every request is
//     signed, so it runs against a server with RETELL_VERIFY_SIGNATURE=true
//     (staging / production posture). Sign with whatever the server verifies
//     with: RETELL_WEBHOOK_SECRET ?? RETELL_API_KEY on the server side.
//   * unset → the unsigned local-dev smoke it always was.
//
// Asserts:
//   1. menu_lookup("fish and chips") returns Fish & Chips first match
//   2. menu_lookup("xyznonexistent") returns 0 matches + a fallback summary
//   3. create_order with no reservation_id and no pickup_name → 400 ORDER_NEEDS_NAME
//   3b. create_order with pickup_name and no reservation → 200 (takeaway)
//   4. create_order with bogus item name → 404 MENU_ITEM_NOT_FOUND
//   5. create_order with Fish & Chips, no drink choice → 400 MODIFIER_REQUIRED
//   6. create_order with full happy path → 200 + order_id + confirmation_message
//   7. Replay same call_id → SAME order_id (idempotency)

import { Retell } from "retell-sdk";

const baseUrl = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3050";
const restaurantId =
  process.env.SMOKE_RESTAURANT_ID ??
  process.env.DEFAULT_RESTAURANT_ID ??
  "11111111-1111-4111-8111-111111111111";
// With a signing key, every tool call carries a valid x-retell-signature and
// this smoke runs against a server with RETELL_VERIFY_SIGNATURE=true (staging).
// Without one it stays the unsigned local-dev smoke it always was.
const signingKey = process.env.SMOKE_RETELL_SIGNING_KEY ?? process.env.RETELL_API_KEY;

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
  // to_number + metadata let the server resolve the venue the same way it
  // does for a real call (dialled number first). Without them, production
  // posture fails closed and every tool call 409s RESTAURANT_NOT_CONFIGURED.
  const body = JSON.stringify({
    name: toolName,
    call: {
      ...(callId ? { call_id: callId } : {}),
      ...(process.env.RETELL_PHONE_NUMBER ? { to_number: process.env.RETELL_PHONE_NUMBER } : {}),
      metadata: { restaurant_id: restaurantId }
    },
    args
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signingKey) {
    headers["x-retell-signature"] = await Retell.sign(body, signingKey);
  }
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body });
  const parsed = (await response.json().catch(() => ({}))) as ToolResponse;
  return { status: response.status, body: parsed };
}

async function createTestBooking(): Promise<string> {
  // Created through the SIGNED create_booking tool — /bookings is a
  // Firebase-gated dashboard route now, and the voice tool is the surface
  // this smoke exists to prove anyway. 30 days out; if the first slot is
  // taken (leftovers from earlier smoke runs), retry once at the server's
  // own suggested time — the collision is the availability engine working.
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  const dateIso = date.toISOString().slice(0, 10);

  const attempt = async (time: string) =>
    callTool(
      "create_booking",
      {
        customer_name: "SMOKE Retell Order",
        customer_phone: "+61400000099",
        date: dateIso,
        time,
        party_size: 2,
        notes: "SMOKE — smoke-retell-orders.ts test booking"
      },
      `smoke-orders-booking-${Date.now()}`
    );

  let result = await attempt("20:30");
  if (result.status !== 200) {
    const details = (result.body.error as { details?: { suggestedTime?: string } } | undefined)
      ?.details;
    if (details?.suggestedTime) {
      console.log(`  (20:30 taken — retrying at suggested ${details.suggestedTime})`);
      result = await attempt(details.suggestedTime);
    }
  }
  const bookingId = (result.body as { booking_id?: string }).booking_id;
  if (result.status !== 200 || !bookingId) {
    throw new Error(`Could not create test booking: ${JSON.stringify(result.body)}`);
  }
  return bookingId;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function main(): Promise<void> {
  console.log(`Smoking ${baseUrl}`);

  // Probe (unsigned mode only): the /retell/* router is HMAC-protected in
  // prod. Check before running so the operator sees a clear "sign or run
  // locally" message instead of a wall of 500s. With a signing key the smoke
  // signs every request, so enforcement is exactly what we want.
  if (!signingKey) {
    const probe = await fetch(`${baseUrl}/retell/tools/menu-lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "menu_lookup", args: { query: "fish" } })
    });
    if (probe.status === 500 || probe.status === 401) {
      const body = await probe.text();
      if (body.includes("RETELL_SIGNATURE") || body.includes("signature")) {
        console.log(
          "Retell signature verification is enabled on this target. Re-run with\n" +
          "SMOKE_RETELL_SIGNING_KEY set to the value the server verifies with\n" +
          "(RETELL_WEBHOOK_SECRET ?? RETELL_API_KEY) and this smoke signs itself."
        );
        return;
      }
    }
  } else {
    console.log("signing enabled — running against enforced signatures");
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

  // 3) No reservation AND no pickup name → 400 ORDER_NEEDS_NAME. A pickup
  //    ticket the kitchen can't call out is worse than no ticket.
  const noName = await callTool(
    "create_order",
    {
      call_id: "smoke-noname-" + Date.now(),
      items: [{ name: "Fish & Chips", quantity: 1, variant_name: "Large", modifier_choices: { Drink: "Coke" } }]
    },
    "smoke-noname"
  );
  assert(noName.status === 400, `expected 400, got ${noName.status}: ${JSON.stringify(noName.body)}`);
  assert(
    noName.body.error?.code === "ORDER_NEEDS_NAME",
    `expected ORDER_NEEDS_NAME, got ${noName.body.error?.code}`
  );
  console.log("✓ create_order with no reservation and no name → 400 ORDER_NEEDS_NAME");

  // 3b) Takeaway: no reservation, but a pickup name → order is created. This
  //     is the phone-pickup path; it used to throw ORDER_REQUIRES_BOOKING and
  //     offer the caller a table they never asked for.
  const pickupCallId = `smoke-pickup-${Date.now()}`;
  const pickup = await callTool(
    "create_order",
    {
      call_id: pickupCallId,
      pickup_name: "Marco",
      pickup_time: "6:30pm",
      items: [{ name: "Fish & Chips", quantity: 1, variant_name: "Large", modifier_choices: { Drink: "Coke" } }]
    },
    pickupCallId
  );
  assert(pickup.status === 200, `expected 200, got ${pickup.status}: ${JSON.stringify(pickup.body)}`);
  assert(pickup.body.order_id, "takeaway order should return order_id");
  assert(
    pickup.body.confirmation_message?.includes("Order #"),
    "takeaway confirmation should include order number"
  );
  // Deliberately not echoing the confirmation text: it's server-returned data
  // and the assertion above already proved its shape (Sonar S5145).
  console.log("✓ takeaway order without reservation → order created with confirmation");

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

  // 7) IDENTICAL replay of the same tool call → same order (true retry dedup).
  //    The payload must match step 6 exactly — the idempotency key is now
  //    call_id + a fingerprint of the order's content, so only a genuine
  //    retry (same items, same requests) collapses onto the existing order.
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
          modifier_choices: { Drink: "Coke" },
          special_requests: "smoke test"
        }
      ],
      special_instructions: "Smoke happy-path order from smoke-retell-orders.ts"
    },
    callId
  );
  assert(replay.status === 200, `replay status ${replay.status}: ${JSON.stringify(replay.body)}`);
  assert(
    replay.body.order_id === happy.body.order_id,
    `identical replay should return same order_id (got ${replay.body.order_id}, want ${happy.body.order_id})`
  );
  assert(replay.body.is_replay === true, "identical replay must report is_replay=true");
  console.log("✓ identical replay returns same order_id");

  // 8) A SECOND, DIFFERENT order in the same call → NEW order. This was
  //    audit B8: the key used to be the bare call_id, so the guest's added
  //    Coke was confirmed to them, then silently never made or billed.
  const second = await callTool(
    "create_order",
    {
      call_id: callId,
      reservation_id: bookingId,
      items: [
        {
          name: "Fish & Chips",
          quantity: 2,
          variant_name: "Large",
          modifier_choices: { Drink: "Coke" }
        }
      ]
    },
    callId
  );
  assert(second.status === 200, `second order status ${second.status}: ${JSON.stringify(second.body)}`);
  assert(
    second.body.order_id && second.body.order_id !== happy.body.order_id,
    `a different order in the same call must create a NEW order (got ${second.body.order_id})`
  );
  assert(second.body.is_replay !== true, "a different order must not be a replay");
  console.log("✓ different order in the same call creates a new order (B8)");

  console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err.message);
  process.exit(1);
});
