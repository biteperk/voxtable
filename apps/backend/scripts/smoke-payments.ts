// Smoke for the voice-order payment-link flow — service-level, in-process,
// against the dev/CI database. NO Stripe credentials needed: the Checkout
// gateway is swapped for a fixture that counts session creates, so the
// double-fire/replay guarantees are provable offline (CI has no Stripe keys;
// staging runs this same script with the flags on and can follow up with a
// real card).
//
// Asserts:
//   1. send → sent:true, exactly 1 order_payments row + 1 sms outbox row
//   2. send again → is_replay:true, still 1/1, ZERO new Stripe sessions
//   3. order total changes → old row cancelled + session expired, new row
//   4. completed(paid) webhook → order paid + one payment_changed event
//   5. same event replayed → no duplicate event (monotonic guard)
//   6. completed(unpaid) → order stays unpaid, row 'processing'
//   7. amount-mismatch completed → row paid w/ received cents, order UNPAID
//   8. completed for a cancelled order → order untouched, row paid
//   9. charge.refunded then replayed completed → order stays refunded
//  10. session with biteperk_kind but no row → handler THROWS (Stripe retries)
//  11. kill switch off → link creation refuses, webhook still reconciles
//  12. order-payment event through handleBillingWebhook → onboarding untouched

process.env.ORDER_PAYMENTS_ENABLED = "true";
process.env.STRIPE_CONNECT_ENABLED = "true";
process.env.NOTIFICATIONS_ENABLED = process.env.NOTIFICATIONS_ENABLED ?? "true";
process.env.PUBLIC_ORDER_RETURN_BASE_URL =
  process.env.PUBLIC_ORDER_RETURN_BASE_URL ?? "http://localhost:3051";

import type Stripe from "stripe";

