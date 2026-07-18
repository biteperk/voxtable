import { useEffect, useState } from "react";
import { TIERS } from "../../data/pricing";
import { PHONE_DISPLAY } from "../../lib/brand";
import { createBillingPortalSession, getBillingSubscription } from "../../api";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "../dashboard/DashboardShell";

// The switchable plans are the three self-serve tiers from the public pricing page.
// pricing.js is the single source of truth, so the manage-plan cards can never drift
// from the website. Enterprise is contact-sales (`custom: true`) and is intentionally
// not a self-serve plan you can switch into from here.
const SWITCHABLE_TIERS = TIERS.filter((tier) => !tier.custom);

// Best-effort map from a live subscription to one of the tiers, so we can flag the
// "Current" plan. Matches the integer dollar amount from the mirror's amount_display
// ("$150.00") against the tier price ("$150"). Returns null when billing is off or the
// amount doesn't line up with a known tier — in which case no card is flagged current.
function matchCurrentTierId(subscription) {
  if (!subscription) return null;
  const amount = parseFloat(String(subscription.amount_display ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount)) return null;
  const tier = SWITCHABLE_TIERS.find(
    (t) => parseFloat(t.price.replace(/[^0-9.]/g, "")) === Math.round(amount)
  );
  return tier?.id ?? null;
}

