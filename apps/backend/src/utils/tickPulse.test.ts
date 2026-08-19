/**
 * The worker's vital signs.
 *
 * A worker whose ticks silently no-op looks identical to a healthy one from the
 * outside — this snapshot is what tells them apart on /workerz, so the counting
 * and the last-tick age have to be right. State is module-scoped (one worker
 * process), so each case uses a unique worker name and injects timestamps
 * rather than reading the clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  recordTick,
  registerTickExpectation,
  STALE_INTERVAL_MULTIPLE,
  stalledWorkers,
  tickPulseSnapshot
} from "./tickPulse";

function snapshotFor(worker: string, now: number) {
  return tickPulseSnapshot(now).find((entry) => entry.worker === worker);
}

test("first tick registers the worker with a count of one", () => {
  recordTick("pulse-test-first", 1_000);
  const entry = snapshotFor("pulse-test-first", 1_000);
  assert.equal(entry?.ticks, 1);
  assert.equal(entry?.last_tick_ms_ago, 0);
});

test("repeated ticks accumulate and last_tick_ms_ago tracks the newest tick", () => {
  recordTick("pulse-test-accum", 1_000);
  recordTick("pulse-test-accum", 2_500);
  recordTick("pulse-test-accum", 4_000);
  const entry = snapshotFor("pulse-test-accum", 9_000);
  assert.equal(entry?.ticks, 3);
  assert.equal(entry?.last_tick_ms_ago, 5_000);
});

test("workers are reported independently", () => {
  recordTick("pulse-test-a", 100);
  recordTick("pulse-test-b", 200);
  recordTick("pulse-test-b", 300);
  assert.equal(snapshotFor("pulse-test-a", 300)?.ticks, 1);
  assert.equal(snapshotFor("pulse-test-b", 300)?.ticks, 2);
});

test("a worker that has never ticked is absent from the snapshot", () => {
  assert.equal(snapshotFor("pulse-test-never", 0), undefined);
});

// ---------------------------------------------------------------------------
// Staleness. Recording ticks was never the hard part — deciding that a worker
// has stopped is, and /workerz answered 200 unconditionally until it could.
// ---------------------------------------------------------------------------

const INTERVAL = 1_000;
const STALE_AFTER = INTERVAL * STALE_INTERVAL_MULTIPLE;

test("a registered worker ticking on schedule is not stale", () => {
  registerTickExpectation("pulse-stale-healthy", INTERVAL, 0);
  recordTick("pulse-stale-healthy", 9_000);
  const entry = snapshotFor("pulse-stale-healthy", 9_500);
  assert.equal(entry?.stale, false);
  assert.equal(entry?.expected_interval_ms, INTERVAL);
  assert.ok(!stalledWorkers(9_500).includes("pulse-stale-healthy"));
});

test("a registered worker that stops ticking goes stale and is named", () => {
  registerTickExpectation("pulse-stale-wedged", INTERVAL, 0);
  recordTick("pulse-stale-wedged", 1_000);
  const justBefore = 1_000 + STALE_AFTER;
  assert.equal(snapshotFor("pulse-stale-wedged", justBefore)?.stale, false,
    "exactly at the threshold is still healthy — the check must not flap");
  const after = justBefore + 1;
  assert.equal(snapshotFor("pulse-stale-wedged", after)?.stale, true);
  assert.ok(stalledWorkers(after).includes("pulse-stale-wedged"));
});

test("a worker that registers and then never ticks at all goes stale", () => {
  // The wedge-on-first-tick case: without a registration baseline this worker
  // would have no pulse and look infinitely healthy.
  registerTickExpectation("pulse-stale-bornDead", INTERVAL, 0);
  const entry = snapshotFor("pulse-stale-bornDead", STALE_AFTER + 1);
  assert.equal(entry?.ticks, 0);
  assert.equal(entry?.stale, true);
  assert.ok(stalledWorkers(STALE_AFTER + 1).includes("pulse-stale-bornDead"));
});

test("a worker that never registered an interval is never judged stale", () => {
  // Flag-disabled workers never call registerTickExpectation, so a disabled
  // feature must not make the health endpoint report a stall.
  recordTick("pulse-stale-unregistered", 0);
  const entry = snapshotFor("pulse-stale-unregistered", 10_000_000);
  assert.equal(entry?.expected_interval_ms, null);
  assert.equal(entry?.stale, false);
  assert.ok(!stalledWorkers(10_000_000).includes("pulse-stale-unregistered"));
});

test("a slow worker on a long interval is not stale just because the clock moved", () => {
  // cleanup ticks every 6h. A one-size threshold would flag it constantly.
  const sixHours = 6 * 60 * 60 * 1000;
  registerTickExpectation("pulse-stale-slow", sixHours, 0);
  recordTick("pulse-stale-slow", sixHours);
  assert.equal(snapshotFor("pulse-stale-slow", sixHours * 3)?.stale, false);
});
