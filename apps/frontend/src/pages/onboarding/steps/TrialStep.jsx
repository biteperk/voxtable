import { useEffect, useRef, useState } from "react";
import { createBillingCheckoutSession } from "../../../api";
import { priceIncGst, TRIAL_DAYS } from "../../../data/pricing";
import { Icon } from "../../../components/Icon";
import { EMAIL_HREF } from "../../../lib/brand";

// Fallback shown only until /api/onboarding/status delivers the REAL price
// behind STRIPE_PRICE_ID (plan_price_cents) — the figure someone sees right
// before handing over a card must come from Stripe itself, not a string that
// has to be manually kept in sync with it.
const SELF_SERVE_PRICE_FALLBACK = "$80";

export function TrialStep({ onRefresh, onBack = null, trialDays = TRIAL_DAYS, planPriceCents = null }) {
  const price = Number.isFinite(planPriceCents)
    ? `$${(planPriceCents / 100).toLocaleString("en-AU", { maximumFractionDigits: 2 })}`
    : SELF_SERVE_PRICE_FALLBACK;
  const priceIncGstLabel = priceIncGst(price);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  // Flips true once the bounded poll gives up, so someone whose Stripe webhook
  // lagged past the window gets a visible "check again" instead of silence —
  // previously the poll stopped with no state change and a paid user was left
  // staring at "Start your free trial".
  const [pollExhausted, setPollExhausted] = useState(false);
  const pollsRef = useRef(0);

  // After returning from Stripe Checkout the webhook may lag a few seconds
  // before advancing the status, so poll a bounded number of times.
  useEffect(() => {
    const id = setInterval(() => {
      pollsRef.current += 1;
      if (pollsRef.current > 8) {
        clearInterval(id);
        setPollExhausted(true);
        return;
      }
      onRefresh?.();
    }, 4000);
    return () => clearInterval(id);
  }, [onRefresh]);

  const checkAgain = () => {
    pollsRef.current = 0;
    setPollExhausted(false);
    onRefresh?.();
  };

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
          <strong>{price}</strong>
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
        {priceIncGstLabel && (
          <li>
            <Icon name="check" /> {priceIncGstLabel} per month including GST
          </li>
        )}
        <li><Icon name="check" /> Cancel anytime</li>
      </ul>
      {unavailable && (
        <p className="onboarding-note">
          <Icon name="info" /> Billing isn't switched on yet — your progress is saved. Try again
          in a little while, or <a href={EMAIL_HREF}>contact support</a> and
          we'll finish this step with you.
        </p>
      )}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      {pollExhausted && (
        <p className="onboarding-note">
          <Icon name="info" /> Already completed checkout? It can take a moment to confirm.{" "}
          <button type="button" className="link-button" onClick={checkAgain}>
            Check again
          </button>
        </p>
      )}
      <div className="onboarding-actions">
        {onBack && (
          <button type="button" className="ghost-button" onClick={onBack} disabled={busy}>
            <Icon name="arrow_back" /> Back
          </button>
        )}
        {/* `unavailable` deliberately does NOT disable the button: billing being
            unconfigured is a transient operator state, and a permanently dead
            primary button turns this required step into a wizard dead-end. */}
        <button type="button" className="primary-button" onClick={startTrial} disabled={busy}>
          {busy ? "Opening secure checkout…" : `Start ${trialDays}-day free trial`}
          <Icon name="arrow_forward" />
        </button>
      </div>
    </div>
  );
}
