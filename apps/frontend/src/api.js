import { auth, signOutUser } from "./firebase";
import { captureException } from "./sentry";
import { readStorageKey, writeStorageKey } from "./lib/storageKeys";
import { fetchLegalDocumentsManifest } from "./lib/legalDocuments";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3050";

// Active restaurant (multi-tenant). Persisted to localStorage so a reload keeps
// the selection; sent as X-Restaurant-Id on every authed request. The backend
// validates it against the user's membership (a spoofed id → 403), so this is
// only a selector, never a trust boundary.
const ACTIVE_RESTAURANT_KEY = "activeRestaurantId";

export function getActiveRestaurantId() {
  return readStorageKey(ACTIVE_RESTAURANT_KEY);
}

export function setActiveRestaurantId(id) {
  writeStorageKey(ACTIVE_RESTAURANT_KEY, id || null);
}

// A hung connection must never pin a busy/disabled button forever: every request
// gets a deadline. 30s covers the slow paths we actually have (menu ingest
// registration, Stripe session creation) with headroom; the backend's own
// statement_timeout is 15s, so anything past this is the network, not work.
const REQUEST_TIMEOUT_MS = 30_000;

async function callOnce(path, options, forceFresh) {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken(forceFresh) : null;
  // The stored selection is a convenience for tenant-scoped reads. On the
  // restaurant-create call it is semantically wrong (there is no tenant yet —
  // a stale id from a previous session would ride along), so it is stripped.
  const activeRestaurantId =
    path === "/api/onboarding/restaurant" ? null : getActiveRestaurantId();

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(activeRestaurantId ? { "X-Restaurant-Id": activeRestaurantId } : {})
  };

  return fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

// White-screens reach Sentry via the render boundary; the 500s and dead
// networks that CAUSE them previously reached nobody. Server faults (5xx),
// timeouts and network failures are reported here with method + path only —
// never headers, bodies or tokens. Expected application errors (4xx: validation,
// auth expiry, membership checks) are the UI's job and stay out of Sentry.
function reportApiFailure(error, path, options, status) {
  try {
    captureException(error, {
      api_path: path.split("?")[0],
      method: options.method ?? "GET",
      ...(status ? { status } : {})
    });
  } catch {
    /* reporting must never break the request path */
  }
}

