import { OpeningHours, OpeningWindow } from "../domain/types";

const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function toMinutes(time: string): number {
  const [hoursPart, minutesPart] = time.split(":");
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  return hours * 60 + minutes;
}

export function fromMinutes(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export function getDayName(date: string): string {
  const parts = date.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  if (!year || !month || !day) {
    return "sunday";
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return dayNames[utcDate.getUTCDay()] ?? "sunday";
}

export function isWithinOpeningHours(
  date: string,
  time: string,
  durationMinutes: number,
  openingHours: OpeningHours
): boolean {
  const windows = getOpeningWindowsForDate(date, openingHours);
  const start = toMinutes(time);
  const end = start + durationMinutes;

  // Audit M2: handle windows that cross midnight (e.g. open 18:00, close 02:00).
  // When close <= open we treat the window as wrapping; the booking must fit
  // fully in either the evening leg `[open, 24:00)` or the morning leg
  // `[00:00, close)`.
  return windows.some((window) => {
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);

    if (close > open) {
      // Same-day window (the common case).
      return start >= open && end <= close;
    }

    if (close === open) {
      // Degenerate "closed all day" — never satisfied.
      return false;
    }

    // close < open → wraps midnight. Evening leg accepts bookings starting at
    // or after `open`; the booking can spill past midnight up to `close+1440`.
    // Morning leg accepts bookings starting before `open` and ending by `close`.
    const closeAcrossMidnight = close + 1440;
    if (start >= open) {
      return end <= closeAcrossMidnight;
    }
    return end <= close;
  });
}

export function getOpeningWindowsForDate(date: string, openingHours: OpeningHours): OpeningWindow[] {
  const day = getDayName(date);
  return openingHours[day] ?? [];
}

export function formatVoiceTime(time: string): string {
  const [hourPart, minutePart] = time.split(":");
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;

  if (minute === 0) {
    return `${hour12} ${suffix}`;
  }

  return `${hour12}:${minute.toString().padStart(2, "0")} ${suffix}`;
}

// --- TZ-aware helpers (Phase 9 hardening) ------------------------------------
// Restaurants store dates + times as wall-clock (DATE + TIME, TZ-naive). The
// LLM gets explicit "today in <tz>" and "tomorrow in <tz>" via dynamic vars so
// it never has to guess what "tomorrow" means from its own server clock.

function ymdInTz(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function hmInTz(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

export function todayInTz(timeZone: string, now: Date = new Date()): string {
  return ymdInTz(now, timeZone);
}

export function tomorrowInTz(timeZone: string, now: Date = new Date()): string {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return ymdInTz(tomorrow, timeZone);
}

export function nowTimeInTz(timeZone: string, now: Date = new Date()): string {
  return hmInTz(now, timeZone);
}

export function dayNameInTz(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" })
    .format(now)
    .toLowerCase();
}

// --- UTC <-> wall-clock conversion (Cal.com integration) ---------------------
// Our reservations table stores TZ-naive wall-clock (DATE + TIME). External
// APIs (Cal.com, iCal) expect ISO 8601 with offset. Hand-rolled conversion
// avoids pulling in date-fns-tz / Temporal. DST-safe: tz offset is recomputed
// per call so AEST/AEDT switching is transparent.

/**
 * Convert "YYYY-MM-DD" + "HH:MM" + IANA timezone → UTC ISO 8601.
 *
 * Algorithm (the canonical Intl trick):
 *   1. Build an "as-if-UTC" timestamp from the wall-clock parts.
 *   2. Format it BACK in the target tz — this tells us the wall-clock that
 *      our assumed-UTC moment would have in that tz.
 *   3. The difference between the requested wall-clock and the formatted one
 *      is the tz offset. Apply it.
 *
 * Throws if the date/time/tz are unparseable.
 */
export function zonedWallClockToUtcISO(date: string, time: string, timeZone: string): string {
  const ymd = date.split("-").map(Number);
  const hm = time.split(":").map(Number);
  const year = ymd[0];
  const month = ymd[1];
  const day = ymd[2];
  const hour = hm[0] ?? 0;
  const minute = hm[1] ?? 0;
  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Invalid date/time: ${date} ${time}`);
  }

  // Step 1: as-if-UTC.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);

  // Step 2: format that moment in the target tz.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(utcGuess));
  const y = parts.find((p) => p.type === "year")?.value;
  const mo = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  let h = parts.find((p) => p.type === "hour")?.value;
  const mi = parts.find((p) => p.type === "minute")?.value;
  // Intl quirk: some tz format hour as "24" at midnight rather than "00".
  if (h === "24") h = "00";

  // Step 3: compute the offset by parsing the tz-formatted wall-clock as UTC
  // and diffing against our assumed-UTC.
  const formattedAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const offset = utcGuess - formattedAsUtc;
  return new Date(utcGuess + offset).toISOString();
}

/**
 * Inverse of `zonedWallClockToUtcISO`. Given a UTC ISO 8601 string and an IANA
 * tz, return { date: "YYYY-MM-DD", time: "HH:MM" } in that tz.
 */
export function utcIsoToZonedWallClock(
  utcIso: string,
  timeZone: string
): { date: string; time: string } {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid UTC ISO: ${utcIso}`);
  return { date: ymdInTz(d, timeZone), time: hmInTz(d, timeZone) };
}
