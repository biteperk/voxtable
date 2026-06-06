import { useEffect, useState } from "react";
import { listTables } from "../../api";
import { formatVoiceTime12h } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";
import { MOCK_TABLE_ORDERS, MOCK_TABLE_TIMELINE } from "../../lib/mockData";

const ORDER_STATUS_LABEL = {
  served: "Served",
  fired: "In Kitchen",
  pending: "Pending",
};

const TAX_RATE = 0.085;
const SERVICE_RATE = 0.18;

export function TableOrderPage({ navigate, tableLabel }) {
  const [table, setTable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listTables()
      .then((data) => {
        if (cancelled) return;
        const rows = data.tables ?? [];
        const t = rows.find((row) => row.label === tableLabel);
        if (!t) {
          setError(`Table "${tableLabel}" not found.`);
          setTable(null);
        } else {
          const hasReservation = Boolean(t.reservation_id);
          setTable({
            id: t.id,
            label: t.label,
            minCapacity: t.min_capacity,
            maxCapacity: t.max_capacity,
            status: !hasReservation
              ? "available"
              : t.reservation_seated_at
                ? "seated"
                : "reserved",
            reservation: hasReservation
              ? {
                  id: t.reservation_id,
                  startTime: t.reservation_start_time,
                  partySize: t.reservation_party_size,
                  seatedAt: t.reservation_seated_at,
                  guestName: t.customer_name,
                }
              : null,
          });
        }
      })
      .catch((e) => !cancelled && setError(e.message ?? String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tableLabel]);

  if (loading) {
    return (
      <DashboardShell active="Live Tables" navigate={navigate}>
        <div className="to-page">
          <button
            type="button"
            className="to-back"
            onClick={() => navigate("/live-tables")}
          >
            <Icon name="arrow_back" />
            Back to Floor Plan
          </button>
          <p className="to-loading">Loading table {tableLabel}…</p>
        </div>
      </DashboardShell>
    );
  }

  if (error || !table) {
    return (
      <DashboardShell active="Live Tables" navigate={navigate}>
        <div className="to-page">
          <button
            type="button"
            className="to-back"
            onClick={() => navigate("/live-tables")}
          >
            <Icon name="arrow_back" />
            Back to Floor Plan
          </button>
          <p className="to-error">{error ?? `Table ${tableLabel} not found.`}</p>
        </div>
      </DashboardShell>
    );
  }

  const r = table.reservation;
  const hasReservation = Boolean(r);
  const orders = MOCK_TABLE_ORDERS[table.label] ?? [];
  const timeline = MOCK_TABLE_TIMELINE[table.label] ?? [];

  const subtotal = orders.reduce((acc, it) => acc + it.qty * it.price, 0);
  const tax = subtotal * TAX_RATE;
  const service = subtotal * SERVICE_RATE;
  const total = subtotal + tax + service;

  const seatedAt = r?.seatedAt ? new Date(r.seatedAt) : null;
  const seatedMinutesAgo = seatedAt
    ? Math.max(0, Math.floor((Date.now() - seatedAt.getTime()) / 60000))
    : null;
  const seatedTimeLabel = seatedAt
    ? seatedAt.toLocaleTimeString("en-AU", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : null;
  const bookedTimeLabel = r?.startTime ? formatVoiceTime12h(r.startTime) : null;

  return (
    <DashboardShell active="Live Tables" navigate={navigate}>
      <div className="to-page">
        <button
          type="button"
          className="to-back"
          onClick={() => navigate("/live-tables")}
        >
          <Icon name="arrow_back" />
          Back to Floor Plan
        </button>

        <header className="to-hero">
          <div className="to-hero-title">
            <h1>Table {table.label}</h1>
            <span className="to-pill to-pill-capacity">
              <Icon name="group" />
              {table.minCapacity}–{table.maxCapacity}
            </span>
            {hasReservation && (
              <span className="to-pill to-pill-ai">
                <Icon name="auto_awesome" />
                AI Booked
              </span>
            )}
          </div>
        </header>

        {(seatedTimeLabel || bookedTimeLabel || hasReservation) && (
          <div className="to-meta-strip">
            {seatedTimeLabel ? (
              <span className="to-meta-chip">
                <Icon name="schedule" />
                {seatedTimeLabel}
                {seatedMinutesAgo != null && (
                  <span className="to-meta-chip-sub">({seatedMinutesAgo} MIN)</span>
                )}
              </span>
            ) : bookedTimeLabel ? (
              <span className="to-meta-chip">
                <Icon name="schedule" />
                {bookedTimeLabel}
              </span>
            ) : null}
            {hasReservation && (
              <span className="to-meta-chip">
                <Icon name="person" />
                {r.guestName ?? "Guest"}
              </span>
            )}
          </div>
        )}

        <div className="to-grid">
          <section className="to-card to-orders-card">
            <header className="to-card-head">
              <h2>
                <Icon name="list_alt" />
                Active Orders
              </h2>
              <span className="to-card-count">
                {orders.length} {orders.length === 1 ? "item" : "items"}
              </span>
            </header>

            {orders.length === 0 ? (
              <div className="to-empty">
                <p>No items ordered yet</p>
                <span>Orders from the POS will appear here in real time.</span>
              </div>
            ) : (
              <table className="to-items-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Status</th>
                    <th className="to-num">Qty</th>
                    <th className="to-num">Price</th>
                    <th className="to-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((it, idx) => (
                    <tr key={`${it.name}-${idx}`}>
                      <td>
                        <p className="to-item-name">{it.name}</p>
                        {it.notes && <span className="to-item-notes">{it.notes}</span>}
                      </td>
                      <td>
                        <span className={`to-status-chip status-${it.status}`}>
                          {ORDER_STATUS_LABEL[it.status] ?? it.status}
                        </span>
                      </td>
                      <td className="to-num">{it.qty}</td>
                      <td className="to-num">${it.price.toFixed(2)}</td>
                      <td className="to-num to-num-strong">
                        ${(it.qty * it.price).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <aside className="to-card to-invoice-card">
            <header className="to-card-head">
              <h2>
                <Icon name="receipt" />
                Invoice Summary
              </h2>
            </header>
            <dl className="to-invoice-lines">
              <div>
                <dt>Subtotal</dt>
                <dd>${subtotal.toFixed(2)}</dd>
              </div>
              <div>
                <dt>Tax (8.5%)</dt>
                <dd>${tax.toFixed(2)}</dd>
              </div>
              <div>
                <dt>Service Charge (18%)</dt>
                <dd>${service.toFixed(2)}</dd>
              </div>
            </dl>
            <div className="to-invoice-total">
              <span>Total</span>
              <strong>${total.toFixed(2)}</strong>
            </div>
            <div className="to-invoice-actions">
              <button type="button" className="to-btn to-btn-ghost">
                <Icon name="print" />
                Print Bill
              </button>
            </div>
          </aside>

          <section className="to-card to-timeline-card">
            <header className="to-card-head">
              <h2>
                <Icon name="schedule" />
                Activity Timeline
              </h2>
            </header>
            {timeline.length === 0 ? (
              <div className="to-empty">
                <p>No activity yet</p>
              </div>
            ) : (
              <ul className="to-timeline">
                {timeline.map((evt, idx) => (
                  <li key={idx} className="to-timeline-item">
                    <div className="to-timeline-marker">
                      <Icon
                        name={
                          evt.source === "KITCHEN"
                            ? "soup_kitchen"
                            : evt.source === "AI VOICE"
                              ? "auto_awesome"
                              : "person"
                        }
                      />
                    </div>
                    <div className="to-timeline-body">
                      <div className="to-timeline-head">
                        <span className="to-timeline-time">{evt.time}</span>
                        <span className="to-timeline-source">{evt.source}</span>
                      </div>
                      <p>{evt.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </DashboardShell>
  );
}
