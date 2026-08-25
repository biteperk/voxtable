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

// SMS-friendly date: "Fri 28 Aug". Kept strictly GSM-7 (no punctuation beyond
// spaces) so confirmation texts stay a single 160-char segment.
const monthAbbrevs = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatSmsDate(date: string): string {
  const parts = date.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) return date;
  const dayName = getDayName(date);
  const dayAbbrev = dayName.charAt(0).toUpperCase() + dayName.slice(1, 3);
  return `${dayAbbrev} ${day} ${monthAbbrevs[month - 1] ?? ""}`.trim();
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

  let h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  // Intl quirk: some runtimes format midnight as "24" rather than "00" (same
  // guard tzOffsetMsAt below carries). A "24:xx" here would silently fail
  // every `now < until` window comparison.
  if (h === "24") h = "00";
  return `${h}:${m}`;
}

/**
 * Daily availability window check for menu items ("breakfast 07:00–12:00").
 *
 * All arguments are wall-clock in the same (restaurant) timezone. `from`/
 * `until` accept "HH:MM" or Postgres TIME's "HH:MM:SS" — only the first two
 * segments count. NULL on either side means unbounded on that side; both NULL
 * means always available. Semantics:
 *   - start-inclusive, end-EXCLUSIVE (`from <= now < until`) — at 12:00:00
 *     the 07:00–12:00 breakfast menu is over;
 *   - from > until wraps midnight (happy hour 16:00–02:00 spans the evening
 *     leg [16:00, 24:00) and the morning leg [00:00, 02:00));
 *   - from === until is a degenerate zero-length window: never available
 *     (mirrors isWithinOpeningHours' closed-all-day case).
 */
export function isWithinDailyWindow(
  nowHm: string,
  from: string | null,
  until: string | null
): boolean {
  if (!from && !until) return true;
  const now = toMinutes(nowHm);
  const start = from ? toMinutes(from) : null;
  const end = until ? toMinutes(until) : null;

  if (start !== null && end !== null) {
    if (start === end) return false;
    if (start < end) return now >= start && now < end;
    // Wraps midnight.
    return now >= start || now < end;
  }
  if (start !== null) return now >= start;
  return now < (end as number);
}

export function todayInTz(timeZone: string, now: Date = new Date()): string {
  return ymdInTz(now, timeZone);
}

// Stripe hands back Unix epoch SECONDS. Format as YYYY-MM-DD in the restaurant's
// tz so a late-night-UTC paid_at doesn't render as the wrong calendar day on a
// tax invoice (avoids the naive `.toISOString().slice(0,10)` off-by-one).
export function unixSecondsToYmd(seconds: number, timeZone: string): string {
  return ymdInTz(new Date(seconds * 1000), timeZone);
}

export function tomorrowInTz(timeZone: string, now: Date = new Date()): string {
  // Calendar arithmetic, NOT "+24 hours". A DST day is 23 or 25 hours long, so
  // adding a fixed 24h skipped a date every October (23h day) and returned the
  // SAME date as today every April (25h day) — the agent would then offer
  // "tomorrow" and book today. Date.UTC handles month/year rollover for us.
  const [y, m, d] = ymdInTz(now, timeZone).split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

export function nowTimeInTz(timeZone: string, now: Date = new Date()): string {
  return hmInTz(now, timeZone);
}

/** Calendar-arithmetic date shift, DST-safe for the same reason tomorrowInTz is. */
function addDaysToYmd(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + days));
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * One sentence the voice agent can speak VERBATIM about whether the venue is
 * open right now's calendar day — injected per call as the `today_status`
 * dynamic variable so the LLM never has to derive open/closed from the hours
 * table mid-call (a real caller heard "Yeah, we're open today — actually,
 * we're closed" while it worked that out aloud, and a booking ask for a closed
 * night cost a needless check_availability round trip).
 *
 * Returns "" when the venue has no hours configured — the prompt treats an
 * empty variable as "don't make claims about hours".
 */
export function formatTodayStatus(
  openingHours: OpeningHours,
  timeZone: string,
  now: Date = new Date()
): string {
  const today = todayInTz(timeZone, now);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const todayWindows = getOpeningWindowsForDate(today, openingHours);

  if (todayWindows.length > 0) {
    const spans = todayWindows
      .map((w) => `${formatVoiceTime(w.open)} to ${formatVoiceTime(w.close)}`)
      .join(" and ");
    return `OPEN today (${cap(getDayName(today))}), ${spans}.`;
  }

  for (let i = 1; i <= 7; i++) {
    const d = addDaysToYmd(today, i);
    const windows = getOpeningWindowsForDate(d, openingHours);
    if (windows.length > 0) {
      const when = i === 1 ? `tomorrow (${cap(getDayName(d))})` : cap(getDayName(d));
      return `CLOSED today (${cap(getDayName(today))}). Next open ${when} from ${formatVoiceTime(windows[0]!.open)}.`;
    }
  }

  return "";
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
 * Given a real instant, return the timezone's offset from UTC at that instant,
 * in milliseconds (+10h for AEST, +11h for AEDT). Derived by formatting the
 * instant in the zone and reading the result back as if it were UTC.
 */
function tzOffsetMsAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(instant));
  const y = parts.find((p) => p.type === "year")?.value;
  const mo = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  let h = parts.find((p) => p.type === "hour")?.value;
  const mi = parts.find((p) => p.type === "minute")?.value;
  // Intl quirk: some zones format midnight as "24" rather than "00".
  if (h === "24") h = "00";
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return asUtc - instant;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Convert "YYYY-MM-DD" + "HH:MM" + IANA timezone → UTC ISO 8601.
 *
 * The offset must be evaluated at the INSTANT WE ARE SOLVING FOR, not at the
 * wall clock treated as UTC. The previous version did the latter, which sits
 * 10–11 hours later in Sydney; whenever a DST changeover fell inside that gap
 * it applied the offset from the wrong side of the transition. Every booking in
 * a ~10-hour window before each changeover — the whole Saturday dinner service,
 * twice a year — was mirrored to Cal.com an hour out.
 *
 * So: build the candidate instants implied by the offsets either side of a
 * possible transition, and keep the ones that actually format back to the
 * requested wall clock.
 *   - exactly one survivor  → the normal case
 *   - two survivors         → an ambiguous time (clocks went back; it happened
 *                             twice). Take the earlier, which is the convention
 *                             Postgres and the common libraries follow.
 *   - none                  → a nonexistent time (clocks went forward and this
 *                             wall clock was skipped). Shift forward past the
 *                             gap rather than silently landing an hour BEFORE
 *                             the requested time, which is what used to happen.
 *
 * Throws if the date/time are unparseable.
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

  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);

  // Offsets sampled a day either side cover any transition near this wall clock.
  const offsets = new Set([
    tzOffsetMsAt(wallAsUtc - 24 * HOUR_MS, timeZone),
    tzOffsetMsAt(wallAsUtc, timeZone),
    tzOffsetMsAt(wallAsUtc + 24 * HOUR_MS, timeZone)
  ]);

  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = wallAsUtc - offset;
    // Round-trip: does this instant actually read back as the wall clock asked for?
    if (tzOffsetMsAt(candidate, timeZone) === offset) valid.push(candidate);
  }

  if (valid.length > 0) {
    return new Date(Math.min(...valid)).toISOString();
  }

  // Nonexistent wall clock (inside a spring-forward gap). Use the offset in
  // effect AFTER the transition, which maps the request to the first real
  // instant at or past the time that was asked for.
  const afterGap = wallAsUtc - Math.min(...offsets);
  return new Date(afterGap).toISOString();
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
