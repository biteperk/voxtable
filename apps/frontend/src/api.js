import { auth, signOutUser } from "./firebase";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3050";

// Active restaurant (multi-tenant). Persisted to localStorage so a reload keeps
// the selection; sent as X-Restaurant-Id on every authed request. The backend
// validates it against the user's membership (a spoofed id → 403), so this is
// only a selector, never a trust boundary.
const ACTIVE_RESTAURANT_KEY = "vocotable.activeRestaurantId";

export function getActiveRestaurantId() {
  try {
    return localStorage.getItem(ACTIVE_RESTAURANT_KEY);
  } catch {
    return null;
  }
}

export function setActiveRestaurantId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_RESTAURANT_KEY, id);
    else localStorage.removeItem(ACTIVE_RESTAURANT_KEY);
  } catch {
    /* localStorage unavailable (private mode) — header just won't be sent */
  }
}

async function callOnce(path, options, forceFresh) {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken(forceFresh) : null;
  const activeRestaurantId = getActiveRestaurantId();

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(activeRestaurantId ? { "X-Restaurant-Id": activeRestaurantId } : {})
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
    // Backend errors are `{ error: { code, message, details } }` (AppError
    // shape). Surface just the human message and attach code/status/details
    // as properties so component-level catches can render alternatives,
    // disable buttons by code, etc. Falls back to raw text on non-JSON 5xx
    // (e.g. nginx HTML pages, network proxies).
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* body wasn't JSON */
    }
    if (parsed && typeof parsed === "object" && parsed.error?.message) {
      const err = new Error(parsed.error.message);
      err.code = parsed.error.code;
      err.details = parsed.error.details;
      err.status = response.status;
      // The stored restaurant id is no longer one of the user's memberships
      // (revoked mid-session). Drop it and let AuthProvider re-pick, otherwise
      // every request keeps failing until a full reload.
      if (response.status === 403 && err.code === "NOT_A_MEMBER") {
        setActiveRestaurantId(null);
        window.dispatchEvent(new Event("vocotable:memberships-changed"));
      }
      throw err;
    }
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }

  // 204 No Content (e.g. DELETE endpoints) has an empty body, so response.json()
  // would throw "Unexpected end of JSON input". Return null instead.
  if (response.status === 204) return null;

  return response.json();
}

// Identity + memberships. Called on app load to learn who the user is and which
// restaurant(s) they can act on. Also lazily provisions the backend users row.
export function getMe() {
  return authedFetch(`/api/me`);
}

// ===== Onboarding =====

