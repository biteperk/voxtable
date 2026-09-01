/**
 * When a pre-ordered dish should reach the pass.
 *
 * Bella could already take a pre-order against a booking, but nothing recorded
 * when it was wanted, so every order was due immediately: a pre-order taken at
 * 11am for a 7pm table hit the pass at 11am, dinged the kitchen, went red in
 * fifteen minutes and paged ops with a stale-ticket alert. The tray was ready
 * eight hours early.
 *
 * The arithmetic is pure so the DST edges can be tested without a database.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { computeFireAt } from "./orderService";

const SYD = "Australia/Sydney";
const localTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-AU", { timeZone: SYD, hour: "numeric", minute: "2-digit" });

test("the kitchen starts a lead time before the guest arrives", () => {
  assert.equal(localTime(computeFireAt("2026-06-12", "19:00:00", SYD, 15)), "6:45 pm");
  assert.equal(localTime(computeFireAt("2026-06-12", "19:00:00", SYD, 90)), "5:30 pm");
});

test("a zero lead fires exactly at the booking time", () => {
  assert.equal(computeFireAt("2026-06-12", "19:00:00", SYD, 0), "2026-06-12T09:00:00.000Z");
});

test("a TIME column with seconds is accepted", () => {
  // Postgres hands back "19:00:00"; zonedWallClockToUtcISO wants "19:00".
  assert.equal(
    computeFireAt("2026-06-12", "19:00:00", SYD, 15),
    computeFireAt("2026-06-12", "19:00", SYD, 15)
  );
});

test("the lead is subtracted in real time, not on the wall clock", () => {
  // Sydney's DST transitions: first Sunday of October (forward) and of April
  // (back). Subtracting minutes from a wall-clock string instead of from the
  // resolved instant lands an hour out on these two days each year.
  assert.equal(localTime(computeFireAt("2026-10-04", "19:00:00", SYD, 15)), "6:45 pm");
  assert.equal(localTime(computeFireAt("2026-04-05", "19:00:00", SYD, 15)), "6:45 pm");
});

test("a lead can cross back over midnight into the previous day", () => {
  const fire = computeFireAt("2026-06-13", "00:10:00", SYD, 15);
  assert.equal(localTime(fire), "11:55 pm");
  assert.ok(fire < "2026-06-13", "must land on the previous UTC day");
});

test("the venue's own timezone decides the instant", () => {
  // The same wall-clock booking is a different instant in a different venue.
  assert.notEqual(
    computeFireAt("2026-06-12", "19:00:00", SYD, 15),
    computeFireAt("2026-06-12", "19:00:00", "Australia/Perth", 15)
  );
});
