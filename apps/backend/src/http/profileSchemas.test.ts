/**
 * Restaurant profile input that can take the phone line down.
 *
 * Two fields on the profile form reached runtime unvalidated, and both fail
 * silently rather than loudly:
 *
 *  - `timezone` went straight to Intl.DateTimeFormat in utils/time.ts. A
 *    plausible-but-wrong zone ("Sydney", "AEST") throws a RangeError there, so
 *    handleRetellInbound threw on EVERY subsequent inbound call — Retell could
 *    not start the call, and the value was memoised so it stayed broken.
 *  - `opening_hours` was z.record(z.string(), …), so any key validated.
 *    {"Monday": …} then resolved to no windows for every day, and
 *    check_availability told callers the restaurant was full when it was empty.
 *
 * DB-free: pure schema parsing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { restaurantProfileSchema } from "./schemas";

const HOURS = [{ open: "10:00", close: "22:00" }];

test("a real IANA zone is accepted", () => {
  for (const timezone of ["Australia/Sydney", "Australia/Brisbane", "UTC", "Europe/London"]) {
    assert.equal(restaurantProfileSchema.safeParse({ timezone }).success, true, timezone);
  }
});

test("plausible-but-invalid zones are refused before they can brick the line", () => {
  // Every one of these throws RangeError inside Intl, which is what utils/time.ts
  // hands the value to on every inbound call.
  for (const timezone of ["Sydney", "AEST", "GMT+10", "Australia/Sydney2", "not a zone"]) {
    const result = restaurantProfileSchema.safeParse({ timezone });
    assert.equal(result.success, false, `${timezone} should be refused`);
  }
});

test("the refusal actually names the field", () => {
  const result = restaurantProfileSchema.safeParse({ timezone: "AEST" });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(
      result.error.issues.some((i) => i.path.includes("timezone")),
      "an owner needs to know which field is wrong"
    );
  }
});

test("lowercase day keys are accepted", () => {
  const opening_hours = {
    monday: HOURS,
    tuesday: HOURS,
    wednesday: HOURS,
    thursday: HOURS,
    friday: HOURS,
    saturday: HOURS,
    sunday: HOURS
  };
  assert.equal(restaurantProfileSchema.safeParse({ opening_hours }).success, true);
});

test("a capitalised or abbreviated day key is refused, not silently ignored", () => {
  // Both of these used to parse cleanly and then close the venue every day of
  // the week, because getOpeningWindowsForDate looks up lowercase names and
  // falls back to [].
  for (const key of ["Monday", "mon", "MONDAY", "lundi"]) {
    const result = restaurantProfileSchema.safeParse({ opening_hours: { [key]: HOURS } });
    assert.equal(result.success, false, `${key} should be refused`);
  }
});

test("a partial week is still allowed — a venue may close on Mondays", () => {
  const result = restaurantProfileSchema.safeParse({
    opening_hours: { tuesday: HOURS, wednesday: HOURS }
  });
  assert.equal(result.success, true);
});

// ---------------------------------------------------------------------------
// The read side. Validation only protects new writes; a row saved before it,
// or written by SQL, must still not kill the phone line.
// ---------------------------------------------------------------------------

test("an unusable stored timezone falls back rather than throwing", async () => {
  const { coerceUsableTimezone } = await import("../repositories/restaurants");
  for (const bad of ["AEST", "Sydney", "GMT+10", ""]) {
    const resolved = coerceUsableTimezone(bad, "restaurant-1");
    assert.equal(resolved, "Australia/Sydney");
    // The point of the fallback: Intl must accept whatever comes back, because
    // utils/time.ts hands it straight over on every inbound call.
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-AU", { timeZone: resolved }));
  }
});

test("a valid stored timezone is returned untouched", () => {
  return import("../repositories/restaurants").then(({ coerceUsableTimezone }) => {
    assert.equal(coerceUsableTimezone("Australia/Brisbane", "restaurant-1"), "Australia/Brisbane");
    assert.equal(coerceUsableTimezone("UTC", "restaurant-1"), "UTC");
  });
});
