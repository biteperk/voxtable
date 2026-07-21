import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { signOutUser } from "../../firebase";
import { getOnboardingStatus } from "../../api";
import { Icon } from "../../components/Icon";
import { CreateRestaurantStep } from "./steps/CreateRestaurantStep";
import { ProfileStep } from "./steps/ProfileStep";
import { MenuStep } from "./steps/MenuStep";
import { TrialStep } from "./steps/TrialStep";
import { PhoneStep } from "./steps/PhoneStep";

// ===== Onboarding wizard (Phase 1) =====

function OnboardingShell({ checklist, children, onSignOut, welcome = false, currentKey = null }) {
  const total = checklist?.length ?? 0;
  const currentIndex = checklist ? checklist.findIndex((s) => s.status === "current") : -1;
  const current = currentIndex >= 0 ? checklist[currentIndex] : null;
  const doneCount = checklist ? checklist.filter((s) => s.status === "done").length : 0;
  const allDone = total > 0 && doneCount === total;
  const ONBOARDING_CONTEXT = {
    profile: "Used by Bella on every call — change it anytime",
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
          <strong>PerkTable</strong>
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
                  className={`onboarding-progress-seg is-${s.status}`}
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

export function OnboardingWizard({ navigate }) {
  const { memberships, refreshMe } = useAuth();
  const [status, setStatus] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const hasRestaurant = (memberships?.length ?? 0) > 0;

  const load = useCallback(async () => {
    if (!hasRestaurant) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await getOnboardingStatus();
      setStatus(r.onboarding_status);
      setChecklist(r.checklist);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [hasRestaurant]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSignOut = async () => {
    await signOutUser();
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

  const current = checklist?.find((s) => s.status === "current")?.key ?? null;

  let content;
  if (current === "profile") {
    content = <ProfileStep onSaved={load} />;
  } else if (current === "menu") {
    content = <MenuStep onContinue={load} navigate={navigate} />;
  } else if (current === "trial") {
    content = <TrialStep onRefresh={load} />;
  } else if (current === "phone") {
    content = <PhoneStep onRefresh={load} />;
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
    <OnboardingShell checklist={checklist} currentKey={current} onSignOut={handleSignOut}>
      {content}
    </OnboardingShell>
  );
}

