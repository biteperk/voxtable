import { useCallback, useEffect, useState } from "react";
import { listActiveOrders, listTables } from "../../api";
import { formatVoiceTime12h, zoneIcon } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

const ORDER_STATUS_LABEL = {
  queued: "Queued",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
};

const PAYMENT_STATUS_LABEL = {
  unpaid: "Unpaid",
  paid: "Paid",
  refunded: "Refunded",
};

const REFRESH_INTERVAL_MS = 30_000;

function centsToDollars(cents) {
  return (Number(cents ?? 0) / 100).toFixed(2);
}

// Order timestamps are absolute instants; the floor reads them on the VENUE's
// wall clock. `en-AU` only fixes the format — without `timeZone` a manager
// viewing from another timezone sees every order hours out.
function formatTimelineTime(value, timeZone) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  });
}

function orderLabel(order) {
  return order.order_number ? `Order #${order.order_number}` : "Order";
}

function buildOrderTimeline(orders, timeZone) {
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
    ])
    .filter((event) => event.at && formatTimelineTime(event.at, timeZone))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .map((event) => ({ ...event, time: formatTimelineTime(event.at, timeZone) }));
}

// One status for the table, not a comma list: a table with one paid and
// two unpaid orders is still an unpaid table until the last order settles.
function paymentSummary(orders) {
  const unpaid = orders.filter((order) => order.payment_status === "unpaid").length;
  if (unpaid === 0) {
    const first = orders[0]?.payment_status;
    return PAYMENT_STATUS_LABEL[first] ?? first ?? "Unknown";
  }
  if (unpaid === orders.length) return "Unpaid";
  return `${unpaid} of ${orders.length} unpaid`;
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
  const [timeZone, setTimeZone] = useState(null);
  const [serverNow, setServerNow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const tablesData = await listTables();
    const rows = tablesData.tables ?? [];
    const t = rows.find((row) => row.label === tableLabel);
    if (!t) {
      throw new Error(`Table "${tableLabel}" not found.`);
    }
    // Ask for THIS table's orders in SQL. Filtering the venue-wide list
    // client-side hid a table's orders once the venue passed the list's
    // LIMIT, and matching on the single joined reservation hid the second
    // sitting's orders whenever the first was never marked done.
    const ordersData = await listActiveOrders({ tableId: t.id });
    const hasReservation = Boolean(t.reservation_id);
    return {
      timeZone: tablesData.timezone ?? null,
      serverNow: ordersData.server_now ?? null,
      table: {
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
      },
      orders: ordersData.orders ?? [],
    };
  }, [tableLabel]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const run = async (initial) => {
      try {
        const next = await load();
        if (cancelled) return;
        setTable(next.table);
        setOrders(next.orders);
        setTimeZone(next.timeZone);
        setServerNow(next.serverNow);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // A failed background refresh keeps the last good view on screen; only
        // the first load has nothing better to show than the error.
        if (initial) {
          setTable(null);
          setOrders([]);
        }
        setError(e.message ?? String(e));
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    };

    run(true);
    const timer = window.setInterval(() => run(false), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load]);

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

  if (!table) {
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
  const timeline = buildOrderTimeline(orders, timeZone);

  const subtotalCents = orders.reduce(
    (acc, order) => acc + Number(order.subtotal_cents ?? 0),
    0
  );
  const totalCents = orders.reduce(
    (acc, order) => acc + Number(order.total_cents ?? 0),
    0
  );

  const seatedAt = r?.seatedAt ? new Date(r.seatedAt) : null;
  // server_now comes back with the orders precisely so "seated N min ago"
  // does not depend on a drifting or mis-set device clock.
  const nowMs = serverNow ? new Date(serverNow).getTime() : Date.now();
  const seatedMinutesAgo = seatedAt
    ? Math.max(0, Math.floor((nowMs - seatedAt.getTime()) / 60000))
    : null;
  const seatedTimeLabel = seatedAt ? formatTimelineTime(seatedAt.toISOString(), timeZone) : null;
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
        {error && <p className="to-error">Last refresh failed: {error}</p>}

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
                <span>New POS or voice orders appear here within 30 seconds.</span>
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
                    : paymentSummary(orders)}
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
