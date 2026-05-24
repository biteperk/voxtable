import { auth } from "./firebase";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3050";

async function authedFetch(path, options = {}) {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : null;

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

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