export function createRestaurant(payload) {
  return authedFetch(`/api/onboarding/restaurant`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getOnboardingStatus() {
  return authedFetch(`/api/onboarding/status`);
}

export function advanceOnboarding(event) {
  return authedFetch(`/api/onboarding/advance`, {
    method: "POST",
    body: JSON.stringify({ event })
  });
}

export function getAgreement() {
  return authedFetch(`/api/onboarding/agreement`);
}

export function submitAgreement(payload) {
  return authedFetch(`/api/onboarding/agreement`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getPhoneSetup() {
  return authedFetch(`/api/onboarding/phone-setup`);
}

export function verifyForwarding() {
  return authedFetch(`/api/onboarding/verify-forwarding`, { method: "POST" });
}

export function getRestaurantProfile() {
  return authedFetch(`/api/restaurant/profile`);
}

export function updateRestaurantProfile(payload) {
  return authedFetch(`/api/restaurant/profile`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function submitSupportRequest(payload) {
  return authedFetch(`/api/support`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// ===== Menu OCR ingestion (Phase 2) =====
// The file is uploaded to Firebase Storage first (see firebase.js uploadMenuFile);
// these endpoints register/track/commit the parse job.

export function startMenuIngestion({ source_url, source_kind, sha256 }) {
  return authedFetch(`/api/menu/ingest`, {
    method: "POST",
    body: JSON.stringify({ source_url, source_kind, sha256 })
  });
}

export function getMenuIngestion(jobId) {
  return authedFetch(`/api/menu/ingest/${jobId}`);
}

export function saveMenuDraft(jobId, draft) {
  return authedFetch(`/api/menu/ingest/${jobId}/draft`, {
    method: "PATCH",
    body: JSON.stringify(draft)
  });
}

export function commitMenuDraft(jobId) {
  return authedFetch(`/api/menu/ingest/${jobId}/commit`, { method: "POST" });
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

export function listAvailableTables({ date, time, partySize, excludeReservationId } = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (time) qs.set("time", time);
  if (partySize) qs.set("partySize", String(partySize));
  if (excludeReservationId) qs.set("excludeReservationId", excludeReservationId);
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/tables/available${tail}`);
}

export function listManagedTables() {
  return authedFetch(`/api/tables/manage`);
}

export function createTable(payload) {
  return authedFetch(`/api/tables`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// Manager-only edit of a table's display metadata (zone + description). Pass null
// for a field to clear it; omit a field to leave it unchanged.
export function updateTableMeta(id, payload) {
  const body = {};
  for (const key of ["label", "zone", "description", "attributes"]) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  if (payload.minCapacity !== undefined) body.minCapacity = payload.minCapacity;
  if (payload.maxCapacity !== undefined) body.maxCapacity = payload.maxCapacity;
  return authedFetch(`/api/tables/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

export function deactivateTable(id) {
  return authedFetch(`/api/tables/${id}/deactivate`, { method: "POST" });
}

export function activateTable(id) {
  return authedFetch(`/api/tables/${id}/activate`, { method: "POST" });
}

export function deleteTable(id) {
  return authedFetch(`/api/tables/${id}`, { method: "DELETE" });
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

// A range (`from`/`to`, YYYY-MM-DD) selects a calendar month; `days` is the
// legacy rolling window. Range wins when both are passed.
function analyticsQs({ days, from, to } = {}) {
  const qs = new URLSearchParams();
  if (from && to) {
    qs.set("from", from);
    qs.set("to", to);
  } else if (days) {
    qs.set("days", String(days));
  }
  return qs.toString() ? `?${qs}` : "";
}

export function getAnalytics(params = {}) {
  return authedFetch(`/api/analytics${analyticsQs(params)}`);
}

export function getAnalyticsDailySeries(params = {}) {
  return authedFetch(`/api/analytics/daily-series${analyticsQs(params)}`);
}

export function getAnalyticsMonthlySeries({ months } = {}) {
  const qs = new URLSearchParams();
  if (months) qs.set("months", String(months));
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/analytics/monthly-series${tail}`);
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

// ===== Billing (read-only Stripe mirror) =====
// GETs return { enabled, mode, ... }. When billing is disabled/unconfigured the
// backend responds enabled:false with empty data (not an error), so the page
// can distinguish "not configured yet" from "no invoices yet".

export function getBillingInvoices() {
  return authedFetch("/api/billing/invoices");
}

export function getBillingPaymentMethods() {
  return authedFetch("/api/billing/payment-methods");
}

export function getBillingSubscription() {
  return authedFetch("/api/billing/subscription");
}

// Creates a Stripe Customer Portal session and returns { url } to redirect to.
export function createBillingPortalSession() {
  return authedFetch("/api/billing/portal-session", { method: "POST" });
}

// Starts a self-serve subscription (free trial) and returns { url } for the
// Stripe-hosted Checkout page.
export function createBillingCheckoutSession() {
  return authedFetch("/api/billing/checkout-session", { method: "POST" });
}

// ===== Staff management =====

export function getStaffList() {
  return authedFetch("/api/staff");
}

export function inviteStaff({ email, role }) {
  return authedFetch("/api/staff/invite", {
    method: "POST",
    body: JSON.stringify({ email, role })
  });
}

export function updateStaffRole(userId, role) {
  return authedFetch(`/api/staff/${userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role })
  });
}

export function removeStaffMember(userId) {
  return authedFetch(`/api/staff/${userId}`, { method: "DELETE" });
}

export function revokeStaffInvite(inviteId) {
  return authedFetch(`/api/staff/invites/${inviteId}`, { method: "DELETE" });
}

// Public — no auth needed
export function getInviteInfo(token) {
  return fetch(`${API_BASE_URL}/api/staff/invite-info?token=${encodeURIComponent(token)}`).then(
    async (r) => {
      if (!r.ok) {
        const body = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not JSON */ }
        if (parsed?.error?.message) {
          const err = new Error(parsed.error.message);
          err.code = parsed.error.code;
          err.status = r.status;
          throw err;
        }
        throw new Error(`${r.status}: ${body}`);
      }
      return r.json();
    }
  );
}

export function acceptStaffInvite(token) {
  return authedFetch("/api/staff/accept-invite", {
    method: "POST",
    body: JSON.stringify({ token })
  });
}
