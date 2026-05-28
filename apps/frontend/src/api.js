import { auth } from "./firebase";
import { signOutUser } from "./firebase";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3050";

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

async function authedFetch(path, options = {}) {
  let response = await callOnce(path, options, false);

  // If the cached Firebase ID token expired (1h TTL), force-refresh and retry once.
  if (response.status === 401 && auth.currentUser) {
    response = await callOnce(path, options, true);
    if (response.status === 401) {
      // Refresh didn't help — the user really is unauthorised. Sign them out
      // so the app re-prompts via the LoginScreen rather than dumping a 401
      // error blob on screen.
      await signOutUser().catch(() => {});
      throw new Error("Session expired — please sign in again.");
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  return response.json();
}

export function listReservations({ date, limit } = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (limit) qs.set("limit", String(limit));
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/reservations${tail}`);
}

export function listTables() {
  return authedFetch(`/api/tables`);
}

export function listCallLogs({ limit } = {}) {
  const qs = new URLSearchParams();
  if (limit) qs.set("limit", String(limit));
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/call-logs${tail}`);
}

export function getCallLog(id) {
  return authedFetch(`/api/call-logs/${id}`);
}

export function getAnalytics({ days } = {}) {
  const qs = new URLSearchParams();
  if (days) qs.set("days", String(days));
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/analytics${tail}`);
}

export function getAnalyticsDailySeries({ days } = {}) {
  const qs = new URLSearchParams();
  if (days) qs.set("days", String(days));
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/analytics/daily-series${tail}`);
}

// /bookings/:id and /bookings/:id/cancel are auth-protected on the backend
// (requireFirebaseAuth gated by env.DASHBOARD_VERIFY_AUTH). authedFetch below
// already attaches the Firebase ID token as Bearer.

export function createReservation(payload) {
  return authedFetch(`/bookings`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateReservationStatus(id, status) {
  return authedFetch(`/bookings/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}

export function cancelReservation(id, reason) {
  return authedFetch(`/bookings/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {})
  });
}

export function seatReservation(id) {
  return authedFetch(`/bookings/${id}/seat`, { method: "POST" });
}

export function completeReservation(id) {
  return authedFetch(`/bookings/${id}/complete`, { method: "POST" });
}

// ===== Kitchen / menu / orders =====

export function getMenu() {
  return authedFetch("/api/menu");
}

export function createMenuCategory(payload) {
  return authedFetch("/api/menu/categories", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateMenuCategory(id, payload) {
  return authedFetch(`/api/menu/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function deleteMenuCategory(id) {
  return authedFetch(`/api/menu/categories/${id}`, { method: "DELETE" });
}

export function createMenuItem(payload) {
  return authedFetch("/api/menu/items", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateMenuItem(id, payload) {
  return authedFetch(`/api/menu/items/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function deleteMenuItem(id) {
  return authedFetch(`/api/menu/items/${id}`, { method: "DELETE" });
}

export function listActiveOrders() {
  return authedFetch("/api/orders/active");
}

export function updateOrderStatus(id, status, version, cancellationReason) {
  return authedFetch(`/api/orders/${id}/status`, {
    method: "PATCH",
    headers: { "If-Match": String(version) },
    body: JSON.stringify(cancellationReason ? { status, cancellation_reason: cancellationReason } : { status })
  });
}

export function updateOrderPayment(id, paymentStatus, version) {
  return authedFetch(`/api/orders/${id}/payment`, {
    method: "PATCH",
    headers: { "If-Match": String(version) },
    body: JSON.stringify({ payment_status: paymentStatus })
  });
}
