/**
 * DB-free units for the voice-order payment link flow: the fee maths (with
 * its Stripe-imposed cap), the line-item mapping that guarantees the session
 * total equals the order total, the SMS copy rules, and the payment-status
 * transition table's terminal states. Everything that touches Postgres or
 * Stripe lives in scripts/smoke-payments.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLineItems, buildPaymentSms, platformFeeCents } from "./orderPaymentService";
import { isValidPaymentTransition } from "../repositories/orderPayments";

// --- platformFeeCents -------------------------------------------------------

test("fee = bps + flat, rounded", () => {
  // 250 bps (2.5%) + 30c on $28.50 → 71c + 30c = 101c
  assert.equal(platformFeeCents(2850, 250, 30), 101);
});

test("fee is capped BELOW the total — Stripe rejects fee > amount, fee == amount pays the venue $0", () => {
  // $0.50 order with a 30c flat + 10% fee would be 35c — fine. A $0.31 order
  // with a 30c flat + huge bps must clamp to 30c (total-1).
  assert.equal(platformFeeCents(31, 10_000, 30), 30);
  // Degenerate: fee formula exceeds the total outright.
  assert.equal(platformFeeCents(100, 20_000, 500), 99);
});

test("fee never goes negative", () => {
  assert.equal(platformFeeCents(100, 0, 0), 0);
});

// --- buildLineItems ---------------------------------------------------------

const order = {
  order_number: 14,
  total_cents: 3350,
  items: [
    {
      quantity: 2,
      name_snapshot: "Fish and Chips",
      line_total_cents: 2700 // includes a $1.50 variant delta and $0.50 modifier
    },
    {
      quantity: 1,
      name_snapshot: "Garden Salad",
      line_total_cents: 650
    }
  ]
} as never as Parameters<typeof buildLineItems>[0];

test("per-item lines carry quantity in the name and sum exactly to the order total", () => {
  const lines = buildLineItems(order);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.price_data.product_data.name, "2 × Fish and Chips");
  assert.ok(lines.every((l) => l.quantity === 1));
  assert.ok(lines.every((l) => l.price_data.currency === "aud"));
  const sum = lines.reduce((acc, l) => acc + l.price_data.unit_amount, 0);
  assert.equal(sum, order.total_cents);
});

test("falls back to a single order-level line when item sums disagree with the total", () => {
  const skewed = { ...order, total_cents: 9999 } as never as Parameters<typeof buildLineItems>[0];
  const lines = buildLineItems(skewed);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.price_data.unit_amount, 9999);
  assert.equal(lines[0]!.price_data.product_data.name, "Order #14");
});

// --- buildPaymentSms --------------------------------------------------------

test("SMS copy: venue first, total, url, expiry, and no invitation to reply", () => {
  const sms = buildPaymentSms({
    venueName: "Natalia's Bistro",
    orderNumber: 14,
    totalCents: 2850,
    url: "https://checkout.stripe.com/c/pay/cs_test_abc",
    expiryMinutes: 45
  });
  assert.ok(sms.startsWith("Natalia's Bistro"));
  assert.ok(sms.includes("$28.50"));
  const link = sms.match(/https:\/\/\S+/)?.[0] ?? "";
  assert.equal(new URL(link).origin, "https://checkout.stripe.com");
  assert.equal(new URL(link).pathname, "/c/pay/cs_test_abc");
  assert.ok(sms.includes("45 minutes"));
  assert.ok(sms.includes("Do not reply"));
  // Alphanumeric sender IDs are one-way; nothing may invite a response.
  assert.ok(!/reply (yes|now|to confirm)/i.test(sms));
});

// --- transition table -------------------------------------------------------

test("terminal payment statuses never move (monotonic against webhook replays)", () => {
  for (const terminal of ["expired", "failed", "cancelled", "refunded", "disputed"] as const) {
    for (const target of [
      "created",
      "sent",
      "processing",
      "paid",
      "expired",
      "failed",
      "cancelled",
      "refunded",
      "disputed"
    ] as const) {
      assert.equal(
        isValidPaymentTransition(terminal, target),
        false,
        `${terminal} -> ${target} must be illegal`
      );
    }
  }
});

test("paid can only move to refunded or disputed", () => {
  assert.equal(isValidPaymentTransition("paid", "refunded"), true);
  assert.equal(isValidPaymentTransition("paid", "disputed"), true);
  assert.equal(isValidPaymentTransition("paid", "unpaid" as never), false);
  assert.equal(isValidPaymentTransition("paid", "sent"), false);
});

test("active statuses can expire, fail, cancel, or pay", () => {
  for (const from of ["created", "sent", "processing"] as const) {
    assert.equal(isValidPaymentTransition(from, "paid"), true);
    assert.equal(isValidPaymentTransition(from, "expired"), true);
    assert.equal(isValidPaymentTransition(from, "cancelled"), true);
  }
});
