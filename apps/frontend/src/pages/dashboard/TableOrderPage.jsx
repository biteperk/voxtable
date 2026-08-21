import { useEffect, useState } from "react";
import { listActiveOrders, listTables } from "../../api";
import { formatVoiceTime12h, zoneIcon } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

const ORDER_STATUS_LABEL = {
  queued: "Queued",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
  pending: "Pending",
  cancelled: "Cancelled",
};

const PAYMENT_STATUS_LABEL = {
  unpaid: "Unpaid",
  pending: "Pending",
  paid: "Paid",
  refunded: "Refunded",
  failed: "Failed",
};

function centsToDollars(cents) {
  return (Number(cents ?? 0) / 100).toFixed(2);
}

function formatTimelineTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function orderLabel(order) {
  return order.order_number ? `Order #${order.order_number}` : "Order";
}

function buildOrderTimeline(orders) {
  return orders
    .flatMap((order) => [
      {
        at: order.ordered_at,
        source: order.source === "voice" ? "AI VOICE" : "STAFF",
        text: `${orderLabel(order)} created`,
      },
      {
        at: order.confirmed_at,
        source: "KITCHEN",
        text: `${orderLabel(order)} moved to kitchen`,
      },
      {
        at: order.ready_at,
        source: "KITCHEN",
        text: `${orderLabel(order)} marked ready`,
      },
      {
        at: order.served_at,
        source: "STAFF",
        text: `${orderLabel(order)} served`,
      },
      {
        at: order.cancelled_at,
        source: "STAFF",
        text: `${orderLabel(order)} cancelled`,
      },
    ])
    .filter((event) => event.at && formatTimelineTime(event.at))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .map((event) => ({ ...event, time: formatTimelineTime(event.at) }));
}

function itemNotes(item) {
  const modifiers = (item.modifiers ?? [])
    .map((modifier) => modifier.name_snapshot)
    .filter(Boolean)
    .join(", ");
  return [item.variant_name_snapshot, modifiers, item.special_requests]
    .filter(Boolean)
    .join(" · ");
}

export function TableOrderPage({ navigate, tableLabel }) {
  const [table, setTable] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listTables(), listActiveOrders()])
      .then(([tablesData, ordersData]) => {
        if (cancelled) return;
        const rows = tablesData.tables ?? [];
        const t = rows.find((row) => row.label === tableLabel);
        if (!t) {
          setError(`Table "${tableLabel}" not found.`);
          setTable(null);
          setOrders([]);
        } else {
          const hasReservation = Boolean(t.reservation_id);
          const nextTable = {
            id: t.id,
            label: t.label,
            zone: t.zone || null,
            description: t.description || null,
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
          };
          const activeReservationId = nextTable.reservation?.id ?? null;
          const activeOrders = ordersData.orders ?? [];
          const tableOrders = activeOrders.filter((order) => {
            if (activeReservationId && order.reservation_id === activeReservationId) {
              return true;
            }
            return !order.reservation_id && order.table_id === nextTable.id;
          });
          setTable(nextTable);
          setOrders(tableOrders);
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
  const items = orders.flatMap((order) =>
    (order.items ?? []).map((item) => ({ ...item, order }))
  );
  const timeline = buildOrderTimeline(orders);

  const subtotalCents = orders.reduce(
    (acc, order) => acc + Number(order.subtotal_cents ?? 0),
    0
  );
  const totalCents = orders.reduce(
    (acc, order) => acc + Number(order.total_cents ?? 0),
    0
  );

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
            {table.zone && (
              <span className="to-pill to-pill-zone">
                <Icon name={zoneIcon(table.zone)} />
                {table.zone}
              </span>
            )}
            {hasReservation && (
              <span className="to-pill to-pill-ai">
                <Icon name="auto_awesome" />
                AI Booked
              </span>
            )}
          </div>
        </header>

        {table.description && <p className="to-hero-desc">{table.description}</p>}

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
                {items.length} {items.length === 1 ? "item" : "items"}
              </span>
            </header>

            {items.length === 0 ? (
              <div className="to-empty">
                <p>No active orders for this table</p>
                <span>New POS or voice orders will appear here in real time.</span>
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
                  {items.map((it) => {
                    const notes = itemNotes(it);
                    return (
                      <tr key={it.id}>
                        <td>
                          <p className="to-item-name">{it.name_snapshot}</p>
                          {notes && <span className="to-item-notes">{notes}</span>}
                        </td>
                        <td>
                          <span className={`to-status-chip status-${it.status}`}>
                            {ORDER_STATUS_LABEL[it.status] ?? it.status}
                          </span>
                        </td>
                        <td className="to-num">{it.quantity}</td>
                        <td className="to-num">${centsToDollars(it.unit_price_cents)}</td>
                        <td className="to-num to-num-strong">
                          ${centsToDollars(it.line_total_cents)}
                        </td>
                      </tr>
                    );
                  })}
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
                <dd>${centsToDollars(subtotalCents)}</dd>
              </div>
              <div>
                <dt>Active orders</dt>
                <dd>{orders.length}</dd>
              </div>
              <div>
                <dt>Payment status</dt>
                <dd>
                  {orders.length === 0
                    ? "None"
                    : [
                        ...new Set(
                          orders.map(
                            (order) =>
                              PAYMENT_STATUS_LABEL[order.payment_status] ??
                              order.payment_status ??
                              "Unknown"
                          )
                        ),
                      ].join(", ")}
                </dd>
              </div>
            </dl>
            <div className="to-invoice-total">
              <span>Total</span>
              <strong>${centsToDollars(totalCents)}</strong>
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
