// Pure display formatters shared across dashboard pages. No React, no I/O —
// just data → string/row shaping. Label maps live in ./constants.
import { INTENT_LABEL, OUTCOME_LABEL, LIVE_THRESHOLD_MS } from "./constants";

export function centsToDollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}
export function dollarsToCents(value) {
  const n = Math.round(parseFloat(value) * 100);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function humanizeIntent(row) {
  if (row.intent && INTENT_LABEL[row.intent]) return INTENT_LABEL[row.intent];
  if (row.reservation_id) return "Booking";
  if (row.summary) return row.summary.slice(0, 40);
  return "Inbound call";
}

export function humanizeOutcome(o) {
  return OUTCOME_LABEL[o] ?? o;
}

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function relativeTime(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function mapCallLogToRow(row, index) {
  const ended = !!row.ended_at;
  const started = row.started_at ? new Date(row.started_at) : new Date(row.created_at);
  const recent = Date.now() - started.getTime() < LIVE_THRESHOLD_MS;
  const isLive = !ended && recent;
  const status = isLive ? "live" : row.transferred_to_staff ? "transferred" : "handled";
  const durationSec =
    typeof row.duration_seconds === "number"
      ? row.duration_seconds
      : ended
        ? Math.max(0, Math.round((new Date(row.ended_at) - started) / 1000))
        : null;
  const tones = ["neutral", "secondary", "tertiary"];

  return {
    id: row.id,
    name: row.caller_phone ? "Caller" : "Unknown Caller",
    initials: null,
    phone: row.caller_phone ?? "Unknown",
    status,
    intent: humanizeIntent(row),
    duration: durationSec != null ? formatDuration(durationSec) : "—",
    time: started.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: true }),
    timeNote: relativeTime(started),
    avatarTone: tones[index % tones.length]
  };
}

// Retell delivers transcript either as plain text or as a JSON-encoded array of
// { role: 'agent' | 'user', content: string }. Best-effort parser.
export function parseTranscript(raw) {
  if (!raw) return [];
  // JSON array path
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const role = entry.role ?? entry.speaker;
          const text = entry.content ?? entry.text ?? entry.message;
          if (!text) return null;
          return { speaker: role === "agent" || role === "ai" ? "ai" : "guest", text };
        })
        .filter(Boolean);
    }
  } catch {
    // not JSON, fall through to plain-text parser
  }
  // Plain text: split on "Agent:" / "User:" markers Retell uses
  const out = [];
  const lines = String(raw).split(/\n+/).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^\s*(Agent|User|Aria|Bella|Caller)\s*:\s*(.*)$/i);
    if (m) {
      const role = m[1].toLowerCase();
      out.push({
        speaker: role === "agent" || role === "aria" || role === "bella" ? "ai" : "guest",
        text: m[2].trim()
      });
    } else if (out.length > 0) {
      out[out.length - 1].text += " " + line.trim();
    } else {
      out.push({ speaker: "ai", text: line.trim() });
    }
  }
  return out;
}

export function mapReservationToRow(row) {
  const statusToneMap = {
    confirmed: "confirmed",
    cancelled: "cancelled",
    seated: "seated",
    completed: "confirmed",
    no_show: "no_show"
  };
  const statusLabelMap = {
    confirmed: "Confirmed",
    cancelled: "Cancelled",
    seated: "Seated",
    completed: "Completed",
    no_show: "No-show"
  };
  return {
    id: row.id,
    dateLabel: formatReservationDate(row.reservation_date),
    timeLabel: formatVoiceTime12h(row.start_time),
    guest: row.customer_name || "Unknown",
    phone: formatPhoneDisplay(row.customer_phone),
    party: row.party_size,
    status: statusLabelMap[row.status] ?? row.status,
    statusTone: statusToneMap[row.status] ?? "confirmed",
    note: row.notes || (row.source === "voice" ? "Booked via phone" : `Booked via ${row.source}`),
    muted: row.status === "cancelled" || row.status === "no_show"
  };
}

export function formatReservationDate(isoDateOrString) {
  if (!isoDateOrString) return "—";
  // PG DATE columns serialise as either "2026-05-27" or full ISO.
  const ymd = String(isoDateOrString).slice(0, 10);
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  });
}

export function formatVoiceTime12h(timeStr) {
  if (!timeStr) return "";
  const [hStr, mStr] = String(timeStr).split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h)) return String(timeStr);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatPhoneDisplay(raw) {
  if (!raw) return "";
  // +61450011140 → "+61 450 011 140"
  const m = String(raw).match(/^(\+\d{1,3})(\d{3})(\d{3})(\d{3,4})$/);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(raw);
}

export function formatRefreshedAgo(date) {
  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `Refreshed ${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  return `Refreshed ${m}m ago`;
}

export function decorateDailySeries(rawSeries) {
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return rawSeries.map((row) => {
    const [y, m, d] = row.date.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return {
      key: row.date,
      label: dayLabels[date.getUTCDay()],
      shortDate: `${monthLabels[date.getUTCMonth()]} ${date.getUTCDate()}`,
      total: row.total ?? 0,
      confirmed: row.confirmed ?? 0
    };
  });
}

export function formatInvoiceDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "—";
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    day: "numeric", month: "short", year: "numeric"
  });
}
