/**
 * Onboarding funnel smoke test — signup through to a provisionable customer.
 *
 * This exists because of a bug that reached production: nothing ticked the
 * `trial` step before Stripe Checkout, so a paying tenant was still on `menu`
 * when Stripe's confirmation arrived. The state machine refused the two-step
 * jump, the webhook 500'd, Stripe retried for three days and gave up. Card
 * charged, no phone number, never live — and no alert anywhere.
 *
 * Unit tests cover the transition rules in isolation (services/
 * onboardingService.test.ts). This walks the funnel against a REAL database
 * using the REAL repository functions, so it also proves the parts unit tests
 * can't see: that the status actually persists, and that reaching
 * `provisioning` enqueues a provisioning job exactly once.
 *
 * Creates one throwaway restaurant and deletes it in `finally` — including on
 * assertion failure, so a failed run never leaves a tenant behind.
 *
 * Usage:  npm run smoke:onboarding    (needs a migrated DB)
 */
import { pool } from "../src/db/pool";
import {
  enqueueProvisioningJob,
  type ProvisioningJob
} from "../src/repositories/provisioning";
import { getOnboardingStatus, setOnboardingStatus } from "../src/repositories/restaurants";
import {
  assertCanStartCheckout,
  computeChecklist,
  nextOnboardingStatus,
  type OnboardingEvent
} from "../src/services/onboardingService";
import { assertSafeSmokeDatabase } from "./lib/smokeTarget";

assertSafeSmokeDatabase();
let failures = 0;
function assert(label: string, ok: boolean, detail?: unknown): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${tag}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

async function throwsAsync(fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

/**
 * Drive one onboarding event the way the routes do: read the current status,
 * resolve the next one, persist it. Deliberately NOT a helper from src — the
 * point is to exercise the same three calls the real handlers make.
 */
async function fire(restaurantId: string, event: OnboardingEvent): Promise<string> {
  const current = await getOnboardingStatus(restaurantId);
  if (!current) throw new Error("restaurant vanished mid-test");
  const next = nextOnboardingStatus(current, event);
  if (next !== current) await setOnboardingStatus(restaurantId, next);
  return next;
}

async function main(): Promise<void> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO restaurants (name, timezone, onboarding_status)
     VALUES ($1, 'Australia/Sydney', 'account_created')
     RETURNING id`,
    [`__smoke_funnel_${Date.now()}`]
  );
  const restaurantId = created.rows[0]!.id;
  console.log(`\nWalking a throwaway tenant through the funnel (${restaurantId})\n`);

  try {
    // --- The wizard ---------------------------------------------------------
    assert("signup starts at account_created", (await getOnboardingStatus(restaurantId)) === "account_created");
    assert("profile step lands on profile", (await fire(restaurantId, "profile_completed")) === "profile");

    // Checkout must be refused before the agreement is signed — otherwise a
    // tenant can pay too early and the webhook can't advance them afterwards.
    assert(
      "checkout is refused mid-wizard",
      await throwsAsync(() => assertCanStartCheckout("profile"))
    );

    assert("agreement step lands on agreement", (await fire(restaurantId, "agreement_completed")) === "agreement");
    assert("menu step lands on menu", (await fire(restaurantId, "menu_completed")) === "menu");
    assert("checkout is allowed once the menu is done", !(await throwsAsync(() => assertCanStartCheckout("menu"))));

    // --- Payment ------------------------------------------------------------
    // THE REGRESSION. In production nothing ticks `trial`: /checkout-session
    // hands off to Stripe and the customer can still abandon the page. So the
    // tenant is on `menu` when the webhook lands, and this is the exact call
    // that used to throw 409 and 500 the webhook.
    const afterPayment = await fire(restaurantId, "subscription_active");
    assert("Stripe confirmation moves menu → provisioning", afterPayment === "provisioning", {
      got: afterPayment
    });
    assert("the status actually persisted", (await getOnboardingStatus(restaurantId)) === "provisioning");

    // Reaching `provisioning` is what buys the customer a phone number. If this
    // doesn't happen they have paid for nothing.
    const job = await enqueueProvisioningJob(restaurantId);
    assert("a provisioning job is enqueued", Boolean(job), { step: job?.step });
    assert("the job starts at buy_number", job?.step === "buy_number");

    // Stripe re-delivers events routinely. Both the state write and the enqueue
    // must be safe to repeat.
    const replay = await fire(restaurantId, "subscription_active");
    const replayJob: ProvisioningJob | null = await enqueueProvisioningJob(restaurantId);
    assert("replaying the payment event is a no-op", replay === "provisioning");
    assert("replaying does not enqueue a second job", replayJob?.id === job?.id, {
      first: job?.id,
      second: replayJob?.id
    });

    // --- Go live ------------------------------------------------------------
    assert("provisioned → live", (await fire(restaurantId, "provisioned")) === "live");
    const liveChecklist = computeChecklist("live");
    assert("a live tenant has every step done", liveChecklist.every((s) => s.status === "done"));

    // --- Lapsed payment -----------------------------------------------------
    // A declined card must not drop the customer back into the setup wizard.
    assert("a live tenant lapses to suspended", (await fire(restaurantId, "subscription_lapsed")) === "suspended");
    const suspendedChecklist = computeChecklist("suspended");
    assert(
      "a suspended tenant is NOT shown as a fresh signup",
      suspendedChecklist.every((s) => s.status === "done") &&
        suspendedChecklist.every((s) => s.status !== "current")
    );
    assert(
      "a replayed wizard step from suspended is a no-op, not a 409",
      (await fire(restaurantId, "profile_completed")) === "suspended"
    );
    assert("paying again restores the tenant to live", (await fire(restaurantId, "subscription_active")) === "live");
  } finally {
    // Cascades to provisioning_jobs / onboarding_events.
    await pool.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]);
    console.log(`\nCleaned up ${restaurantId}`);
  }

  console.log(failures === 0 ? "\nAll funnel checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("smoke-onboarding-funnel crashed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
