import { auth } from "./firebase";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3050";

// Tablet identity persists across reboots so the heartbeat tells us which
// device went silent, not just "a tablet".
const TABLET_ID_KEY = "kds-tablet-id";
function getTabletId() {
  let id = localStorage.getItem(TABLET_ID_KEY);
  if (!id) {
    id = (crypto?.randomUUID?.() ?? `tablet-${Math.random().toString(36).slice(2, 10)}`);
    localStorage.setItem(TABLET_ID_KEY, id);
  }
  return id;
}
export const TABLET_ID = getTabletId();

async function callOnce(path, options, forceFresh) {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken(forceFresh) : null;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  return fetch(`${API_BASE_URL}${path}`, { ...options, headers });
}

export async function authedFetch(path, options = {}) {
  let response = await callOnce(path, options, false);
  if (response.status === 401 && auth.currentUser) {
    response = await callOnce(path, options, true);
    if (response.status === 401) {
      // Kiosk: don't auto-sign-out on a single hiccup. Surface a sign-in
      // overlay so a manager can re-auth without losing the order view.
      const err = new Error("AUTH_EXPIRED");
      err.status = 401;
      throw err;
    }
  }
  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`${response.status}: ${body}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  if (response.status === 204) return null;
  return response.json();
}

export function listActiveOrders() {
  // Scheduled pre-orders too: the kitchen needs to see what is coming so a
  // tray can be ready on arrival, not just what is due right now.
  return authedFetch("/api/orders/active?include_upcoming=true");
}

export function updateOrderStatus(orderId, status, version) {
  return authedFetch(`/api/orders/${orderId}/status`, {
    method: "PATCH",
    headers: { "If-Match": String(version) },
    body: JSON.stringify({ status })
  });
}

export function updateOrderItemStatus(orderId, itemId, status, version) {
  return authedFetch(`/api/orders/${orderId}/items/${itemId}/status`, {
    method: "PATCH",
    headers: { "If-Match": String(version) },
    body: JSON.stringify({ status })
  });
}

export function sendHeartbeat() {
  return authedFetch(`/api/ops/kds-heartbeat?tablet_id=${encodeURIComponent(TABLET_ID)}`, {
    method: "POST",
    body: JSON.stringify({ tablet_id: TABLET_ID })
  }).catch(() => null);
}
