import assert from "node:assert/strict";
import test from "node:test";

import { isAppError } from "../domain/errors";
import type { OnboardingStatus } from "../repositories/restaurants";
import {
  assertCanStartCheckout,
  computeChecklist,
  nextOnboardingStatus,
  type OnboardingEvent
} from "./onboardingService";

/**
 * The step-ordering rules, tested exhaustively. DB-free and pure, so this runs
 * in `npm run check` in under a second.
 *
 * These exist because a paying customer silently got stuck for want of a check
 * like the first one below: nothing ticked the `trial` step in production, so
 * Stripe's "they paid" webhook tried to move a tenant from `menu` to
 * `provisioning`, the no-skipping rule rejected it, the webhook 500'd, and
 * Stripe gave up after three days. Card charged, no phone number, never live.
 */

const ALL_STATUSES: OnboardingStatus[] = [
  "account_created",
  "profile",
  "agreement",
  "menu",
  "trial",
  "provisioning",
  "live",
  "suspended",
  "cancelled"
];

// ---------------------------------------------------------------------------
// The bug that shipped
// ---------------------------------------------------------------------------

test("Stripe confirming payment moves a tenant off the menu step", () => {
  // THE REGRESSION TEST. In production nothing ticks `trial` before checkout
  // (the customer can still abandon the Stripe page), so a paying tenant is
  // still on `menu` when the webhook lands.
  assert.equal(nextOnboardingStatus("menu", "subscription_active"), "provisioning");
});

test("Stripe confirming payment also works from the trial step", () => {
  // The dev path (and any tenant who did get ticked) must keep working.
  assert.equal(nextOnboardingStatus("trial", "subscription_active"), "provisioning");
});

test("paying does not let a tenant skip the agreement", () => {
  // The skip guard still has to bite before the agreement is signed.
  for (const status of ["account_created", "profile", "agreement"] as OnboardingStatus[]) {
    assert.throws(
      () => nextOnboardingStatus(status, "subscription_active"),
      /ONBOARDING_INVALID_TRANSITION|Cannot/,
      `expected subscription_active to be rejected from ${status}`
    );
  }
});

// ---------------------------------------------------------------------------
// The happy path, end to end
// ---------------------------------------------------------------------------

test("a customer can walk the whole flow from signup to live", () => {
  let status: OnboardingStatus = "account_created";
  const walk: Array<[OnboardingEvent, OnboardingStatus]> = [
    ["profile_completed", "profile"],
    ["agreement_completed", "agreement"],
    ["menu_completed", "menu"],
    ["subscription_active", "provisioning"],
    ["provisioned", "live"]
  ];
  for (const [event, expected] of walk) {
    status = nextOnboardingStatus(status, event);
    assert.equal(status, expected, `${event} should land on ${expected}`);
  }
  assert.equal(status, "live");
});

// ---------------------------------------------------------------------------
// Lapsed payments
// ---------------------------------------------------------------------------

test("only a live tenant lapses into suspended", () => {
  assert.equal(nextOnboardingStatus("live", "subscription_lapsed"), "suspended");
  // A tenant mid-wizard whose card fails shouldn't be yanked sideways.
  for (const status of ["menu", "trial", "provisioning"] as OnboardingStatus[]) {
    assert.equal(nextOnboardingStatus(status, "subscription_lapsed"), status);
  }
});

test("a suspended tenant is reactivated by a successful payment", () => {
  assert.equal(nextOnboardingStatus("suspended", "subscription_active"), "live");
});

test("a suspended tenant is never 409'd by a replayed wizard step", () => {
  // Their real problem is their card. A stale tab replaying a step must be a
  // no-op, not an error page — this used to be a hard lockout.
  for (const event of [
    "profile_completed",
    "agreement_completed",
    "menu_completed",
    "trial_started",
    "provisioned"
  ] as OnboardingEvent[]) {
    assert.equal(
      nextOnboardingStatus("suspended", event),
      "suspended",
      `${event} from suspended should be a no-op`
    );
  }
});

