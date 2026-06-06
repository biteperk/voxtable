import { useState } from "react";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "../dashboard/DashboardShell";

const PLAN_TIERS = [
  {
    id: "starter",
    name: "Starter",
    blurb: "Everything an independent restaurant needs to never miss a booking.",
    price: 80,
    period: "month",
    cta: "Switch to Starter",
    features: [
      "Bella answers every call, 24/7",
      "Books, modifies, cancels in your dashboard",
      "Up to 1,500 calls / month",
      "Standard call analytics",
      "Email support",
      "1 venue"
    ]
  },
  {
    id: "pro",
    name: "Pro",
    blurb: "For growing venues that want deeper insights and multi-site coverage.",
    price: 149,
    period: "month",
    featured: true,
    cta: "Upgrade to Pro",
    features: [
      "Everything in Starter",
      "Unlimited calls",
      "Up to 5 venues on one dashboard",
      "Advanced analytics & cohort retention",
      "Outbound confirmation calls (SMS)",
      "Priority support (1 business-day)"
    ]
  },
  {
    id: "enterprise",
    name: "Enterprise",
    blurb: "For hospitality groups with multiple venues and bespoke needs.",
    price: 349,
    period: "month",
    cta: "Contact sales",
    features: [
      "Everything in Pro",
      "Up to 50 venues",
      "99.9% uptime SLA",
      "White-label voice agents",
      "POS API access",
      "Dedicated success manager"
    ]
  }
];

export function ManagePlanPage({ navigate }) {
  const [currentPlanId, setCurrentPlanId] = useState("starter");
  const [pendingTier, setPendingTier] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelStage, setCancelStage] = useState("confirming");

  const handleSelect = (tier) => {
    if (tier.id === currentPlanId) return;
    setPendingTier(tier);
  };

  const closePending = () => setPendingTier(null);

  const confirmPending = () => {
    if (!pendingTier) return;
    // Stripe wire-up lands when billing integration ships. For now optimistic
    // local-state move so QA can verify the UI path end-to-end.
    setCurrentPlanId(pendingTier.id);
    setPendingTier(null);
  };

  const openCancel = () => {
    setCancelStage("confirming");
    setCancelOpen(true);
  };

  const dismissCancel = () => {
    setCancelOpen(false);
    setCancelStage("confirming");
  };

  const confirmCancel = () => {
    setCancelStage("done");
  };

  return (
    <DashboardShell active="Billing" navigate={navigate}>
      <header className="billing-header manage-plan-header">
        <button
          type="button"
          className="back-button"
          onClick={() => navigate("/settings")}
          aria-label="Back to billing"
        >
          <Icon name="arrow_back" />
        </button>
        <div>
          <h1>Manage your plan</h1>
          <p>Change tier, pause or cancel your VocoTable subscription.</p>
        </div>
      </header>

      <section className="billing-grid">
        {PLAN_TIERS.map((tier) => {
          const isCurrent = tier.id === currentPlanId;
          const classes = [
            "plan-tier-card",
            tier.featured && !isCurrent ? "featured" : ""
          ]
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
                <p className="plan-tier-blurb">{tier.blurb}</p>
              </div>
              <div className="plan-tier-price">
                <strong>
                  ${tier.price} <span>/ {tier.period}</span>
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
                disabled={isCurrent}
                onClick={() => handleSelect(tier)}
              >
                {isCurrent ? "Current plan" : tier.cta}
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
            <summary>Can I pause instead of cancelling?</summary>
            <p>
              Yes. Pause halts billing and disconnects Bella from your line, but keeps your
              account, FAQs, and historic data intact so you can resume instantly. Email us to
              pause; in the next release this becomes a one-click action.
            </p>
          </details>
        </article>

        <article className="plan-danger-card">
          <div>
            <h3>Cancel subscription</h3>
            <p>
              You&apos;ll keep access until the end of your current billing period. We&apos;ll send a
              confirmation email.
            </p>
          </div>
          <button type="button" onClick={openCancel}>
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
              You&apos;ll be moved to the {pendingTier.name} plan at{" "}
              <strong>
                ${pendingTier.price}/{pendingTier.period}
              </strong>
              .
              {pendingTier.id === "enterprise"
                ? " Our team will reach out to set up your contract."
                : " The change applies at your next billing date — no interruption to Bella."}
            </p>
            <div className="plan-modal-actions">
              <button type="button" onClick={closePending} className="ghost-button">
                Keep current plan
              </button>
              <button type="button" onClick={confirmPending} className="primary-button">
                {pendingTier.id === "enterprise"
                  ? "Request contact"
                  : `Confirm ${pendingTier.name}`}
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
            {cancelStage === "confirming" ? (
              <>
                <h2 id="cancel-title">Cancel your subscription?</h2>
                <p>
                  Bella will keep answering until the end of your current billing period. After
                  that, calls fall back to your phone provider&apos;s voicemail.
                </p>
                <p>
                  Your historic call data and bookings stay accessible from this dashboard.
                </p>
                <div className="plan-modal-actions">
                  <button type="button" onClick={dismissCancel} className="ghost-button">
                    Keep my subscription
                  </button>
                  <button type="button" onClick={confirmCancel} className="danger-button">
                    Cancel subscription
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="cancel-title">
                  <Icon name="check_circle" /> Cancellation requested
                </h2>
                <p>
                  We&apos;ve received your cancellation request. You&apos;ll get a confirmation email
                  and Bella will keep working until your next billing date.
                </p>
                <div className="plan-modal-actions">
                  <button
                    type="button"
                    onClick={() => {
                      dismissCancel();
                      navigate("/settings");
                    }}
                    className="primary-button"
                  >
                    Back to Billing
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