export function ManagePlanPage({ navigate }) {
  const [subscription, setSubscription] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [pendingTier, setPendingTier] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBillingSubscription()
      .then((res) => {
        if (cancelled) return;
        setEnabled(Boolean(res?.enabled));
        setSubscription(res?.subscription ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const currentPlanId = matchCurrentTierId(subscription);

  // Plan changes and cancellation are delegated to Stripe's hosted Customer Portal
  // (configured with the three prices). We never mutate the subscription from our own
  // backend, so there's no proration or downgrade-scheduling logic to get wrong here —
  // the same PCI-safe pattern UpdatePaymentDetailsPage uses for cards.
  const openPortal = async () => {
    if (redirecting) return;
    setRedirecting(true);
    try {
      const { url } = await createBillingPortalSession();
      if (url) window.location.href = url;
      else setRedirecting(false);
    } catch (e) {
      console.error("[billing] portal session failed:", e);
      setError(e.message);
      setRedirecting(false);
    }
  };

  const handleSelect = (tier) => {
    if (!enabled || tier.id === currentPlanId) return;
    setPendingTier(tier);
  };
  const closePending = () => {
    if (!redirecting) setPendingTier(null);
  };
  const openCancel = () => setCancelOpen(true);
  const dismissCancel = () => {
    if (!redirecting) setCancelOpen(false);
  };

  const header = (
    <header className="billing-header manage-plan-header">
      <button
        type="button"
        className="back-button"
        onClick={() => navigate("/billing")}
        aria-label="Back to billing"
      >
        <Icon name="arrow_back" />
      </button>
      <div>
        <h1>Manage your plan</h1>
        <p>Change tier, pause or cancel your VocoTable subscription.</p>
      </div>
    </header>
  );

  if (loading) {
    return (
      <DashboardShell active="Billing" navigate={navigate}>
        {header}
        <p style={{ color: "var(--on-surface-variant)" }}>Loading your plan…</p>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell active="Billing" navigate={navigate}>
      {header}

      {error && (
        <div className="billing-banner billing-banner-info" role="status">
          <Icon name="error" />
          <span>Couldn’t reach billing: {error}</span>
        </div>
      )}
      {!enabled && !error && (
        <div className="billing-banner billing-banner-info" role="status">
          <Icon name="info" />
          <span>Billing isn’t connected yet. Plan changes open once Stripe is enabled.</span>
        </div>
      )}

      <section className="billing-grid">
        {SWITCHABLE_TIERS.map((tier) => {
          const isCurrent = tier.id === currentPlanId;
          const classes = ["plan-tier-card", tier.featured && !isCurrent ? "featured" : ""]
            .filter(Boolean)
            .join(" ");
          return (
            <article key={tier.id} className={classes}>
              <div className="plan-glow" />
              <div className="plan-tier-head">
                <h2>
                  {tier.name}
                  {isCurrent && <span className="plan-tier-pill">Current</span>}
                  {tier.featured && !isCurrent && (
                    <span className="plan-tier-pill">Recommended</span>
                  )}
                </h2>
                <p className="plan-tier-blurb">{tier.tagline}</p>
              </div>
              <div className="plan-tier-price">
                <strong>
                  {tier.price} <span>{tier.suffix}</span>
                </strong>
              </div>
              <ul className="plan-tier-features">
                {tier.features.map((f) => (
                  <li key={f}>
                    <Icon name="check_circle" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="plan-tier-cta"
                disabled={isCurrent || !enabled}
                onClick={() => handleSelect(tier)}
              >
                {isCurrent ? "Current plan" : `Switch to ${tier.name}`}
              </button>
            </article>
          );
        })}

        <article className="plan-faq-card">
          <h2>Common questions</h2>
          <details>
            <summary>How does billing work when I change plans?</summary>
            <p>
              We pro-rate the difference. If you upgrade mid-cycle, you&apos;re charged the prorated
              amount for the rest of the month. If you downgrade, the new lower rate kicks in on
              your next billing date.
            </p>
          </details>
          <details>
            <summary>What happens to my bookings if I cancel?</summary>
            <p>
              Every booking ever taken by Bella stays in your account permanently. You can export
              them as CSV any time. Cancelling stops new calls being answered — existing data is
              never deleted unless you explicitly request it.
            </p>
          </details>
          <details>
            <summary>Need more than three locations?</summary>
            <p>
              Our Enterprise plan covers 4+ venues, custom voice personas, and bespoke
              integrations. Contact us on {PHONE_DISPLAY} to set it up.
            </p>
          </details>
        </article>

        <article className="plan-danger-card">
          <div>
            <h3>Cancel subscription</h3>
            <p>
              You&apos;ll keep access until the end of your current billing period. Cancellation is
              handled securely in Stripe.
            </p>
          </div>
          <button type="button" onClick={openCancel} disabled={!enabled}>
            Cancel subscription
          </button>
        </article>
      </section>

      {pendingTier && (
        <div
          className="plan-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="plan-change-title"
          onClick={closePending}
        >
          <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="plan-change-title">Switch to {pendingTier.name}?</h2>
            <p>
              You&apos;ll be taken to Stripe&apos;s secure portal to confirm the move to the{" "}
              {pendingTier.name} plan at{" "}
              <strong>
                {pendingTier.price}
                {pendingTier.suffix}
              </strong>
              . Changes pro-rate to the day — no interruption to Bella.
            </p>
            <div className="plan-modal-actions">
              <button
                type="button"
                onClick={closePending}
                className="ghost-button"
                disabled={redirecting}
              >
                Keep current plan
              </button>
              <button
                type="button"
                onClick={openPortal}
                className="primary-button"
                disabled={redirecting}
              >
                {redirecting ? "Opening Stripe…" : "Continue to Stripe"}
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelOpen && (
        <div
          className="plan-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-title"
          onClick={dismissCancel}
        >
          <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="cancel-title">Cancel your subscription?</h2>
            <p>
              Bella will keep answering until the end of your current billing period. After that,
              calls fall back to your phone provider&apos;s voicemail.
            </p>
            <p>Your historic call data and bookings stay accessible from this dashboard.</p>
            <div className="plan-modal-actions">
              <button
                type="button"
                onClick={dismissCancel}
                className="ghost-button"
                disabled={redirecting}
              >
                Keep my subscription
              </button>
              <button
                type="button"
                onClick={openPortal}
                className="danger-button"
                disabled={redirecting}
              >
                {redirecting ? "Opening Stripe…" : "Cancel in Stripe"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
