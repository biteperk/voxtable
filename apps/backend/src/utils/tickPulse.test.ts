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

import { recordTick, tickPulseSnapshot } from "./tickPulse";

function snapshotFor(worker: string, now: number): { ticks: number; last_tick_ms_ago: number } | undefined {
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
