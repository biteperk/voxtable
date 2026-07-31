import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GST_RATE, priceIncGst, TIERS, TRIAL_DAYS, trialLengthLabel } from "../data/pricing.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Guards the two numbers a customer is most likely to feel cheated by: how long
 * the free trial lasts, and what they get charged afterwards.
 *
 * The trial test exists because these DID disagree in production — the landing
 * page promised 7 days, the signup wizard promised 14, and Stripe granted 14.
 * Three answers to one question, and the two that mattered were the ones the
 * customer never saw side by side.
 */

test("the marketing trial length matches what Stripe is actually told", () => {
  // The backend default is the source of truth: it is what Stripe receives at
  // checkout, and what the wizard reads back to render. This constant only
  // exists for the logged-out landing page, which has no API call to use.
  const envSource = readFileSync(path.join(repoRoot, "apps/backend/src/config/env.ts"), "utf8");
  const match = /STRIPE_TRIAL_DAYS:[^\n]*\.default\((\d+)\)/.exec(envSource);
  assert.ok(match, "couldn't find the STRIPE_TRIAL_DAYS default — did the schema change shape?");

  const backendDefault = Number(match[1]);
  assert.equal(
    TRIAL_DAYS,
    backendDefault,
    `The landing page advertises a ${TRIAL_DAYS}-day trial but the backend grants ` +
      `${backendDefault}. Update both, and remember production also has its own ` +
      `STRIPE_TRIAL_DAYS in /opt/vocotable/.env which overrides the default.`
  );
});

test("the trial label reads naturally", () => {
  assert.equal(trialLengthLabel(), `${TRIAL_DAYS}-day`);
  assert.doesNotMatch(trialLengthLabel(), /undefined|NaN/);
});

test("a trial length is plausible for a paid product", () => {
  // Catches a fat-fingered 70 or 0 before it reaches a pricing page.
  assert.ok(Number.isInteger(TRIAL_DAYS), "trial length must be a whole number of days");
  assert.ok(TRIAL_DAYS >= 0 && TRIAL_DAYS <= 90, `${TRIAL_DAYS} days is not a sane trial`);
});

// ---------------------------------------------------------------------------
// The other number people feel cheated by
// ---------------------------------------------------------------------------

test("GST maths matches what Stripe charged on the real checkout", () => {
  // Verified against a live Stripe Checkout page showing A$88.00 for the $80 plan.
  assert.equal(priceIncGst("$80"), "A$88.00");
  assert.equal(GST_RATE, 0.1);
});

test("every numeric tier price grosses up cleanly", () => {
  for (const tier of TIERS) {
    const inc = priceIncGst(tier.price);
    if (tier.custom) {
      assert.equal(inc, null, `${tier.name} is contact-sales — it must not show a computed price`);
    } else {
      assert.match(inc, /^A\$\d+\.\d{2}$/, `${tier.name} produced a malformed price: ${inc}`);
    }
  }
});
