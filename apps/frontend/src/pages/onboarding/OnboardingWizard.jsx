import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth";
import { signOutUser } from "../../firebase";
import { getOnboardingStatus } from "../../api";
import { Icon } from "../../components/Icon";
import { CreateRestaurantStep } from "./steps/CreateRestaurantStep";
import { ProfileStep } from "./steps/ProfileStep";
import { AgreementStep } from "./steps/AgreementStep";
import { MenuStep } from "./steps/MenuStep";
import { TrialStep } from "./steps/TrialStep";
import { PhoneStep } from "./steps/PhoneStep";

// ===== Onboarding wizard (Phase 1) =====

function OnboardingShell({
  checklist,
  children,
  onSignOut,
  welcome = false,
  currentKey = null,
  reviewing = false,
  onReturnToCurrent = null
}) {
  const total = checklist?.length ?? 0;
  // `currentKey` is the step being *viewed* (may be an earlier, completed step
  // in review mode) — the header tracks it, while the segments keep the
  // server-reported statuses so overall progress never appears to regress.
  const currentIndex = checklist
    ? currentKey
      ? checklist.findIndex((s) => s.key === currentKey)
      : checklist.findIndex((s) => s.status === "current")
    : -1;
  const current = currentIndex >= 0 ? checklist[currentIndex] : null;
  const doneCount = checklist ? checklist.filter((s) => s.status === "done").length : 0;
  const allDone = total > 0 && doneCount === total;
  const ONBOARDING_CONTEXT = {
    profile: "Used by Bella on every call — change it anytime",
    agreement: "Your agreement & data choices — takes about two minutes",
    menu: "Lets Bella answer “how much is…” questions",
    trial: "Card not charged for 14 days · cancel anytime",
    phone: "Works with Telstra, Optus & Vodafone"
  };
  const contextLine = ONBOARDING_CONTEXT[currentKey] ?? null;
  return (
    <div className={`onboarding-shell${welcome ? " is-welcome" : ""}`}>
      <div className="onboarding-glow onboarding-glow-1" aria-hidden="true" />
      <div className="onboarding-glow onboarding-glow-2" aria-hidden="true" />
      <header className="onboarding-top">
        <div className="onboarding-brand">
          <img src="/brand/mark-light-on-dark.svg" alt="" width="30" height="30" />
          <strong>VoxTable</strong>
        </div>
        <button type="button" className="onboarding-signout" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <div className="onboarding-body">
        {total > 0 && (
          <div className="onboarding-progress">
            <p className="onboarding-progress-caption" aria-live="polite">
              {current ? (
                <>
                  <span className="step-count">Step {currentIndex + 1} of {total}</span>
                  {" · "}
                  <span className="step-label">{current.label}</span>
                </>
              ) : (
                <span className="step-label">Setup complete</span>
              )}
            </p>
            <div
              className="onboarding-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={doneCount}
              aria-label="Setup progress"
            >
              {checklist.map((s) => (
                <span
                  key={s.key}
                  className={`onboarding-progress-seg is-${s.status}${reviewing && s.key === currentKey ? " is-viewing" : ""}`}
                  aria-label={`${s.label} — ${s.status === "done" ? "completed" : s.status === "current" ? "in progress" : "not started"}`}
                />
              ))}
              {allDone && (
                <span className="onboarding-progress-cap" aria-hidden="true">
                  <Icon name="check" />
                </span>
              )}
            </div>
            {contextLine && (
              <p className="onboarding-progress-context">
                <Icon name="check" />
                {contextLine}
              </p>
            )}
            {reviewing && (
              <div className="onboarding-review-banner" role="status">
                <Icon name="history" />
                <span>You're revisiting a completed step — your answers are saved.</span>
                <button type="button" className="onboarding-review-return" onClick={onReturnToCurrent}>
                  Return to current step <Icon name="arrow_forward" />
                </button>
              </div>
            )}
          </div>
        )}
        <main className="onboarding-main" key={current?.key ?? (welcome ? "welcome" : "done")}>
          {children}
        </main>
      </div>
    </div>
  );
}

function ComingSoonStep({ title, body }) {
  return (
    <div className="onboarding-card">
      <h1>{title}</h1>
      <p className="onboarding-lead">{body}</p>
      <p className="onboarding-note">
        <Icon name="info" /> Your progress is saved — you can pick up here when this step ships.
      </p>
    </div>
  );
}

// Steps a client may navigate back to once completed. Trial/Phone hold no
// reviewable answers, and the pre-checklist CreateRestaurant screen has
// nothing before it (the name is editable again on the Profile step).
const REVIEWABLE_KEYS = ["profile", "agreement", "menu"];

