import { useEffect, useState } from "react";
import { createBillingPortalSession, getBillingPaymentMethods } from "../../api";
import { Icon } from "../../components/Icon";
import { CardBrandIcon } from "../../components/brand/CardBrandIcon";
import { DashboardShell } from "../dashboard/DashboardShell";

export function UpdatePaymentDetailsPage({ navigate }) {
  const [cards, setCards] = useState([]);
  const [defaultId, setDefaultId] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBillingPaymentMethods()
      .then((pm) => {
        if (cancelled) return;
        setEnabled(Boolean(pm?.enabled));
        setCards(Array.isArray(pm?.payment_methods) ? pm.payment_methods : []);
        setDefaultId(pm?.default_payment_method_id ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Add / remove / set-default is delegated entirely to Stripe's hosted Customer
  // Portal — no raw card data ever touches our backend (PCI SAQ-A). This page is
  // a read-only mirror of the cards on file plus a redirect into the portal.
  const handleManagePayment = async () => {
    if (portalLoading) return;
    setPortalLoading(true);
    try {
      const { url } = await createBillingPortalSession();
      if (url) window.location.href = url;
      else setPortalLoading(false);
    } catch (e) {
      console.error("[billing] portal session failed:", e);
      setError(e.message);
      setPortalLoading(false);
    }
  };

  return (
    <DashboardShell active="Billing" navigate={navigate}>
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
          <h1>Payment methods</h1>
          <p>Cards on file are managed securely through Stripe.</p>
        </div>
      </header>

      <section className="payment-update-grid">
        <article className="payment-current-card">
          <div className="payment-current-head">
            <span className="payment-current-label">
              Saved cards <span className="payment-count">({cards.length})</span>
            </span>
          </div>

          {loading ? (
            <p style={{ color: "var(--on-surface-variant)" }}>Loading cards…</p>
          ) : error ? (
            <p style={{ color: "var(--danger, #c00)" }}>Couldn’t load cards: {error}</p>
          ) : !enabled ? (
            <div className="payment-empty">
              <Icon name="info" />
              <p>Billing isn’t connected yet.</p>
            </div>
          ) : cards.length === 0 ? (
            <div className="payment-empty">
              <Icon name="credit_card_off" />
              <p>No cards on file yet. Add one in the Stripe portal.</p>
            </div>
          ) : (
            <ul className="payment-card-list">
              {cards.map((card) => {
                const isDefault = card.is_default || card.id === defaultId;
                return (
                  <li key={card.id} className={`card-line${isDefault ? " is-default" : ""}`}>
                    <CardBrandIcon brand={card.brand} />
                    <div className="card-line-meta">
                      <p>
                        {card.brand} •••• {card.last4}
                      </p>
                      {card.expiry && <span>Expires {card.expiry}</span>}
                    </div>
                    {isDefault && <span className="payment-current-pill">Default</span>}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="payment-current-hint">
            Add, remove, or change your default card in Stripe&apos;s secure portal. We never
            store full card numbers — payments are handled by our PCI-compliant processor.
          </p>

          <div className="payment-form-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => navigate("/billing")}
            >
              Back to Billing
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={handleManagePayment}
              disabled={!enabled || portalLoading}
            >
              {portalLoading ? "Opening Stripe…" : "Manage payment methods"}
              <Icon name="open_in_new" />
            </button>
          </div>
        </article>
      </section>
    </DashboardShell>
  );
}