// ---------------------------------------------------------------------------
// Cancelled (abandoned-onboarding sweeper)
// ---------------------------------------------------------------------------

test("a cancelled tenant restarts by completing the profile again", () => {
  assert.equal(nextOnboardingStatus("cancelled", "profile_completed"), "profile");
});

test("a cancelled tenant cannot resume midway", () => {
  for (const event of ["menu_completed", "provisioned"] as OnboardingEvent[]) {
    assert.throws(() => nextOnboardingStatus("cancelled", event), /Cannot/);
  }
});

// ---------------------------------------------------------------------------
// General rules
// ---------------------------------------------------------------------------

test("re-firing a completed step is a no-op, never an error", () => {
  // Retries and double-clicks are normal; they must not error.
  assert.equal(nextOnboardingStatus("menu", "profile_completed"), "menu");
  assert.equal(nextOnboardingStatus("live", "menu_completed"), "live");
  assert.equal(nextOnboardingStatus("provisioning", "agreement_completed"), "provisioning");
});

test("steps cannot be skipped", () => {
  assert.throws(() => nextOnboardingStatus("account_created", "menu_completed"), /Cannot/);
  assert.throws(() => nextOnboardingStatus("profile", "trial_started"), /Cannot/);
});

test("cancelling always works, from anywhere", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(nextOnboardingStatus(status, "cancelled"), "cancelled");
  }
});

test("no status and event combination throws anything but a 409", () => {
  // Whatever we do, a client must never see a 500 from the state machine.
  const events: OnboardingEvent[] = [
    "profile_completed",
    "agreement_completed",
    "menu_completed",
    "trial_started",
    "subscription_active",
    "subscription_lapsed",
    "provisioned",
    "cancelled"
  ];
  for (const status of ALL_STATUSES) {
    for (const event of events) {
      try {
        nextOnboardingStatus(status, event);
      } catch (error) {
        assert.ok(isAppError(error), `${status} + ${event} threw a non-AppError`);
        assert.equal(error.statusCode, 409, `${status} + ${event} threw a non-409`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The wizard checklist
// ---------------------------------------------------------------------------

test("a live tenant has every step done and no current step", () => {
  const checklist = computeChecklist("live");
  assert.ok(checklist.every((step) => step.status === "done"));
  assert.equal(checklist.find((step) => step.status === "current"), undefined);
});

test("a suspended tenant is not shown as a brand-new signup", () => {
  // Ranking suspended as -1 used to mark every step todo, dropping a paying
  // customer whose card bounced into the first-run wizard with no way out.
  const checklist = computeChecklist("suspended");
  assert.ok(
    checklist.every((step) => step.status === "done"),
    "a suspended tenant already finished the wizard"
  );
  assert.equal(checklist.find((step) => step.status === "current"), undefined);
});

test("a fresh signup is pointed at the profile step", () => {
  const checklist = computeChecklist("account_created");
  assert.equal(checklist.find((step) => step.status === "current")?.key, "profile");
});

test("exactly one step is current mid-wizard", () => {
  for (const status of ["account_created", "profile", "agreement", "menu", "trial"] as OnboardingStatus[]) {
    const current = computeChecklist(status).filter((step) => step.status === "current");
    assert.equal(current.length, 1, `${status} should have exactly one current step`);
  }
});

// ---------------------------------------------------------------------------
// Checkout guard
// ---------------------------------------------------------------------------

test("checkout is refused until the earlier steps are done", () => {
  for (const status of ["account_created", "profile", "agreement"] as OnboardingStatus[]) {
    assert.throws(
      () => assertCanStartCheckout(status),
      /ONBOARDING_NOT_READY|finish the earlier setup steps/,
      `checkout should be refused at ${status}`
    );
  }
});

test("checkout is allowed once the menu is done, and stays allowed after paying", () => {
  for (const status of ["menu", "trial", "provisioning", "live", "suspended"] as OnboardingStatus[]) {
    assert.doesNotThrow(() => assertCanStartCheckout(status), `checkout should be allowed at ${status}`);
  }
});
