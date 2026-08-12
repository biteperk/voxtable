import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { listActiveOrders, sendOrderPaymentLink, updateOrderStatus } from "../../api";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

const KITCHEN_COLUMNS = [
  { status: "pending",   title: "Pending",   icon: "schedule",       advance: "preparing", advanceLabel: "Start" },
  { status: "preparing", title: "Preparing", icon: "soup_kitchen",   advance: "ready",     advanceLabel: "Mark ready" },
  { status: "ready",     title: "Ready",     icon: "room_service",   advance: "served",    advanceLabel: "Mark served" },
];

export function KitchenOverviewPage({ navigate, path }) {
  const { hasMinRole } = useAuth();
  const canCancelOrders = hasMinRole("manager");
  const [orders, setOrders] = useState([]);
  const [serverNow, setServerNow] = useState(new Date().toISOString());
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listActiveOrders();
      setOrders(data.orders ?? []);
      setServerNow(data.server_now ?? new Date().toISOString());
      setError(null);
    } catch (e) {
      setError(e.message ?? "Failed to load orders");
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleAdvance = async (order, nextStatus) => {
    setBusyId(order.id);
    try {
      await updateOrderStatus(order.id, nextStatus, order.version);
      await refresh();
    } catch (e) {
      setError(e.message ?? "Status update failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleSendPaymentLink = async (order) => {
    setBusyId(order.id);
    try {
      const result = await sendOrderPaymentLink(order.id);
      setError(null);
      setNotice(result?.message ?? "Payment link sent.");
    } catch (e) {
      setError(e.message ?? "Couldn't send the payment link");
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = async (order) => {
    const reason = window.prompt(`Cancel order #${order.order_number}? (Optional reason)`);
    if (reason === null) return;
    setBusyId(order.id);
    try {
      await updateOrderStatus(order.id, "cancelled", order.version, reason || undefined);
      await refresh();
    } catch (e) {
      setError(e.message ?? "Cancel failed");
    } finally {
      setBusyId(null);
    }
  };

  const grouped = KITCHEN_COLUMNS.reduce((acc, col) => {
    acc[col.status] = orders.filter((o) => o.status === col.status);
    return acc;
  }, {});

  return (
    <DashboardShell active="Kitchen" navigate={navigate} path={path}>
      <header className="operational-header">
        <div>
          <h1>Kitchen overview</h1>
          <p>All active orders, grouped by stage. Advance each ticket with its action button.</p>
        </div>
        <div className="active-call-pill">
          <Icon name="receipt_long" />
          <span>{orders.length} active</span>
        </div>
      </header>

      {error ? <div className="menu-error">{error}</div> : null}
      {notice ? (
        <div className="menu-error" style={{ background: "transparent", color: "var(--on-surface-variant)" }}>
          {notice}
        </div>
      ) : null}

      <section className="kitchen-board">
        {KITCHEN_COLUMNS.map((col) => (
          <KitchenColumn
            key={col.status}
            column={col}
            orders={grouped[col.status]}
            serverNow={serverNow}
            busyId={busyId}
            onAdvance={handleAdvance}
            onCancel={handleCancel}
            canCancel={canCancelOrders}
            onSendPaymentLink={handleSendPaymentLink}
          />
        ))}
      </section>
    </DashboardShell>
  );
}

function KitchenColumn({ column, orders, serverNow, busyId, onAdvance, onCancel, canCancel, onSendPaymentLink }) {
  return (
    <article className={`kitchen-column kitchen-column-${column.status}`}>
      <header className="kitchen-column-head">
        <span className="kitchen-column-title">
          <Icon name={column.icon} />
          {column.title}
        </span>
        <span className="kitchen-column-count">{orders.length}</span>
      </header>
      <div className="kitchen-column-body">
        {orders.length === 0 ? (
          <div className="kitchen-column-empty">No tickets</div>
        ) : (
          orders.map((order) => (
            <KitchenOrderCard
              key={order.id}
              order={order}
              serverNow={serverNow}
              busy={busyId === order.id}
              advanceLabel={column.advanceLabel}
              onAdvance={() => onAdvance(order, column.advance)}
              onCancel={canCancel ? () => onCancel(order) : null}
              onSendPaymentLink={
                order.payment_status === "unpaid" ? () => onSendPaymentLink(order) : null
              }
            />
          ))
        )}
      </div>
    </article>
  );
}

function KitchenOrderCard({ order, serverNow, busy, advanceLabel, onAdvance, onCancel, onSendPaymentLink }) {
  const orderedAt = new Date(order.ordered_at).getTime();
  const nowMs = new Date(serverNow).getTime();
  const ageS = Math.max(0, Math.round((nowMs - orderedAt) / 1000));
  const mins = Math.floor(ageS / 60);
  const ageLabel = mins < 1 ? `${ageS}s` : `${mins}m`;
  const ageStale = mins >= 10;

  return (
    <article className={`kitchen-card${ageStale ? " is-stale" : ""}`}>
      <header className="kitchen-card-head">
        <span className="kitchen-card-number">#{order.order_number ?? "?"}</span>
        <span className={`kitchen-card-age${ageStale ? " stale" : ""}`}>
          <Icon name="schedule" />
          {ageLabel}
        </span>
      </header>
      <div className="kitchen-card-meta">
        <span className={`kitchen-pill ${order.payment_status === "paid" ? "paid" : "unpaid"}`}>
          {order.payment_status === "paid" ? "PAID" : "UNPAID"}
        </span>
        <span className="kitchen-pill source">{order.source}</span>
        <span className="kitchen-card-total">${(order.total_cents / 100).toFixed(2)}</span>
      </div>
      <ul className="kitchen-card-items">
        {order.items.map((item) => (
          <li key={item.id}>
            <strong>{item.quantity}×</strong> {item.name_snapshot}
            {item.variant_name_snapshot ? <em> — {item.variant_name_snapshot}</em> : null}
            {item.modifiers.length ? (
              <span className="kitchen-card-mods">
                ({item.modifiers.map((m) => m.name_snapshot).join(", ")})
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="kitchen-card-actions">
        <button type="button" className="kitchen-btn primary" onClick={onAdvance} disabled={busy}>
          <Icon name="arrow_forward" />
          {advanceLabel}
        </button>
        {onSendPaymentLink && (
          <button
            type="button"
            className="kitchen-btn"
            onClick={onSendPaymentLink}
            disabled={busy}
            title="Text the guest a payment link"
          >
            <Icon name="send_to_mobile" />
          </button>
        )}
        {onCancel && (
          <button type="button" className="kitchen-btn danger" onClick={onCancel} disabled={busy} title="Cancel order">
            <Icon name="close" />
          </button>
        )}
      </div>
    </article>
  );
}
