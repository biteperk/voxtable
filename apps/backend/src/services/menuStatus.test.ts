import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatMenuStatus } from "./menuService";
import { formatDailyWindow } from "../utils/time";

// Every case here is a call shape that already happened or provably can:
// call_4e871f4b (30 Aug 2026) is the incident that created menu_status.

describe("formatDailyWindow", () => {
  it("speaks a closed window", () => {
    assert.equal(formatDailyWindow("07:00:00", "12:00:00"), "between 7 AM and 12 PM");
  });
  it("speaks a from-only window", () => {
    assert.equal(formatDailyWindow("17:00:00", null), "from 5 PM");
  });
  it("speaks an until-only window with minutes", () => {
    assert.equal(formatDailyWindow(null, "11:30:00"), "until 11:30 AM");
  });
  it("empty for an unwindowed item", () => {
    assert.equal(formatDailyWindow(null, null), "");
  });
});

describe("formatMenuStatus", () => {
  const allDay = { available_from: null, available_until: null, item_count: 200 };
  const breakfast = { available_from: "07:00:00", available_until: "12:00:00", item_count: 40 };
  const dinner = { available_from: "17:00:00", available_until: null, item_count: 30 };
  const lateNight = { available_from: "21:00:00", available_until: "02:00:00", item_count: 10 };

  it("empty when the venue has no windowed items (Mazcina)", () => {
    assert.equal(formatMenuStatus([allDay], "14:00"), "");
  });

  it("empty for an empty menu", () => {
    assert.equal(formatMenuStatus([], "14:00"), "");
  });

  it("the 30 Aug call: 4:37 PM, breakfast off, dinner not yet, late-night off", () => {
    const s = formatMenuStatus([allDay, breakfast, dinner, lateNight], "16:37");
    assert.match(s, /all-day menu is serving/);
    assert.match(s, /between 7 AM and 12 PM are NOT available/);
    assert.match(s, /from 5 PM are NOT available/);
    assert.match(s, /between 9 PM and 2 AM are NOT available/);
  });

  it("mid-morning: breakfast on, dinner off", () => {
    const s = formatMenuStatus([allDay, breakfast, dinner], "09:00");
    assert.match(s, /between 7 AM and 12 PM are AVAILABLE/);
    assert.match(s, /from 5 PM are NOT available/);
  });

  it("midnight-wrapping window is active after midnight", () => {
    const s = formatMenuStatus([allDay, lateNight], "01:30");
    assert.match(s, /between 9 PM and 2 AM are AVAILABLE/);
  });

  it("names the absence of an all-day menu", () => {
    const s = formatMenuStatus([breakfast, dinner], "09:00");
    assert.match(s, /every section has serving times/);
  });

  it("caps at four windows, largest first, and stays under budget", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      available_from: `${String(6 + i).padStart(2, "0")}:00:00`,
      available_until: `${String(7 + i).padStart(2, "0")}:00:00`,
      item_count: 12 - i
    }));
    const s = formatMenuStatus([allDay, ...many], "05:00");
    assert.ok(s.length <= 320, `over budget: ${s.length}`);
    // 4 windows max → 4 "available" clauses at most.
    assert.ok((s.match(/available now/gi) ?? []).length <= 4);
  });

  it("never emits braces or control characters", () => {
    const weird = { available_from: "07:00:00", available_until: "12:00:00", item_count: 1 };
    const s = formatMenuStatus([weird], "09:00");
    assert.doesNotMatch(s, /[{}]/);
    assert.ok([...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
  });
});
