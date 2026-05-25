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