export function OnboardingWizard({ navigate }) {
  const { memberships, refreshMe } = useAuth();
  const [status, setStatus] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // When set, the wizard shows this completed step instead of the server's
  // `current` one (review mode). Purely client-side: the server checklist
  // alone decides the real current step, so this can never skip forward.
  const [reviewKey, setReviewKey] = useState(null);
  const lastServerCurrent = useRef(null);

  const hasRestaurant = (memberships?.length ?? 0) > 0;

  // `silent` refreshes the status/checklist without flipping the whole wizard
  // into the "Loading…" card — used by polling steps (Trial, Phone) so the
  // current card doesn't remount (and replay its entrance animation) on every
  // background tick.
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!hasRestaurant) {
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const r = await getOnboardingStatus();
      setStatus(r.onboarding_status);
      setChecklist(r.checklist);
      // If the real current step moved underneath a review (e.g. the Stripe
      // webhook advanced the tenant), drop review mode so the client isn't
      // left editing a stale card.
      const serverCurrentNow = r.checklist?.find((s) => s.status === "current")?.key ?? null;
      if (serverCurrentNow !== lastServerCurrent.current) {
        lastServerCurrent.current = serverCurrentNow;
        setReviewKey(null);
      }
      window.dispatchEvent(
        new CustomEvent("vocotable:onboarding-status-changed", {
          detail: { status: r.onboarding_status }
        })
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [hasRestaurant]);

  useEffect(() => {
    load();
  }, [load]);

  const silentRefresh = useCallback(() => load({ silent: true }), [load]);

  const handleSignOut = async () => {
    try {
      await signOutUser();
    } catch {
      // Sign-out very rarely fails (network blip mid-revoke); leaving the user
      // signed in with no feedback is worse than landing them on the public
      // page, where the auth listener settles the real state.
    }
    navigate("/");
  };

  if (loading) {
    return (
      <OnboardingShell onSignOut={handleSignOut}>
        <div className="onboarding-card">
          <p style={{ color: "var(--on-surface-variant)" }}>Loading…</p>
        </div>
      </OnboardingShell>
    );
  }

  if (!hasRestaurant) {
    return (
      <OnboardingShell onSignOut={handleSignOut} welcome>
        <CreateRestaurantStep onCreated={refreshMe} />
      </OnboardingShell>
    );
  }

  if (error) {
    return (
      <OnboardingShell onSignOut={handleSignOut}>
        <div className="onboarding-card">
          <p className="onboarding-error">Couldn't load your setup: {error}</p>
          <div className="onboarding-actions">
            <button type="button" className="primary-button" onClick={load}>
              Try again
            </button>
          </div>
        </div>
      </OnboardingShell>
    );
  }

  const serverCurrent = checklist?.find((s) => s.status === "current")?.key ?? null;

  // A step is only revisitable when the server says it's already done —
  // review mode can therefore never render a "todo" step (no skipping ahead).
  const isReviewable = (key) =>
    REVIEWABLE_KEYS.includes(key) &&
    checklist?.find((s) => s.key === key)?.status === "done";

  const reviewing = reviewKey != null && isReviewable(reviewKey);
  const current = reviewing ? reviewKey : serverCurrent;

  // The Back target is the completed step immediately before the one on
  // screen (checklist order), when there is one worth revisiting.
  const viewedIndex = checklist?.findIndex((s) => s.key === current) ?? -1;
  const backTarget =
    viewedIndex > 0 && isReviewable(checklist[viewedIndex - 1].key)
      ? checklist[viewedIndex - 1]
      : null;

  // Saving any step (normally or from review mode) returns the client to the
  // real current step with a fresh checklist.
  const advance = () => {
    setReviewKey(null);
    return load();
  };
  const returnToCurrent = () => setReviewKey(null);
  // Rendered inside each step card's action row, next to the primary button.
  const goBack = backTarget ? () => setReviewKey(backTarget.key) : null;

  let content;
  if (reviewing && current === "menu") {
    // MenuStep is an upload/OCR flow with no prefill — revisiting it should
    // point at the saved menu, not restart the upload wizard.
    content = (
      <div className="onboarding-card">
        <h1>Your menu is saved</h1>
        <p className="onboarding-lead">
          Bella already uses it to answer price questions. To review or edit
          items, open Manage menu — your place in setup is kept.
        </p>
        <div className="onboarding-actions">
          <button type="button" className="ghost-button" onClick={() => navigate("/manage-menu")}>
            Open Manage menu <Icon name="arrow_forward" />
          </button>
          <button type="button" className="primary-button" onClick={returnToCurrent}>
            Back to my current step
          </button>
        </div>
      </div>
    );
  } else if (current === "profile") {
    content = <ProfileStep onSaved={advance} />;
  } else if (current === "agreement") {
    content = <AgreementStep onSaved={advance} onBack={goBack} />;
  } else if (current === "menu") {
    content = <MenuStep onContinue={advance} navigate={navigate} onBack={goBack} />;
  } else if (current === "trial") {
    content = <TrialStep onRefresh={silentRefresh} onBack={goBack} />;
  } else if (current === "phone") {
    content = <PhoneStep onRefresh={silentRefresh} />;
  } else if (current) {
    // The server checklist has a current step this build doesn't know yet —
    // don't show the completion card for an unfinished setup.
    content = (
      <ComingSoonStep
        title={checklist.find((s) => s.key === current)?.label ?? "Almost there"}
        body="This step isn't available in the app yet."
      />
    );
  } else {
    content = (
      <div className="onboarding-card">
        <div className="onboarding-done-check" aria-hidden="true"><Icon name="check" /></div>
        <h1>You're all set</h1>
        <p className="onboarding-lead">Bella is answering your calls now. Watch them land live in your dashboard.</p>
        <div className="onboarding-actions">
          <button type="button" className="primary-button" onClick={() => navigate("/live-feed")}>
            Go to dashboard <Icon name="arrow_forward" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <OnboardingShell
      checklist={checklist}
      currentKey={current}
      onSignOut={handleSignOut}
      reviewing={reviewing}
      onReturnToCurrent={returnToCurrent}
    >
      {content}
    </OnboardingShell>
  );
}