async function main(): Promise<void> {
  const { pool } = await import("../src/db/pool");
  const { env } = await import("../src/config/env");
  const {
    __setCheckoutGatewayForTesting,
    createOrderPaymentLink,
    handleOrderPaymentWebhook,
    resolvePayLink,
    resolveReceiptLink
  } = await import("../src/services/orderPaymentService");
  const { handleBillingWebhook } = await import("../src/services/stripeService");
  const { createOrder, updateOrderStatus } = await import("../src/services/orderService");
  const { createSmokeRestaurant, cleanupSmokeRestaurant, SMOKE_SUFFIX } = await import(
    "./lib/smoke-harness"
  );

  let sessionCounter = 0;
  const expired: string[] = [];
  const RECEIPT_URL = "https://pay.stripe.com/receipts/smoke";
  let receiptMode: "url" | "null" | "throw" = "url";
  const receiptLookups: string[] = [];
  const fixtureGateway = {
    async createSession() {
      sessionCounter += 1;
      const id = `cs_test_smoke_${Date.now()}_${sessionCounter}`;
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    },
    async expireSession(sessionId: string) {
      expired.push(sessionId);
    },
    async retrieveSession(): Promise<never> {
      throw new Error("smoke fixture: retrieveSession not expected in this run");
    },
    // Receipt look-up: "url" (normal), "null" (Stripe has no charge yet), "throw"
    // (Stripe down). The paid path must succeed in all three.
    async retrieveReceiptUrl(paymentIntentId: string): Promise<string | null> {
      receiptLookups.push(paymentIntentId);
      if (receiptMode === "throw") throw new Error("smoke fixture: Stripe unavailable");
      return receiptMode === "null" ? null : `${RECEIPT_URL}_${paymentIntentId}`;
    }
  };
  __setCheckoutGatewayForTesting(fixtureGateway);

  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(`assertion failed: ${message}`);
  };
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
    const r = await pool.query(sql, params);
    return r.rows[0] as T;
  };

  // Self-provisioned fixtures, per house convention: CI never seeds, and no
  // smoke may depend on seed data or leave residue.
  const { restaurantId } = await createSmokeRestaurant({
    name: `Payments Smoke ${SMOKE_SUFFIX}`,
    phoneNumber: `+6129009${String(process.pid % 10000).padStart(4, "0")}`,
    tables: [{ label: "P1", minCapacity: 1, maxCapacity: 4 }]
  });
  const PHONE = "+61400000001";

  const category = await one<{ id: string }>(
    `INSERT INTO menu_categories (restaurant_id, name) VALUES ($1, 'Smoke Mains') RETURNING id`,
    [restaurantId]
  );
  const menuItem = await one<{ id: string }>(
    `INSERT INTO menu_items (restaurant_id, category_id, name, base_price_cents, is_available)
     VALUES ($1, $2, 'Smoke Fish and Chips', 1850, true) RETURNING id`,
    [restaurantId, category.id]
  );

  // Point the venue at a fixture connected account.
  await pool.query(
    `UPDATE restaurants SET stripe_connect_account_id = 'acct_smoke_${SMOKE_SUFFIX}',
       stripe_connect_charges_enabled = true WHERE id = $1`,
    [restaurantId]
  );

  // pid + counters, not Math.random — the duplication/security gates both
  // objected to pseudorandom ids in smokes before (see smoke-harness).
  let orderCounter = 0;
  let eventCounter = 0;

  const createdOrderIds: string[] = [];
  const makeOrder = async (): Promise<{ id: string; total_cents: number; version: number }> => {
    orderCounter += 1;
    const result = await createOrder({
      restaurantId,
      source: "dashboard",
      items: [{ menuItemId: menuItem.id, quantity: 1 }],
      idempotencyKey: `smoke-payments-${SMOKE_SUFFIX}-${Date.now()}-${orderCounter}`,
      createdBy: "smoke:payments"
    });
    createdOrderIds.push(result.order.id);
    return { id: result.order.id, total_cents: result.order.total_cents, version: result.order.version };
  };

  const paymentRows = (orderId: string) =>
    pool
      .query("SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at", [orderId])
      .then((r) => r.rows);
  const smsRows = (recipient: string) =>
    pool
      .query(
        "SELECT * FROM notifications_outbox WHERE channel = 'sms' AND recipient = $1 AND kind = 'order_payment_link'",
        [recipient]
      )
      .then((r) => r.rows);
  const receiptRows = (recipient: string) =>
    pool
      .query(
        "SELECT * FROM notifications_outbox WHERE channel = 'sms' AND recipient = $1 AND kind = 'order_payment_receipt' ORDER BY created_at",
        [recipient]
      )
      .then((r) => r.rows);
  const paymentEvents = (orderId: string) =>
    pool
      .query(
        "SELECT * FROM order_events WHERE order_id = $1 AND event_type = 'payment_changed' ORDER BY created_at",
        [orderId]
      )
      .then((r) => r.rows);
  const orderState = (orderId: string) =>
    one<{ payment_status: string; status: string }>(
      "SELECT payment_status, status FROM orders WHERE id = $1",
      [orderId]
    );

  const sessionEvent = (
    type: string,
    session: Partial<Stripe.Checkout.Session>
  ): Stripe.Event => {
    eventCounter += 1;
    return {
      id: `evt_smoke_${SMOKE_SUFFIX}_${eventCounter}`,
      type,
      data: { object: { metadata: { biteperk_kind: "order_payment" }, ...session } }
    } as unknown as Stripe.Event;
  };

  try {
    // --- 1: create link ------------------------------------------------------
    const orderA = await makeOrder();
    const first = await createOrderPaymentLink({
      restaurantId,
      orderId: orderA.id,
      recipientPhone: PHONE,
      actor: "smoke:payments"
    });
    assert(first.sent === true, "first send should succeed");
    assert(!("checkout_url" in (first as Record<string, unknown>)), "outcome must not carry a URL");
    let rows = await paymentRows(orderA.id);
    assert(rows.length === 1, `expected 1 payment row, got ${rows.length}`);
    assert(rows[0].status === "sent", `row should be 'sent', got ${rows[0].status}`);
    let sms = await smsRows(PHONE);
    assert(sms.length === 1, `expected 1 sms outbox row, got ${sms.length}`);
    const smsBody = String(sms[0].body);
    const linkStart = smsBody.indexOf("http");
    assert(linkStart >= 0, "sms body carries a link");
    const smsLink = smsBody.slice(linkStart).split("\n")[0].split(" ")[0];
    // Short branded link on the return host, never the raw Stripe URL (migration 044).
    assert(smsLink === `${env.PUBLIC_ORDER_RETURN_BASE_URL.replace(/\/+$/, "")}/pay/${rows[0].public_token}`, "sms link is the short /pay/<token> link");
    assert(!smsBody.includes("stripe.com"), "no Stripe URL in the text");
    assert(sessionCounter === 1, "exactly one Stripe session created");
    console.log("✓ 1. link created: 1 payment row, 1 sms, 1 session");

    // --- 2: replay -----------------------------------------------------------
    const replay = await createOrderPaymentLink({
      restaurantId,
      orderId: orderA.id,
      recipientPhone: PHONE,
      actor: "smoke:payments"
    });
    assert(replay.sent === true && replay.isReplay === true, "second call should replay");
    rows = await paymentRows(orderA.id);
    sms = await smsRows(PHONE);
    assert(rows.length === 1 && sms.length === 1, "replay must not add rows");
    assert(sessionCounter === 1, `replay must not mint a session (got ${sessionCounter})`);
    console.log("✓ 2. double-fire replays: no new row, no new sms, no new session");

    // --- 3: stale amount → regenerate ---------------------------------------
    const oldSession = rows[0].stripe_checkout_session_id as string;
    await pool.query("UPDATE orders SET total_cents = total_cents + 500 WHERE id = $1", [orderA.id]);
    const regen = await createOrderPaymentLink({
      restaurantId,
      orderId: orderA.id,
      recipientPhone: PHONE,
      actor: "smoke:payments"
    });
    assert(regen.sent === true && regen.isReplay === false, "amount change must mint a fresh link");
    {
      // Short links: the text carries /pay/<token>, never the Stripe URL; the token resolves to
      // the live checkout URL while active.
      const rowsNow = await paymentRows(orderA.id);
      const fresh = rowsNow[rowsNow.length - 1];
      assert(typeof fresh.public_token === "string" && /^[A-Za-z0-9_-]{22}$/.test(fresh.public_token), "row carries a 22-char public token");
      assert(rowsNow[0].public_token !== fresh.public_token, "each payment row mints its own token");
      const linkSms = (await smsRows(PHONE)).slice(-1)[0];
      assert(linkSms.body.includes(`/pay/${fresh.public_token}`), "link SMS carries the short /pay link");
      assert(!linkSms.body.includes("stripe.com") && linkSms.body.length <= 160, "link SMS is one segment with no Stripe URL");
      const live = await resolvePayLink(fresh.public_token);
      assert(live.outcome === "checkout" && live.location === fresh.checkout_url, "active token resolves to the checkout URL");
      const stale = await resolvePayLink(rowsNow[0].public_token);
      assert(stale.outcome === "expired" && stale.location.endsWith("/order/expired"), "cancelled row's token lands on the expired page");
      const unknown = await resolvePayLink("AAAAAAAAAAAAAAAAAAAAAA");
      assert(unknown.outcome === "unknown" && unknown.location === stale.location, "unknown token is indistinguishable from expired");
      const malformed = await resolvePayLink("../etc/passwd");
      assert(malformed.outcome === "unknown", "malformed token never reaches the database");
      const noReceiptYet = await resolveReceiptLink(fresh.public_token);
      assert(noReceiptYet.outcome === "no_receipt", "receipt link before payment has nothing to show");
    }
    rows = await paymentRows(orderA.id);
    assert(rows.length === 2, "expected old + new payment rows");
    assert(rows[0].status === "cancelled", "stale row must be cancelled");
    assert(expired.includes(oldSession), "stale Stripe session must be expired");
    const active = rows[1];
    console.log("✓ 3. order edit retires the old link and mints a new one");

    // --- 4: completed(paid) → order paid ------------------------------------
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", {
        id: active.stripe_checkout_session_id,
        payment_status: "paid",
        amount_total: active.amount_cents,
        payment_intent: "pi_smoke_a"
      })
    );
    assert((await orderState(orderA.id)).payment_status === "paid", "order should be paid");
    let events = await paymentEvents(orderA.id);
    const paidEvents = events.filter((e) => e.to_value === "paid");
    assert(paidEvents.length === 1, `expected 1 paid event, got ${paidEvents.length}`);
    let receipts = await receiptRows(PHONE);
    assert(receipts.length === 1, `expected 1 receipt SMS, got ${receipts.length}`);
    assert(receipts[0].body.includes(`/receipt/${(await paymentRows(orderA.id))[1].public_token}`), "receipt SMS carries the short /receipt link");
    assert(!receipts[0].body.includes("stripe.com") && receipts[0].body.length <= 160, "receipt SMS is one segment with no Stripe URL");
    {
      const paidRow = (await paymentRows(orderA.id))[1];
      assert(paidRow.receipt_url === `${RECEIPT_URL}_pi_smoke_a`, "receipt_url stored on the paid row");
      const r = await resolveReceiptLink(paidRow.public_token);
      assert(r.outcome === "receipt" && r.location === `${RECEIPT_URL}_pi_smoke_a`, "receipt token resolves to Stripe's receipt page");
      const p = await resolvePayLink(paidRow.public_token);
      assert(p.outcome === "paid" && p.location.endsWith("/order/paid"), "pay link after payment lands on the paid page");
    }
    assert(receipts[0].body.includes("Do not reply"), "receipt SMS is one-way");
    const paidRowA = (await paymentRows(orderA.id))[1];
    assert(paidRowA.receipt_notification_id === receipts[0].id, "payment row points at its receipt SMS");
    assert(receiptLookups.length === 1, "receipt looked up exactly once");
    console.log("✓ 4. paid webhook flips the order, writes one event, texts one receipt");

    // --- 5: replayed completed → no dupe ------------------------------------
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", {
        id: active.stripe_checkout_session_id,
        payment_status: "paid",
        amount_total: active.amount_cents,
        payment_intent: "pi_smoke_a"
      })
    );
    events = await paymentEvents(orderA.id);
    assert(
      events.filter((e) => e.to_value === "paid").length === 1,
      "replayed webhook must not duplicate the paid event"
    );
    receipts = await receiptRows(PHONE);
    assert(receipts.length === 1, "replayed webhook must not text a second receipt");
    assert(receiptLookups.length === 1, "replay must not re-fetch the receipt (row already carries one)");
    console.log("✓ 5. webhook replay is a no-op (one event, one receipt)");

    // --- 5b: Stripe has no receipt yet → paid, one unlinked receipt ----------
    receiptMode = "null";
    const orderNull = await makeOrder();
    const sendNull = await createOrderPaymentLink({ restaurantId, orderId: orderNull.id, recipientPhone: PHONE, actor: "smoke:payments" });
    assert(sendNull.sent, "orderNull send failed");
    const rowNull = (await paymentRows(orderNull.id))[0];
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", { id: rowNull.stripe_checkout_session_id, payment_status: "paid", amount_total: rowNull.amount_cents, payment_intent: "pi_smoke_null" })
    );
    assert((await orderState(orderNull.id)).payment_status === "paid", "order paid even with no receipt url");
    receipts = await receiptRows(PHONE);
    assert(receipts.length === 2 && !receipts[1].body.includes("https://"), "unlinked receipt sent when Stripe has no receipt url");
    console.log("✓ 5b. no receipt url from Stripe: paid, one unlinked receipt");

    // --- 5c: Stripe down on the receipt look-up → paid, one unlinked receipt --
    receiptMode = "throw";
    const orderThrow = await makeOrder();
    const sendThrow = await createOrderPaymentLink({ restaurantId, orderId: orderThrow.id, recipientPhone: PHONE, actor: "smoke:payments" });
    assert(sendThrow.sent, "orderThrow send failed");
    const rowThrow = (await paymentRows(orderThrow.id))[0];
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", { id: rowThrow.stripe_checkout_session_id, payment_status: "paid", amount_total: rowThrow.amount_cents, payment_intent: "pi_smoke_throw" })
    );
    assert((await orderState(orderThrow.id)).payment_status === "paid", "a receipt look-up failure must never block the paid path");
    receipts = await receiptRows(PHONE);
    assert(receipts.length === 3 && !receipts[2].body.includes("https://"), "receipt still sent, without a link");
    receiptMode = "url";
    console.log("✓ 5c. Stripe down on the receipt look-up: still paid, receipt without a link");

    // --- 5d: no recipient on the row → paid, no receipt, no look-up ----------
    const orderNoPhone = await makeOrder();
    const sendNoPhone = await createOrderPaymentLink({ restaurantId, orderId: orderNoPhone.id, recipientPhone: PHONE, actor: "smoke:payments" });
    assert(sendNoPhone.sent, "orderNoPhone send failed");
    const rowNoPhone = (await paymentRows(orderNoPhone.id))[0];
    await pool.query("UPDATE order_payments SET recipient_phone = NULL WHERE id = $1", [rowNoPhone.id]);
    const lookupsBefore = receiptLookups.length;
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", { id: rowNoPhone.stripe_checkout_session_id, payment_status: "paid", amount_total: rowNoPhone.amount_cents, payment_intent: "pi_smoke_nophone" })
    );
    assert((await orderState(orderNoPhone.id)).payment_status === "paid", "order paid with no recipient");
    assert((await receiptRows(PHONE)).length === 3, "no recipient: no receipt row");
    assert(receiptLookups.length === lookupsBefore, "no recipient: no Stripe look-up either");
    console.log("✓ 5d. no recipient phone: paid, nothing texted, nothing fetched");
    const receiptsBaseline = 3;

    // --- 6: async method pending --------------------------------------------
    const orderB = await makeOrder();
    const sendB = await createOrderPaymentLink({
      restaurantId,
      orderId: orderB.id,
      recipientPhone: PHONE,
      actor: "smoke:payments"
    });
    assert(sendB.sent, "orderB send failed");
    const rowB = (await paymentRows(orderB.id))[0];
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", {
        id: rowB.stripe_checkout_session_id,
        payment_status: "unpaid",
        amount_total: rowB.amount_cents,
        payment_intent: "pi_smoke_b"
      })
    );
    assert((await orderState(orderB.id)).payment_status === "unpaid", "async-pending must NOT pay the order");
    assert(
      (await paymentRows(orderB.id))[0].status === "processing",
      "row should be processing while the method settles"
    );
    console.log("✓ 6. kitchen doesn't cook on a promise (async method pending)");

    // --- 7: amount mismatch --------------------------------------------------
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.async_payment_succeeded", {
        id: rowB.stripe_checkout_session_id,
        payment_status: "paid",
        amount_total: rowB.amount_cents + 999,
        payment_intent: "pi_smoke_b"
      })
    );
    const rowB2 = (await paymentRows(orderB.id))[0];
    assert(rowB2.status === "paid", "mismatch: money is recorded on the payment row");
    assert(rowB2.amount_received_cents === rowB.amount_cents + 999, "received cents recorded");
    assert(
      (await orderState(orderB.id)).payment_status === "unpaid",
      "mismatch: ORDER must stay unpaid for staff to resolve"
    );
    assert((await receiptRows(PHONE)).length === receiptsBaseline, "mismatch must not text a receipt");
    console.log("✓ 7. amount mismatch records the money but never auto-settles the order (no receipt)");

    // --- 8: paid after cancel ------------------------------------------------
    const orderC = await makeOrder();
    const sendC = await createOrderPaymentLink({
      restaurantId,
      orderId: orderC.id,
      recipientPhone: PHONE,
      actor: "smoke:payments"
    });
    assert(sendC.sent, "orderC send failed");
    const rowC = (await paymentRows(orderC.id))[0];
    const currentC = await one<{ version: number }>("SELECT version FROM orders WHERE id = $1", [orderC.id]);
    await updateOrderStatus({
      id: orderC.id,
      restaurantId,
      expectedVersion: currentC.version,
      nextStatus: "cancelled",
      actor: "smoke:payments",
      cancellationReason: "smoke"
    });
    // The cancel hook retires the link; simulate the guest paying anyway on a
    // fresh row (re-arm one active row directly to model the race).
    await pool.query("UPDATE order_payments SET status = 'sent' WHERE id = $1", [rowC.id]);
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", {
        id: rowC.stripe_checkout_session_id,
        payment_status: "paid",
        amount_total: rowC.amount_cents,
        payment_intent: "pi_smoke_c"
      })
    );
    const stateC = await orderState(orderC.id);
    assert(stateC.status === "cancelled" && stateC.payment_status === "unpaid",
      "a cancelled order must never become paid");
    assert((await paymentRows(orderC.id))[0].status === "paid", "the money IS recorded for the refund");
    assert((await receiptRows(PHONE)).length === receiptsBaseline, "paid-after-cancel must not text a receipt");
    console.log("✓ 8. paying a cancelled order records money, alerts, never cooks, texts nothing");

    // --- 9: refund is terminal ----------------------------------------------
    await handleOrderPaymentWebhook(
      {
        id: "evt_smoke_refund",
        type: "charge.refunded",
        data: { object: { payment_intent: "pi_smoke_a", metadata: { biteperk_kind: "order_payment" } } }
      } as unknown as Stripe.Event
    );
    assert((await orderState(orderA.id)).payment_status === "refunded", "refund should mark the order");
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.completed", {
        id: active.stripe_checkout_session_id,
        payment_status: "paid",
        amount_total: active.amount_cents,
        payment_intent: "pi_smoke_a"
      })
    );
    assert(
      (await orderState(orderA.id)).payment_status === "refunded",
      "a late completed replay must NOT resurrect paid after a refund"
    );
    console.log("✓ 9. refunded is terminal against late webhook replays");

    // --- 10: ours-but-missing throws ----------------------------------------
    let threw = false;
    try {
      await handleOrderPaymentWebhook(
        sessionEvent("checkout.session.completed", {
          id: "cs_test_never_recorded",
          payment_status: "paid",
          amount_total: 1000
        })
      );
    } catch {
      threw = true;
    }
    assert(threw, "an order-payment session with no row must throw (500 → Stripe retries)");
    console.log("✓ 10. unknown-but-ours session throws so Stripe redelivers");

    // --- 11: kill switch gates creation, not reconciliation ------------------
    (env as { ORDER_PAYMENTS_ENABLED: boolean }).ORDER_PAYMENTS_ENABLED = false;
    const refused = await createOrderPaymentLink({
      restaurantId,
      orderId: orderB.id,
      recipientPhone: PHONE,
      actor: "smoke:payments"
    });
    assert(refused.sent === false && refused.code === "PAYMENTS_DISABLED", "flag off must refuse creation");
    // Reconciliation still runs with the flag off: expire orderB's row.
    await handleOrderPaymentWebhook(
      sessionEvent("checkout.session.expired", { id: rowB.stripe_checkout_session_id })
    );
    // (row was already 'paid' from step 7 — expired must NOT downgrade it.)
    assert(
      (await paymentRows(orderB.id))[0].status === "paid",
      "expired after paid must not downgrade (transition guard)"
    );
    (env as { ORDER_PAYMENTS_ENABLED: boolean }).ORDER_PAYMENTS_ENABLED = true;
    console.log("✓ 11. kill switch gates creation only; webhook keeps working; terminals hold");

    // --- 12: cross-contamination guard --------------------------------------
    const onboardingBefore = await one<{ onboarding_status: string }>(
      "SELECT onboarding_status FROM restaurants WHERE id = $1",
      [restaurantId]
    );
    const outcome = await handleBillingWebhook(
      sessionEvent("checkout.session.completed", {
        id: active.stripe_checkout_session_id,
        payment_status: "paid",
        amount_total: active.amount_cents,
        // The exact fields that used to collide with billing attribution:
        client_reference_id: restaurantId,
        metadata: {
          biteperk_kind: "order_payment",
          order_id: orderA.id,
          restaurant_id: restaurantId
        } as never
      })
    );
    assert(
      String(outcome).startsWith("order_payment:"),
      `billing webhook must branch to order payments, got "${outcome}"`
    );
    const onboardingAfter = await one<{ onboarding_status: string }>(
      "SELECT onboarding_status FROM restaurants WHERE id = $1",
      [restaurantId]
    );
    assert(
      onboardingBefore.onboarding_status === onboardingAfter.onboarding_status,
      "a guest paying for fish and chips must NOT advance the venue's SaaS onboarding"
    );
    console.log("✓ 12. order payments never touch subscription/onboarding state");

    console.log("\nAll payment smoke assertions passed.");
  } finally {
    // Cleanup: order_payments references orders and restaurants with RESTRICT
    // (financial ledger), so it must go first; everything else unwinds child →
    // parent, ending with the harness restaurant teardown.
    if (createdOrderIds.length > 0) {
      await pool.query("DELETE FROM order_payments WHERE order_id = ANY($1)", [createdOrderIds]);
      await pool.query("DELETE FROM order_events WHERE order_id = ANY($1)", [createdOrderIds]);
      await pool.query(
        "DELETE FROM order_item_modifiers WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ANY($1))",
        [createdOrderIds]
      );
      await pool.query("DELETE FROM order_items WHERE order_id = ANY($1)", [createdOrderIds]);
      await pool.query("DELETE FROM orders WHERE id = ANY($1)", [createdOrderIds]);
    }
    await pool.query(
      "DELETE FROM notifications_outbox WHERE restaurant_id = $1 AND kind IN ('order_payment_link', 'order_payment_receipt')",
      [restaurantId]
    );
    await pool.query("DELETE FROM menu_items WHERE restaurant_id = $1", [restaurantId]);
    await pool.query("DELETE FROM menu_categories WHERE restaurant_id = $1", [restaurantId]);
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }
}

main().catch((error) => {
  console.error("smoke-payments FAILED:", error);
  process.exit(1);
});
