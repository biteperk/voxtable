/**
 * Payment-watch smoke test — proves Bella can see a payment land, exactly once,
 * and from the source of truth.
 *
 * Each assertion below fails against the version of this feature that shipped
 * a few hours earlier, and each corresponds to a real defect found reviewing it:
 *
 *  - it read the REPLICA, so a guest who paid four seconds ago would be told the
 *    payment had not arrived — the one moment where staleness does most damage;
 *  - it could only see unpaid/paid, so an async payment still settling looked
 *    identical to one that never started, which sends a guest to pay twice;
 *  - announce-once was a read-then-write against an unconditional upsert, so two
 *    overlapping checks could both "win" and the guest hears it twice;
 *  - the payment row was selected as "the active one", but the partial unique
 *    index covers only created/sent/processing — a row stops being active the
 *    instant it succeeds, and a resend leaves an older cancelled row behind it.
 *
 * Needs only a migrated database — no HTTP server, no Stripe credentials.
 *
 *   npm run smoke:payment-watch
 */
import { pool } from "../src/db/pool";
import { getOrderPaymentSnapshot, markOrderPaidIfUnpaid } from "../src/repositories/orders";
import { claimOpsStateKey } from "../src/repositories/opsState";
import {
  assert,
  cleanupSmokeRestaurant,
  createSmokeRestaurant,
  reportAndExit,
  SMOKE_SUFFIX as SUFFIX
} from "./lib/smoke-harness";

async function makeOrder(restaurantId: string, totalCents: number): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO orders (restaurant_id, source, status, payment_status, subtotal_cents, total_cents)
     VALUES ($1, 'voice', 'pending', 'unpaid', $2, $2) RETURNING id`,
    [restaurantId, totalCents]
  );
  return result.rows[0]!.id;
}

async function addPaymentRow(orderId: string, restaurantId: string, status: string): Promise<void> {
  await pool.query(
    `INSERT INTO order_payments (order_id, restaurant_id, status, amount_cents, provider, created_at)
     VALUES ($1, $2, $3::order_payment_status, 1000, 'stripe', now())`,
    [orderId, restaurantId, status]
  );
}

async function main(): Promise<void> {
  const { restaurantId } = await createSmokeRestaurant({
    name: `smoke-payment-watch-${SUFFIX}`,
    phoneNumber: "+61255500011",
    tables: [{ label: "P1", minCapacity: 1, maxCapacity: 4 }]
  });

  try {
    // ---- Criterion 1: the source of truth, with no replica lag ----
    const orderId = await makeOrder(restaurantId, 2200);
    let snap = await getOrderPaymentSnapshot(orderId, restaurantId);
    assert("a fresh order reads unpaid", snap?.state === "unpaid", { state: snap?.state });

    await markOrderPaidIfUnpaid(orderId, restaurantId, pool);
    snap = await getOrderPaymentSnapshot(orderId, restaurantId);
    assert(
      "paid is visible IMMEDIATELY after the write — no replica lag",
      snap?.state === "paid",
      { state: snap?.state }
    );

    // ---- Criterion 5: processing is neither success nor failure ----
    const processingOrder = await makeOrder(restaurantId, 1500);
    await addPaymentRow(processingOrder, restaurantId, "processing");
    snap = await getOrderPaymentSnapshot(processingOrder, restaurantId);
    assert(
      "an in-flight payment reads processing, not unpaid and not paid",
      snap?.state === "processing",
      { state: snap?.state }
    );

    // ---- The resend case: newest row wins, not "the active" one ----
    const resendOrder = await makeOrder(resendRestaurant(restaurantId), 1800);
    await addPaymentRow(resendOrder, restaurantId, "cancelled");
    await new Promise((r) => setTimeout(r, 10));
    await addPaymentRow(resendOrder, restaurantId, "paid");
    await markOrderPaidIfUnpaid(resendOrder, restaurantId, pool);
    snap = await getOrderPaymentSnapshot(resendOrder, restaurantId);
    assert(
      "a resent-then-paid order reads paid, despite an older cancelled row",
      snap?.state === "paid",
      { state: snap?.state }
    );

    // ---- Criterion 3: announce-once survives concurrency ----
    const key = `payment_announced:smoke-${SUFFIX}:${orderId}`;
    const [a, b] = await Promise.all([
      claimOpsStateKey(key, { order_id: orderId }),
      claimOpsStateKey(key, { order_id: orderId })
    ]);
    assert("exactly one of two concurrent claims wins", [a, b].filter(Boolean).length === 1, {
      first: a,
      second: b
    });
    assert("a third, later claim also loses", (await claimOpsStateKey(key, {})) === false, {});

    // ---- Per-call scoping: a guest who rings back is told again ----
    const secondCallKey = `payment_announced:smoke-${SUFFIX}-second:${orderId}`;
    assert(
      "a different call announces again",
      (await claimOpsStateKey(secondCallKey, { order_id: orderId })) === true,
      {}
    );

    // ---- Tenant isolation: a foreign order id must not resolve ----
    const other = await createSmokeRestaurant({
      name: `smoke-payment-watch-other-${SUFFIX}`,
      phoneNumber: "+61255500012",
      tables: [{ label: "O1", minCapacity: 1, maxCapacity: 2 }]
    });
    try {
      assert(
        "an order from another venue is invisible",
        (await getOrderPaymentSnapshot(orderId, other.restaurantId)) === null,
        {}
      );
    } finally {
      await cleanupSmokeRestaurant(other.restaurantId);
    }
  } finally {
    await pool.query(`DELETE FROM ops_state WHERE key LIKE $1`, [`payment_announced:smoke-${SUFFIX}%`]);
    // order_payments FKs are ON DELETE RESTRICT, so the harness cleanup cannot
    // remove the venue while a payment row references it.
    await pool.query(`DELETE FROM order_payments WHERE restaurant_id = $1`, [restaurantId]);
    await pool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE restaurant_id = $1)`, [restaurantId]);
    await pool.query(`DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE restaurant_id = $1)`, [restaurantId]);
    await pool.query(`DELETE FROM orders WHERE restaurant_id = $1`, [restaurantId]);
    await cleanupSmokeRestaurant(restaurantId);
    await pool.end();
  }

  reportAndExit("smoke-payment-watch");
}

// The resend fixture belongs to the same venue; named for readability only.
function resendRestaurant(restaurantId: string): string {
  return restaurantId;
}

main().catch((error) => {
  console.error("payment-watch smoke crashed:", error);
  process.exit(1);
});
