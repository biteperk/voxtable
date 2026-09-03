/**
 * GST wiring on the Checkout Session (audit B10).
 *
 * The pricing page promises "A$88.00 inc GST" next to the card form, so the
 * session must ask Stripe to compute tax. The three fields have to travel
 * together: our customers are created with no address, and Stripe rejects an
 * automatic_tax session for an address-less existing customer unless the
 * session collects the billing address and may save it back to the customer.
 * A regression on any one of the three either recreates the untaxed-checkout
 * defect or makes every checkout fail at session creation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildCheckoutSessionParams } from "./stripeService";

const params = buildCheckoutSessionParams({
  customerId: "cus_test123",
  restaurantId: "11111111-1111-4111-8111-111111111111",
  priceId: "price_test123",
  trialDays: 7,
  successUrl: "https://example.com/ok",
  cancelUrl: "https://example.com/cancel"
});

test("automatic tax is enabled so GST is computed on every checkout", () => {
  assert.deepEqual(params.automatic_tax, { enabled: true });
});

test("the billing address is collected — automatic_tax cannot work without one", () => {
  assert.equal(params.billing_address_collection, "required");
});

test("the collected address may be saved to the customer — required for automatic_tax with an existing customer", () => {
  assert.deepEqual(params.customer_update, { address: "auto" });
});

test("promotion codes can be entered on the Checkout page", () => {
  // Codes live in the Stripe dashboard; the session only permits entering one.
  // Must never be combined with a hard-coded `discounts` list — Stripe rejects
  // sessions that set both.
  assert.equal(params.allow_promotion_codes, true);
  assert.equal("discounts" in params, false);
});

test("the subscription shape is unchanged by the GST wiring", () => {
  assert.equal(params.mode, "subscription");
  assert.equal(params.customer, "cus_test123");
  assert.equal(params.client_reference_id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(params.line_items, [{ price: "price_test123", quantity: 1 }]);
  assert.equal(params.payment_method_collection, "always");
  assert.equal(params.subscription_data?.trial_period_days, 7);
  assert.equal(params.subscription_data?.metadata?.restaurant_id, "11111111-1111-4111-8111-111111111111");
});
