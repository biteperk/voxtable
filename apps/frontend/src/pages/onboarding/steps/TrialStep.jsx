import { useEffect, useRef, useState } from "react";
import { createBillingCheckoutSession } from "../../../api";
import { Icon } from "../../../components/Icon";

export function TrialStep({ onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const pollsRef = useRef(0);

  // After returning from Stripe Checkout the webhook may lag a few seconds
  // before advancing the status, so poll a bounded number of times.
  useEffect(() => {
    const id = setInterval(() => {
      pollsRef.current += 1;
      if (pollsRef.current > 8) {
        clearInterval(id);
        return;
      }
      onRefresh?.();
    }, 4000);
    return () => clearInterval(id);
  }, [onRefresh]);

  const startTrial = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setUnavailable(false);
    try {
      const result = await createBillingCheckoutSession();
      if (result?.url) {
        window.location.assign(result.url);
        return;
      }
      if (result?.onboarding_status) {
        await onRefresh?.();
        return;
      }
      setError("Checkout did not return a payment link. Please try again.");
    } catch (e) {
      if (e.code === "BILLING_NOT_CONFIGURED") {
        setUnavailable(true);
        setError("Billing is not configured yet, so checkout cannot open.");
      } else {
        setError(e.message || "Checkout could not be opened. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-card">
      <div className="onboarding-bella">
        <span className="onboarding-bella-avatar" aria-hidden="true"><Icon name="headset_mic" /></span>
        <p>Try me free for 14 days. I'll start answering your calls now — your card isn't charged until the trial ends.</p>
      </div>
      <h1>Start your free trial</h1>
      <p className="onboarding-lead">
        Try VoxTable free for 14 days. We'll set up your AI phone host now — cancel anytime.
      </p>
      <div className="trial-plan">
        <div>
          <strong>VoxTable Starter</strong>
          <span>Unlimited AI-answered calls, bookings &amp; orders</span>
        </div>
        <div className="trial-price">
          <strong>$80</strong>
          <span>/ month after trial</span>
        </div>
      </div>
      <ul className="trial-reassure">
        <li><Icon name="check" /> 14-day free trial</li>
        <li><Icon name="check" /> Card not charged until the trial ends</li>
        <li><Icon name="check" /> Cancel anytime</li>
      </ul>
      {unavailable && (
        <p className="onboarding-note">
          <Icon name="info" /> Billing isn't switched on yet — your progress is saved.
        </p>
      )}
      {error && <p className="onboarding-error">{error}</p>}
      <div className="onboarding-actions">
        <button type="button" className="primary-button" onClick={startTrial} disabled={busy || unavailable}>
          {busy ? "Opening secure checkout…" : "Start 14-day free trial"}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}
