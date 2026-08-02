import assert from "node:assert/strict";
import test from "node:test";

import { tomorrowInTz, todayInTz, utcIsoToZonedWallClock, zonedWallClockToUtcISO } from "./time";

const SYD = "Australia/Sydney";

// Australian DST: starts the first Sunday in October (02:00 → 03:00), ends the
// first Sunday in April (03:00 → 02:00). In 2026 that is 4 Oct and 5 Apr.
// Before the fix, the offset was sampled ~10 hours after the instant being
// solved for, so every booking in the window leading up to each changeover was
// converted using the offset from the wrong side of the transition.

test("converts a normal AEST evening correctly", () => {
  // October 3 is still AEST (+10): 19:00 local → 09:00Z the same day.
  assert.equal(zonedWallClockToUtcISO("2026-10-03", "19:00", SYD), "2026-10-03T09:00:00.000Z");
});

test("converts a normal AEDT evening correctly", () => {
  // April 4 is still AEDT (+11): 19:00 local → 08:00Z the same day.
  assert.equal(zonedWallClockToUtcISO("2026-04-04", "19:00", SYD), "2026-04-04T08:00:00.000Z");
});

test("uses the new offset immediately after each changeover", () => {
  // After the spring-forward, Sydney is AEDT (+11).
  assert.equal(zonedWallClockToUtcISO("2026-10-04", "19:00", SYD), "2026-10-04T08:00:00.000Z");
  // After the fall-back, Sydney is AEST (+10).
  assert.equal(zonedWallClockToUtcISO("2026-04-05", "19:00", SYD), "2026-04-05T09:00:00.000Z");
});

test("every half-hour slot around both 2026 changeovers round-trips", () => {
  // This is the regression that matters: 42 contiguous slots used to come back
  // an hour out — the whole Saturday dinner service, twice a year.
  for (const start of ["2026-10-03", "2026-04-04"]) {
    const [y, m, d] = start.split("-").map(Number);
    for (let slot = 0; slot < 96; slot += 1) {
      const at = new Date(Date.UTC(y!, m! - 1, d!, 0, 0) + slot * 30 * 60 * 1000);
      const date = at.toISOString().slice(0, 10);
      const time = at.toISOString().slice(11, 16);

      const utc = zonedWallClockToUtcISO(date, time, SYD);
      const back = utcIsoToZonedWallClock(utc, SYD);

      // Times inside a spring-forward gap do not exist, so they are allowed to
      // land later than requested — but never earlier, which was the old bug.
      const requested = `${date} ${time}`;
      const returned = `${back.date} ${back.time}`;
      assert.ok(
        returned >= requested,
        `${requested} in Sydney came back as ${returned} — earlier than requested`
      );
    }
  }
});

test("an ambiguous time resolves to the earlier of its two instants", () => {
  // 02:30 on 5 Apr 2026 happens twice: once as AEDT (+11), once as AEST (+10).
  // Convention (Postgres and most libraries) is to take the first occurrence.
  assert.equal(zonedWallClockToUtcISO("2026-04-05", "02:30", SYD), "2026-04-04T15:30:00.000Z");
});

test("a nonexistent time lands after the gap, never before it", () => {
  // 02:30 on 4 Oct 2026 is skipped entirely — the clock jumps 02:00 → 03:00.
  // The old code silently returned 01:30, i.e. an hour EARLIER than asked for.
  const utc = zonedWallClockToUtcISO("2026-10-04", "02:30", SYD);
  const back = utcIsoToZonedWallClock(utc, SYD);
  assert.equal(back.date, "2026-10-04");
  assert.ok(back.time >= "03:00", `expected a time at or after 03:00, got ${back.time}`);
});

test("tomorrow is the next calendar day across both changeovers", () => {
  // The 23-hour day. 13:00Z is 23:00 on 3 Oct in Sydney (AEST +10). Adding a
  // fixed 24h landed on 5 October, skipping the 4th entirely.
  const beforeSpringForward = new Date("2026-10-03T13:00:00Z");
  assert.equal(todayInTz(SYD, beforeSpringForward), "2026-10-03");
  assert.equal(tomorrowInTz(SYD, beforeSpringForward), "2026-10-04");

  // The 25-hour day. 13:30Z is 00:30 on 5 Apr in Sydney (still AEDT +11).
  // Adding a fixed 24h landed back on 5 April — the same date as today — so
  // the agent would offer "tomorrow" and book today.
  const duringFallBack = new Date("2026-04-04T13:30:00Z");
  assert.equal(todayInTz(SYD, duringFallBack), "2026-04-05");
  assert.equal(tomorrowInTz(SYD, duringFallBack), "2026-04-06");
});

test("tomorrow rolls over month and year boundaries", () => {
  assert.equal(tomorrowInTz(SYD, new Date("2026-01-31T12:00:00Z")), "2026-02-01");
  assert.equal(tomorrowInTz(SYD, new Date("2026-12-31T12:00:00Z")), "2027-01-01");
});

test("today and tomorrow are always one day apart, and never equal", () => {
  for (const iso of [
    "2026-10-03T13:00:00Z",
    "2026-10-03T14:00:00Z",
    "2026-04-04T13:00:00Z",
    "2026-04-04T14:00:00Z",
    "2026-06-15T00:00:00Z"
  ]) {
    const now = new Date(iso);
    const today = todayInTz(SYD, now);
    const tomorrow = tomorrowInTz(SYD, now);
    assert.notEqual(today, tomorrow, `today and tomorrow both ${today} at ${iso}`);

    const [ty, tm, td] = today.split("-").map(Number);
    const expected = new Date(Date.UTC(ty!, tm! - 1, td! + 1)).toISOString().slice(0, 10);
    assert.equal(tomorrow, expected, `tomorrow after ${today} should be ${expected}`);
  }
});
