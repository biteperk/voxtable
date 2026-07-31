import { useEffect, useRef, useState } from "react";
import { createBillingCheckoutSession } from "../../../api";
import { priceIncGst, TRIAL_DAYS } from "../../../data/pricing";
import { Icon } from "../../../components/Icon";

// The self-serve plan this wizard subscribes people to. Kept as one constant so
// the ex-GST and inc-GST figures on screen are derived from the same number and
// cannot drift apart.
// NOTE: this must match the price behind STRIPE_PRICE_ID. It is not read from
// pricing.js because which TIER maps to the self-serve checkout isn't encoded
// anywhere in the codebase — worth wiring up properly rather than trusting two
// places to be edited together.
const SELF_SERVE_PRICE = "$80";
const SELF_SERVE_PRICE_INC_GST = priceIncGst(SELF_SERVE_PRICE);

export function TrialStep({ onRefresh, onBack = null, trialDays = TRIAL_DAYS }) {
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
        <p>Try me free for {trialDays} days. I'll start answering your calls now — your card isn't charged until the trial ends.</p>
      </div>
      <h1>Start your free trial</h1>
      <p className="onboarding-lead">
        Try VoxTable free for {trialDays} days. We'll set up your AI phone host now — cancel anytime.
      </p>
      <div className="trial-plan">
        <div>
          <strong>VoxTable Starter</strong>
          <span>Unlimited AI-answered calls, bookings &amp; orders</span>
        </div>
        <div className="trial-price">
          <strong>{SELF_SERVE_PRICE}</strong>
          <span>+ GST / month after trial</span>
        </div>
      </div>
      <ul className="trial-reassure">
        <li><Icon name="check" /> {trialDays}-day free trial</li>
        <li><Icon name="check" /> Card not charged until the trial ends</li>
        {/* The figure Stripe will actually charge. Our prices are quoted
            ex-GST, so without this the checkout page shows a bigger number
            than the one they just agreed to — which reads as a bait-and-switch
            at the exact moment they're handing over a card. */}
        {SELF_SERVE_PRICE_INC_GST && (
          <li>
            <Icon name="check" /> {SELF_SERVE_PRICE_INC_GST} per month including GST
          </li>
        )}
        <li><Icon name="check" /> Cancel anytime</li>
      </ul>
      {unavailable && (
        <p className="onboarding-note">
          <Icon name="info" /> Billing isn't switched on yet — your progress is saved.
        </p>
      )}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      <div className="onboarding-actions">
        {onBack && (
          <button type="button" className="ghost-button" onClick={onBack} disabled={busy}>
            <Icon name="arrow_back" /> Back
          </button>
        )}
        <button type="button" className="primary-button" onClick={startTrial} disabled={busy || unavailable}>
          {busy ? "Opening secure checkout…" : `Start ${trialDays}-day free trial`}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}