async function authedFetch(path, options = {}) {
  let response;
  try {
    response = await callOnce(path, options, false);
  } catch (networkError) {
    reportApiFailure(networkError, path, options);
    throw networkError;
  }

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

  // A just-verified account can race Firebase's claim propagation: the backend
  // rejects with 403 EMAIL_NOT_VERIFIED while the cached token still carries
  // email_verified: false. Force-refresh once — the fresh token has the new
  // claim. A second 403 falls through to normal error handling (no loop).
  if (response.status === 403 && auth.currentUser) {
    const peek = await response.clone().json().catch(() => null);
    if (peek?.error?.code === "EMAIL_NOT_VERIFIED") {
      response = await callOnce(path, options, true);
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
        window.dispatchEvent(new Event("voxtable:memberships-changed"));
      }
      if (response.status >= 500) reportApiFailure(err, path, options, response.status);
      throw err;
    }
    const err = new Error(`${response.status} ${response.statusText}: ${body}`);
    if (response.status >= 500) reportApiFailure(err, path, options, response.status);
    throw err;
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

// Representative contact details captured at signup (name, mobile) — persisted
// once the account is verified. See flushPendingSignup in auth.jsx.
export function submitContact(payload) {
  return authedFetch(`/api/me/contact`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
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

export async function getAgreement() {
  const [agreement, legalDocuments] = await Promise.all([
    authedFetch(`/api/onboarding/agreement`),
    fetchLegalDocumentsManifest()
  ]);
  return { ...agreement, ...legalDocuments };
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

export function setVoicePaused(paused) {
  return authedFetch(`/api/restaurant/voice/${paused ? "pause" : "resume"}`, {
    method: "POST"
  });
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
// Pages are rendered and uploaded to Firebase Storage first (see
// lib/menuImportPrepare.js and firebase.js uploadMenuPage);
// these endpoints register/track/commit the parse job.

// `source_urls` is one entry per rendered page, in menu order. The backend also
// still accepts the old single `source_url`, which is what keeps an older cached
// client working while a deploy rolls out.
export function startMenuIngestion({ source_urls, source_kind, sha256 }) {
  return authedFetch(`/api/menu/ingest`, {
    method: "POST",
    body: JSON.stringify({ source_urls, source_kind, sha256 })
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

export function listTables({ date } = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/tables${tail}`);
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

// Recording audio comes through the backend's authenticated proxy — the raw
// vendor URL is a public link and never reaches the browser (#173). An <audio>
// element can't send a Bearer header, so fetch the bytes here and hand back an
// object URL. Caller must URL.revokeObjectURL it on unmount.
export async function fetchCallRecordingObjectUrl(id) {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : null;
  const activeRestaurantId = getActiveRestaurantId();
  const response = await fetch(`${API_BASE_URL}/api/call-logs/${id}/recording`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(activeRestaurantId ? { "X-Restaurant-Id": activeRestaurantId } : {})
    }
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "The recording is no longer available."
        : "Couldn't load the recording."
    );
  }
  return URL.createObjectURL(await response.blob());
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

/** The venue's service state right now — one round trip, role-shaped. */
export function getHomeSummary() {
  return authedFetch("/api/home/summary");
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

export function listActiveOrders({ tableId } = {}) {
  const qs = new URLSearchParams();
  if (tableId) qs.set("table_id", tableId);
  const tail = qs.toString() ? `?${qs}` : "";
  return authedFetch(`/api/orders/active${tail}`);
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

// Stripe Connect payouts (guest payments). Status for the Billing page card;
// refresh=true pulls live capability state from Stripe after onboarding.
export function getConnectStatus({ refresh } = {}) {
  return authedFetch(`/api/billing/connect${refresh ? "?refresh=1" : ""}`);
}

// Returns { url } for the Stripe-hosted Connect onboarding flow.
export function createConnectOnboardingLink() {
  return authedFetch("/api/billing/connect/onboarding-link", { method: "POST" });
}

// Texts the guest a payment link for an order (front-of-house resend surface).
export function sendOrderPaymentLink(orderId) {
  return authedFetch(`/api/orders/${orderId}/payment-link`, { method: "POST" });
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

// ===== Platform admin (BitePerk staff, cross-tenant) =====
// All of these hit /api/admin/* — email-allowlist gated server-side
// (DASHBOARD_ADMIN_EMAILS). A stray X-Restaurant-Id header is harmless: the
// admin router never resolves a tenant.

export function getAdminOnboardingHealth() {
  return authedFetch(`/api/admin/onboarding-health`);
}

export function getAdminProvisioningQueue() {
  return authedFetch(`/api/admin/provisioning-queue`);
}

export function getAdminRestaurants({ status, q, limit, offset } = {}) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  if (limit) params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return authedFetch(`/api/admin/restaurants${suffix}`);
}

export function getAdminRestaurant(id) {
  return authedFetch(`/api/admin/restaurants/${id}`);
}

export function getAdminRestaurantSubscription(id) {
  return authedFetch(`/api/admin/restaurants/${id}/subscription`);
}

// `version` is the venue's concurrency token from GET /api/admin/restaurants/:id.
// Sent as If-Match so a drawer left open while someone else re-binds the same
// venue is refused with 409 STALE_WRITE rather than quietly winning.
export function adminBindProvisioning(id, payload, version) {
  return authedFetch(`/api/admin/restaurants/${id}/provisioning`, {
    method: "PATCH",
    headers: version ? { "If-Match": version } : undefined,
    body: JSON.stringify(payload)
  });
}

export function adminUnbindProvisioning(id, payload, version) {
  return authedFetch(`/api/admin/restaurants/${id}/unbind`, {
    method: "POST",
    headers: version ? { "If-Match": version } : undefined,
    body: JSON.stringify(payload)
  });
}

export function adminGoLive(id, version) {
  return authedFetch(`/api/admin/restaurants/${id}/go-live`, {
    method: "POST",
    headers: version ? { "If-Match": version } : undefined
  });
}

export function adminSetVoicePaused(id, paused) {
  return authedFetch(`/api/admin/restaurants/${id}/voice/${paused ? "pause" : "resume"}`, {
    method: "POST"
  });
}

export function adminSetVoicePaused(id, paused) {
  return authedFetch(`/api/admin/restaurants/${id}/voice/${paused ? "pause" : "resume"}`, {
    method: "POST"
  });
}

export function getAdminProvisioningJobs(status) {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return authedFetch(`/api/admin/provisioning-jobs${suffix}`);
}

export function adminReenqueueJob(id, payload) {
  return authedFetch(`/api/admin/provisioning-jobs/${id}/re-enqueue`, {
    method: "POST",
    body: JSON.stringify(payload ?? {})
  });
}

export function getAdminOpsSummary() {
  return authedFetch(`/api/admin/ops-summary`);
}

export function getAdminActivity() {
  return authedFetch(`/api/admin/activity`);
}

export function getAdminFlags() {
  return authedFetch(`/api/admin/flags`);
}

export function getAdminActions(limit = 25) {
  return authedFetch(`/api/admin/actions?limit=${limit}`);
}

export function getAdminNeedsAttention() {
  return authedFetch(`/api/admin/needs-attention`);
}

export function adminRetryNotification(id) {
  return authedFetch(`/api/admin/notifications/${id}/retry`, { method: "POST" });
}

export function adminRerunMenuImport(id) {
  return authedFetch(`/api/admin/menu-imports/${id}/rerun`, { method: "POST" });
}

export function getAdminSupportRequests(status) {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return authedFetch(`/api/admin/support-requests${suffix}`);
}

export function adminSetSupportStatus(id, status) {
  return authedFetch(`/api/admin/support-requests/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}
