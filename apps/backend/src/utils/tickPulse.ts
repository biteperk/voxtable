/**
 * Per-worker tick pulse — the worker process's own vital signs.
 *
 * A worker whose ticks all silently no-op looks identical to a healthy one
 * from the outside; there was no surface that could tell them apart. Every
 * tick already flows through withTickLogContext (PR #92), so recording a
 * timestamp there gives us last-tick-at and a counter per worker for free.
 * The worker's health endpoint serves this snapshot — same process, so plain
 * module state is correct here (unlike the cross-process ops_state).
 */

interface Pulse {
  ticks: number;
  lastTickAt: number;
}

const pulses = new Map<string, Pulse>();

export function recordTick(worker: string, at: number = Date.now()): void {
  const pulse = pulses.get(worker);
  if (pulse) {
    pulse.ticks += 1;
    pulse.lastTickAt = at;
  } else {
    pulses.set(worker, { ticks: 1, lastTickAt: at });
  }
}

export function tickPulseSnapshot(
  now: number = Date.now()
): Array<{ worker: string; ticks: number; last_tick_ms_ago: number }> {
  return [...pulses.entries()].map(([worker, pulse]) => ({
    worker,
    ticks: pulse.ticks,
    last_tick_ms_ago: now - pulse.lastTickAt
  }));
}
