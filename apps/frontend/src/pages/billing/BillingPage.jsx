import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth";
import { getBillingInvoices, getBillingPaymentMethods, getBillingSubscription } from "../../api";
import { capitalize, formatInvoiceDate } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { CardBrandIcon } from "../../components/brand/CardBrandIcon";
import { DashboardShell } from "../dashboard/DashboardShell";

const INVOICE_STATUSES = [
  { key: "paid",     label: "Paid",     color: "primary" },
  { key: "refunded", label: "Refunded", color: "warn" },
  { key: "failed",   label: "Failed",   color: "danger" },
];


export function BillingPage({ navigate }) {
  const { user } = useAuth();

  const [invoices, setInvoices] = useState([]);
  const [subscription, setSubscription] = useState(null);
  const [defaultCard, setDefaultCard] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState("live");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [statusFilter, setStatusFilter] = useState(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const filterRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getBillingInvoices(), getBillingSubscription(), getBillingPaymentMethods()])
      .then(([inv, sub, pm]) => {
        if (cancelled) return;
        setEnabled(Boolean(inv?.enabled));
        setMode(inv?.mode ?? "live");
        setInvoices(Array.isArray(inv?.invoices) ? inv.invoices : []);
        setSubscription(sub?.subscription ?? null);
        const cards = Array.isArray(pm?.payment_methods) ? pm.payment_methods : [];
        setDefaultCard(cards.find((c) => c.is_default) ?? cards[0] ?? null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!filterOpen) return;
    const onClick = (event) => {
      if (filterRef.current && !filterRef.current.contains(event.target)) {
        setFilterOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  const toggleStatus = (key) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const clearFilters = () => setStatusFilter(new Set());

  const filtered = statusFilter.size === 0
    ? invoices
    : invoices.filter((inv) => statusFilter.has(inv.status));
  const isFiltered = statusFilter.size > 0;

  const handleDownloadReceipt = async (invoice) => {
    if (downloadingId) return;
    setDownloadingId(invoice.id);
    try {
      const { exportReceiptPdf } = await import("../../pdfExport.js");
      exportReceiptPdf({
        invoice,
        customer: {
          name: user?.displayName ?? user?.email ?? "Customer",
          email: user?.email ?? "—",
        },
        plan: {
          name: subscription?.plan_name ?? "VoxTable Core Plan",
          description: "Monthly subscription — unlimited AI agent bookings",
        },
      });
    } catch (e) {
      // Surface to console; the row stays interactive so the user can retry.
      console.error("[billing] receipt export failed:", e);
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <DashboardShell active="Billing" navigate={navigate}>
        <header className="billing-header">
          <h1>Billing &amp; Subscription</h1>
          <p>Manage your payment methods and view past invoices.</p>
        </header>
        <p style={{ color: "var(--on-surface-variant)" }}>Loading billing…</p>
      </DashboardShell>
    );
  }

  if (error) {
    return (
      <DashboardShell active="Billing" navigate={navigate}>
        <header className="billing-header">
          <h1>Billing &amp; Subscription</h1>
          <p>Manage your payment methods and view past invoices.</p>
        </header>
        <p style={{ color: "var(--danger, #c00)" }}>
          Couldn’t load billing: {error}
        </p>
      </DashboardShell>
    );
  }

  const planName = subscription?.plan_name ?? "VoxTable Core Plan";
  const planAmount = subscription?.amount_display ?? "$80.00";
  const planInterval = subscription?.interval ?? "month";
  const nextBilling = subscription?.current_period_end
    ? formatInvoiceDate(subscription.current_period_end)
    : "—";

  return (
    <DashboardShell active="Billing" navigate={navigate}>
      <header className="billing-header">
        <h1>Billing & Subscription</h1>
        <p>Manage your payment methods and view past invoices.</p>
      </header>

      {enabled && mode === "test" && (
        <div className="billing-banner billing-banner-test" role="status">
          <Icon name="science" />
          <span>
            <strong>TEST MODE</strong> — these are Stripe test invoices, not real charges.
          </span>
        </div>
      )}
      {!enabled && (
        <div className="billing-banner billing-banner-info" role="status">
          <Icon name="info" />
          <span>
            Billing isn’t connected yet. Showing placeholder details until Stripe is enabled.
          </span>
        </div>
      )}

      <section className="billing-grid">
        <article className="plan-card">
          <div className="plan-glow" />
          <div className="plan-head">
            <div>
              <h2>
                {planName} <span>{subscription?.status ? capitalize(subscription.status) : "Active"}</span>
              </h2>
              <p>Flat rate monthly subscription for unlimited AI agent bookings.</p>
            </div>
            <Icon name="verified" fill className="verified-icon" />
          </div>
          <div className="plan-bottom">
            <div>
              <strong>
                {planAmount} <span>/ {planInterval}</span>
              </strong>
              <p>
                <Icon name="calendar_month" />
                Next billing date: {nextBilling}
              </p>
            </div>
            <button onClick={() => navigate("/manage-plan")}>Manage Plan</button>
          </div>
        </article>

        <article className="payment-card">
          <h2>Payment Method</h2>
          {defaultCard ? (
            <div className="card-line">
              <CardBrandIcon brand={defaultCard.brand} />
              <div className="card-line-meta">
                <p>
                  {defaultCard.brand} •••• {defaultCard.last4}
                </p>
                {defaultCard.expiry && <span>Expires {defaultCard.expiry}</span>}
              </div>
              <Icon name="check_circle" className="check-circle" />
            </div>
          ) : (
            <div className="card-line payment-card-empty">
              <div className="card-icon">
                <Icon name="credit_card_off" />
              </div>
              <div className="card-line-meta">
                <p>No card on file</p>
                <span>Add a card to keep your subscription active</span>
              </div>
            </div>
          )}
          <button onClick={() => navigate("/update-payment-details")}>
            {defaultCard ? "Manage Payment Methods" : "Add a card"}
            <Icon name="arrow_forward" />
          </button>
        </article>

        <article className="billing-history">
          <div className="billing-history-head">
            <h2>Billing History</h2>
            <div className="billing-filter-wrap" ref={filterRef}>
              <button
                type="button"
                className={filterOpen ? "is-open" : ""}
                onClick={() => setFilterOpen((v) => !v)}
                aria-expanded={filterOpen}
                aria-haspopup="menu"
              >
                <Icon name="filter_list" />
                Filter
                {statusFilter.size > 0 && (
                  <span className="filter-badge">{statusFilter.size}</span>
                )}
              </button>
              {filterOpen && (
                <div className="booking-filter-popover" role="menu">
                  <div className="booking-filter-head">
                    <span>Filter by status</span>
                    {statusFilter.size > 0 && (
                      <button type="button" onClick={clearFilters}>Clear</button>
                    )}
                  </div>
                  {INVOICE_STATUSES.map((opt) => {
                    const checked = statusFilter.has(opt.key);
                    return (
                      <label key={opt.key} className="booking-filter-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleStatus(opt.key)}
                        />
                        <span className={`invoice-status-dot ${opt.color}`} />
                        {opt.label}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="billing-history-body">
            <table>
              <thead>
                <tr>
                  <th>Invoice Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--on-surface-variant)" }}>
                      {isFiltered ? "No invoices match your filters." : "No invoices yet."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((inv) => {
                    const status = INVOICE_STATUSES.find((s) => s.key === inv.status) ?? INVOICE_STATUSES[0];
                    return (
                      <tr key={inv.id}>
                        <td>{formatInvoiceDate(inv.issued_at)}</td>
                        <td>{inv.total_display ?? "—"}</td>
                        <td>
                          <span className={`invoice-status-dot ${status.color}`} />
                          {status.label}
                        </td>
                        <td>
                          <button
                            type="button"
                            aria-label={`Download ${inv.id} receipt`}
                            onClick={() => handleDownloadReceipt(inv)}
                            disabled={downloadingId === inv.id}
                            title="Download receipt PDF"
                          >
                            <Icon name={downloadingId === inv.id ? "hourglass_top" : "download"} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </DashboardShell>
  );
}
