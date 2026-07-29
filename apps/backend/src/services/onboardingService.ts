import { AppError } from "../domain/errors";
import type { OnboardingStatus } from "../repositories/restaurants";

/**
 * The onboarding state machine — the single source of truth for which wizard
 * step is current and whether the dashboard is unlocked. The linear happy path
 * is account_created → profile → menu → trial → provisioning → live; suspended
 * and cancelled are side states.
 */

const STATUS_ORDER: OnboardingStatus[] = [
  "account_created",
  "profile",
  "agreement",
  "menu",
  "trial",
  "provisioning",
  "live"
];

// Rank along the linear path; side states (suspended/cancelled) → -1.
function rank(status: OnboardingStatus): number {
  return STATUS_ORDER.indexOf(status);
}

export type OnboardingEvent =
  | "profile_completed"
  | "agreement_completed"
  | "menu_completed"
  | "trial_started"
  | "subscription_active"
  | "subscription_lapsed"
  | "provisioned"
  | "cancelled";

const EVENT_TARGET: Record<OnboardingEvent, OnboardingStatus> = {
  profile_completed: "profile",
  // agreement_completed is deliberately NOT accepted by the generic
  // /api/onboarding/advance endpoint (it's absent from onboardingAdvanceSchema)
  // — only POST /api/onboarding/agreement fires it, because the transition must
  // be accompanied by the consent + acceptance-ledger write in the same txn.
  agreement_completed: "agreement",
  menu_completed: "menu",
  trial_started: "trial",
  subscription_active: "provisioning",
  subscription_lapsed: "suspended",
  provisioned: "live",
  cancelled: "cancelled"
};

/**
 * Resolve the next status for a (current, event). Forward-only and idempotent
 * along the linear path (re-firing a completed step is a no-op, not an error);
 * suspend/cancel/reactivate are handled specially. Throws 409 on an illegal
 * jump (e.g. completing the menu before the profile, or skipping the trial).
 */
export function nextOnboardingStatus(
  current: OnboardingStatus,
  event: OnboardingEvent
): OnboardingStatus {
  if (event === "cancelled") return "cancelled";

  if (event === "subscription_lapsed") {
    // Only a live restaurant can lapse into suspended; otherwise no-op.
    return current === "live" ? "suspended" : current;
  }

  if (event === "subscription_active" && current === "suspended") {
    // Reactivation after a lapsed/failed payment recovered.
    return "live";
  }

  const target = EVENT_TARGET[event];
  const cur = rank(current);
  const tgt = rank(target);

  if (cur < 0) {
    throw new AppError(
      409,
      "ONBOARDING_INVALID_TRANSITION",
      `Cannot ${event} from ${current}.`
    );
  }
  if (tgt <= cur) return current; // idempotent no-op
  if (tgt > cur + 1) {
    throw new AppError(
      409,
      "ONBOARDING_INVALID_TRANSITION",
      `Cannot ${event} from ${current} — earlier steps are incomplete.`
    );
  }
  return target;
}

export function isOnboardingComplete(status: OnboardingStatus): boolean {
  return status === "live";
}

export interface ChecklistStep {
  key: string;
  label: string;
  href: string;
  status: "done" | "current" | "todo";
}

// Wizard steps, each marked done once the restaurant reaches `doneRank`.
const WIZARD_STEPS: Array<{ key: string; label: string; href: string; doneRank: number }> = [
  { key: "profile", label: "Restaurant profile", href: "/onboarding/profile", doneRank: rank("profile") },
  { key: "agreement", label: "Service & data setup", href: "/onboarding/agreement", doneRank: rank("agreement") },
  { key: "menu", label: "Add your menu", href: "/onboarding/menu", doneRank: rank("menu") },
  { key: "trial", label: "Start free trial", href: "/onboarding/trial", doneRank: rank("trial") },
  { key: "phone", label: "Connect your phone", href: "/onboarding/phone", doneRank: rank("live") }
];

/**
 * Build the wizard checklist for a status: completed steps are `done`, the first
 * incomplete step is `current`, the rest are `todo`. A `live` restaurant has all
 * steps done and no current step.
 */
export function computeChecklist(status: OnboardingStatus): ChecklistStep[] {
  const r = rank(status);
  let currentAssigned = false;
  return WIZARD_STEPS.map((step) => {
    if (r >= step.doneRank) {
      return { key: step.key, label: step.label, href: step.href, status: "done" as const };
    }
    if (!currentAssigned) {
      currentAssigned = true;
      return { key: step.key, label: step.label, href: step.href, status: "current" as const };
    }
    return { key: step.key, label: step.label, href: step.href, status: "todo" as const };
  });
}

/**
 * Guard for the (future) go-live transition: a restaurant may only go live from
 * provisioning. Telephony provisioning (Phase 4) adds the forwarding-verified
 * check on top of this.
 */
export function assertCanGoLive(status: OnboardingStatus): void {
  if (status !== "provisioning" && status !== "live") {
    throw new AppError(
      409,
      "ONBOARDING_NOT_READY",
      "The restaurant can't go live until billing and provisioning are complete."
    );
  }
}
