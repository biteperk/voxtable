import { createRoot } from "react-dom/client";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  auth,
  signInWithGoogle,
  onAuthStateChanged
} from "./firebase";
import {
  listActiveOrders,
  sendHeartbeat,
  updateOrderStatus,
  updateOrderItemStatus
} from "./api";
import { ding, isAudioUnlocked, unlockAudio } from "./audio";
import { ErrorBoundary } from "./ErrorBoundary";
import { registerServiceWorker, subscribeOnlineStatus } from "./offline";
import "./styles.css";

const POLL_INTERVAL_MS = 2000;
const POLL_BACKOFF_MAX_MS = 16000;
const HEARTBEAT_INTERVAL_MS = 60_000;

const LANES = [
  { key: "pending", title: "Pending", statuses: ["pending"], next: "preparing", actionLabel: "Start" },
  { key: "preparing", title: "Preparing", statuses: ["preparing"], next: "ready", actionLabel: "Mark Ready" },
  { key: "ready", title: "Ready", statuses: ["ready"], next: "served", actionLabel: "Served" }
];

function formatAge(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function classifyAge(seconds) {
  if (seconds == null) return "ok";
  if (seconds > 900) return "bad";
  if (seconds > 300) return "warn";
  return "ok";
}

function OrderCard({ order, serverNow, lane, onAdvance, onItemAdvance, busy }) {
  const orderedAt = new Date(order.ordered_at).getTime();
  const nowMs = new Date(serverNow).getTime();
  const ageSeconds = Math.max(0, Math.round((nowMs - orderedAt) / 1000));
  const ageClass = classifyAge(ageSeconds);

  const tableLabel = order.table_id ? `T${order.table_id.slice(0, 4)}` : "Pickup";

  return (
    <div className={`kds-card age-${ageClass}`}>
      <div className="kds-card-head">
        <div>
          <div className="kds-card-number">#{order.order_number ?? "—"}</div>
          <div className="kds-card-table">{tableLabel}</div>
        </div>
        <div className={`kds-card-age ${ageClass}`}>{formatAge(ageSeconds)}</div>
      </div>

      <div className="kds-card-pills">
        <span className={`kds-pill ${order.payment_status === "paid" ? "paid" : "unpaid"}`}>
          {order.payment_status === "paid" ? "PAID" : "UNPAID"}
        </span>
        <span className="kds-pill source">{order.source}</span>
      </div>

      {order.special_instructions ? (
        <div className="kds-card-notes">★ {order.special_instructions}</div>
      ) : null}

      <div className="kds-card-items">
        {order.items.map((item) => (
          <div key={item.id} className="kds-card-item">
            <div className="kds-card-item-line">
              <div className="kds-card-item-qty">{item.quantity}×</div>
              <div className="kds-card-item-name">
                {item.name_snapshot}
                {item.variant_name_snapshot ? (
                  <span className="kds-card-item-variant"> — {item.variant_name_snapshot}</span>
                ) : null}
              </div>
              <button
                type="button"
                className={`kds-card-item-tick ${item.status === "ready" || item.status === "served" ? "done" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onItemAdvance(order, item);
                }}
                disabled={busy || item.status === "served"}
                aria-label={`Mark ${item.name_snapshot} ready`}
              >
                ✓
              </button>
            </div>
            {item.modifiers.length > 0 ? (
              <div className="kds-card-item-mods">
                + {item.modifiers.map((m) => m.name_snapshot).join(", ")}
              </div>
            ) : null}
            {item.special_requests ? (
              <div className="kds-card-item-special">! {item.special_requests}</div>
            ) : null}
          </div>
        ))}
      </div>

      <button
        type="button"
        className="kds-card-action"
        onClick={() => onAdvance(order, lane.next)}
        disabled={busy}
      >
        {lane.actionLabel}
      </button>
    </div>
  );
}

function Board({ orders, serverNow, onAdvance, onItemAdvance, busyOrderIds }) {
  const grouped = useMemo(() => {
    const map = new Map(LANES.map((lane) => [lane.key, []]));
    for (const order of orders) {
      const lane = LANES.find((l) => l.statuses.includes(order.status));
      if (lane) map.get(lane.key).push(order);
    }
    return map;
  }, [orders]);

  return (
    <div className="kds-board">
      {LANES.map((lane) => {
        const laneOrders = grouped.get(lane.key) ?? [];
        return (
          <section key={lane.key} className="kds-lane" aria-label={lane.title}>
            <header className={`kds-lane-header ${lane.key}`}>
              <span>{lane.title}</span>
              <span className="kds-lane-count">{laneOrders.length}</span>
            </header>
            <div className="kds-lane-list">
              {laneOrders.length === 0 ? (
                <div className="kds-empty">No orders</div>
              ) : (
                laneOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    serverNow={serverNow}
                    lane={lane}
                    onAdvance={onAdvance}
                    onItemAdvance={onItemAdvance}
                    busy={busyOrderIds.has(order.id)}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function KdsApp({ user }) {
  const [orders, setOrders] = useState([]);
  const [serverNow, setServerNow] = useState(new Date().toISOString());
  const [stale, setStale] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [audioReady, setAudioReady] = useState(isAudioUnlocked());
  const [toast, setToast] = useState(null);
  const busyOrderIds = useRef(new Set());
  const [, forceTick] = useState(0);
  const previousIds = useRef(new Set());

  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast((current) => (current === text ? null : current)), 3000);
  }, []);

  const refresh = useCallback(async ({ pollAttempt = 0 } = {}) => {
    try {
      const data = await listActiveOrders();
      // Detect new pending orders for the ding.
      const newPending = (data.orders ?? [])
        .filter((o) => o.status === "pending")
        .map((o) => o.id);
      const previousSet = previousIds.current;
      const hasNewOrder = newPending.some((id) => !previousSet.has(id));
      if (hasNewOrder) ding();
      previousIds.current = new Set(newPending);

      setOrders(data.orders ?? []);
      setServerNow(data.server_now ?? new Date().toISOString());
      setStale(false);
      return 0;
    } catch (error) {
      if (error.status === 401) {
        showToast("Signed out — touch to reconnect.");
      } else {
        setStale(true);
      }
      const nextAttempt = Math.min(POLL_BACKOFF_MAX_MS, (pollAttempt + 1) * POLL_INTERVAL_MS);
      return nextAttempt;
    }
  }, [showToast]);

  // Poll loop with backoff. Pauses on tab hidden, resumes on focus.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let attempt = 0;

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      const wait = await refresh({ pollAttempt: attempt });
      attempt = wait > 0 ? attempt + 1 : 0;
      timer = setTimeout(tick, wait > 0 ? wait : POLL_INTERVAL_MS);
    };

    tick();
    const onVisibility = () => {
      if (!document.hidden && !cancelled) {
        if (timer) clearTimeout(timer);
        attempt = 0;
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // Heartbeat. Independent of the poll loop because we want a ping even on
  // long stretches with no orders.
  useEffect(() => {
    const interval = setInterval(() => sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    sendHeartbeat();
    return () => clearInterval(interval);
  }, []);

  // Online/offline banner.
  useEffect(() => subscribeOnlineStatus(setOnline), []);

  // 1-Hz redraw so age tickers update without re-fetching.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const advance = useCallback(async (order, nextStatus) => {
    if (busyOrderIds.current.has(order.id)) return;
    busyOrderIds.current.add(order.id);
    // Optimistic update so the card moves immediately.
    setOrders((prev) =>
      prev.map((o) => (o.id === order.id ? { ...o, status: nextStatus } : o))
    );
    try {
      const updated = await updateOrderStatus(order.id, nextStatus, order.version);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
      // Served orders disappear after a brief delay.
      if (nextStatus === "served") {
        setTimeout(() => {
          setOrders((prev) => prev.filter((o) => o.id !== order.id));
        }, 600);
      }
    } catch (error) {
      // 409: someone else updated this order — refresh.
      if (error.status === 409) {
        showToast("Updated by another tablet — refreshing.");
        refresh();
      } else if (error.status === 428) {
        showToast("Stale version. Refreshing.");
        refresh();
      } else {
        showToast("Couldn't update. Retrying.");
        refresh();
      }
    } finally {
      busyOrderIds.current.delete(order.id);
    }
  }, [refresh, showToast]);

  const advanceItem = useCallback(async (order, item) => {
    if (busyOrderIds.current.has(order.id)) return;
    if (item.status === "served") return;
    const nextItemStatus = item.status === "ready" ? "served" : "ready";
    busyOrderIds.current.add(order.id);
    setOrders((prev) =>
      prev.map((o) =>
        o.id === order.id
          ? {
              ...o,
              items: o.items.map((i) =>
                i.id === item.id ? { ...i, status: nextItemStatus } : i
              )
            }
          : o
      )
    );
    try {
      const updated = await updateOrderItemStatus(order.id, item.id, nextItemStatus, order.version);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
    } catch (error) {
      if (error.status === 409 || error.status === 428) {
        showToast("Updated by another tablet — refreshing.");
      } else {
        showToast("Couldn't update item.");
      }
      refresh();
    } finally {
      busyOrderIds.current.delete(order.id);
    }
  }, [refresh, showToast]);

  const handleUnlockAudio = useCallback(async () => {
    await unlockAudio();
    setAudioReady(isAudioUnlocked());
  }, []);

  const visibleOrders = orders;

  return (
    <div className="kds-app" onClick={audioReady ? undefined : handleUnlockAudio}>
      <header className="kds-topbar">
        <div className="kds-brand">
          <span className="kds-brand-dot" aria-hidden="true" />
          Natalia's Kitchen
        </div>
        <div className="kds-topbar-meta">
          <span>{visibleOrders.length} active</span>
          <span>{user?.email ?? "kiosk"}</span>
        </div>
      </header>

      {!online ? (
        <div className="kds-banner kds-banner-offline">OFFLINE — showing last known orders</div>
      ) : stale ? (
        <div className="kds-banner kds-banner-stale">Reconnecting…</div>
      ) : null}

      {!audioReady ? (
        <button type="button" className="kds-banner kds-banner-audio" onClick={handleUnlockAudio}>
          Tap anywhere to enable sound
        </button>
      ) : null}

      <Board
        orders={visibleOrders}
        serverNow={serverNow}
        onAdvance={advance}
        onItemAdvance={advanceItem}
        busyOrderIds={busyOrderIds.current}
      />

      {toast ? <div className="kds-toast">{toast}</div> : null}
    </div>
  );
}

function SignInScreen() {
  return (
    <div className="kds-signin">
      <div className="kds-brand">
        <span className="kds-brand-dot" />
        Natalia's Kitchen
      </div>
      <p>Sign in with the kitchen kiosk Google account.</p>
      <button type="button" className="kds-signin-btn" onClick={() => signInWithGoogle()}>
        Sign in with Google
      </button>
    </div>
  );
}

function Root() {
  const [user, setUser] = useState(auth.currentUser);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (next) => {
      setUser(next);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  if (authLoading) {
    return (
      <div className="kds-loading">
        <div className="kds-brand">
          <span className="kds-brand-dot" />
          Natalia's Kitchen
        </div>
        <p>Loading…</p>
      </div>
    );
  }

  if (!user) return <SignInScreen />;

  return <KdsApp user={user} />;
}

registerServiceWorker();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>
);
