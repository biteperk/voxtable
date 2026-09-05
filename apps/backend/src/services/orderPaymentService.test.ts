/**
 * DB-free units for the voice-order payment link flow: the fee maths (with
 * its Stripe-imposed cap), the line-item mapping that guarantees the session
 * total equals the order total, the SMS copy rules, and the payment-status
 * transition table's terminal states. Everything that touches Postgres or
 * Stripe lives in scripts/smoke-payments.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLineItems,
  buildPaymentSms,
  buildReceiptSms,
  checkoutIdempotencyKey,
  platformFeeCents
} from "./orderPaymentService";
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
  // Alphanumeric sender IDs are one-way; nothing may invite a response. The
  // `BitePerk` sender ID is ACMA-approved as of 18 Aug 2026, so this is now a
  // live constraint rather than an anticipated one. Strip the one sanctioned
  // mention of "reply" first, then assert nothing else asks for one — the
  // earlier /reply (yes|now|to confirm)/ form would have waved through
  // "reply STOP to opt out" or "text us back".
  const withoutDisclaimer = sms.replace("Do not reply to this message.", "");
  assert.ok(!/\b(reply|respond|text (us|back)|sms us)\b/i.test(withoutDisclaimer));
  // STOP can never be processed on a one-way sender, so offering it is a lie.
  assert.ok(!/\bSTOP\b/.test(sms));
  // Pure GSM-7: a single em-dash or curly quote re-encodes the whole message
  // as UCS-2 and halves segments from 160 to 70 chars — this SMS shipped as
  // 2-3 segments for weeks before anyone noticed.
  const GSM7 =
    /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑܧ¿äöñüà\n\r^{}\\[\]~|€]*$/;
  assert.ok(GSM7.test(sms), `non-GSM-7 character in: ${sms}`);
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

// ---------------------------------------------------------------------------
// Checkout idempotency key. The bug: the key omitted the attempt sequence, and
// total_cents is never updated anywhere, so it was constant per order forever
// — while Stripe caches keys for 24h and links expire after 45 minutes. Every
// resend replayed the original, dead session.
// ---------------------------------------------------------------------------

test("a concurrent double-fire shares a key, so Stripe replays one session", () => {
  // Both racers read attemptSeq before either writes its row.
  const a = checkoutIdempotencyKey("order-1", 4200, 0);
  const b = checkoutIdempotencyKey("order-1", 4200, 0);
  assert.equal(a, b);
});

test("a resend after the previous attempt died mints a different key", () => {
  const first = checkoutIdempotencyKey("order-1", 4200, 0);
  const resend = checkoutIdempotencyKey("order-1", 4200, 1);
  assert.notEqual(first, resend, "a resend that reuses the key replays a dead session URL");
});

test("the key still changes when the amount changes", () => {
  assert.notEqual(
    checkoutIdempotencyKey("order-1", 4200, 0),
    checkoutIdempotencyKey("order-1", 5000, 0)
  );
});

test("different orders never collide", () => {
  assert.notEqual(
    checkoutIdempotencyKey("order-1", 4200, 0),
    checkoutIdempotencyKey("order-2", 4200, 0)
  );
});

// --- buildReceiptSms ---------------------------------------------------------

const GSM7 = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;

test("receipt SMS: venue, order, amount, the Stripe receipt link, and no invitation to reply", () => {
  const sms = buildReceiptSms({
    venueName: "Mazcina Resto-Bar",
    orderNumber: 3,
    totalCents: 10250,
    receiptUrl: "https://pay.stripe.com/receipts/payment/CAcaFwoVYWNjdF8xVHlyemlMeFRMbzdtNDFWKKfJ7cUGMgZyZWNlaXB0NpA_abcdefghijklmnopqrstuvwxyz0123456789"
  });
  assert.ok(sms.startsWith("Mazcina Resto-Bar: order #3 paid, $102.50."));
  const link = sms.match(/https:\/\/\S+/)?.[0] ?? "";
  assert.equal(new URL(link).origin, "https://pay.stripe.com");
  assert.ok(sms.endsWith("Do not reply to this message."));
  assert.ok(!/reply (to us|back)|text us|call us/i.test(sms.replace("Do not reply to this message.", "")));
  assert.ok(GSM7.test(sms), "GSM-7 only: one stray character halves every segment");
  assert.ok(sms.length <= 306, `two GSM segments at most, got ${sms.length}`);
});

test("receipt SMS without a receipt link still confirms the payment once", () => {
  const sms = buildReceiptSms({ venueName: "Cuban Corner", orderNumber: null, totalCents: 1850, receiptUrl: null });
  assert.equal(sms, "Cuban Corner: order #? paid, $18.50. Thank you.\nDo not reply to this message.");
  assert.ok(GSM7.test(sms));
  assert.ok(sms.length <= 160, "unlinked form fits one segment");
});
