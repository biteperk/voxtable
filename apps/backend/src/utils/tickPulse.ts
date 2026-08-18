/**
 * Per-worker tick pulse — the worker process's own vital signs.
 *
 * A worker whose ticks all silently no-op looks identical to a healthy one
 * from the outside; there was no surface that could tell them apart. Every
 * tick already flows through withTickLogContext (PR #92), so recording a
 * timestamp there gives us last-tick-at and a counter per worker for free.
 * The worker's health endpoint serves this snapshot — same process, so plain
 * module state is correct here (unlike the cross-process ops_state).
 *
 * Recording alone was not enough. /workerz published this data and then
 * answered 200 unconditionally, so a permanently wedged worker — an outbox
 * tick hung inside an open transaction, say — was indistinguishable from a
 * healthy one to any probe that reads status codes, and nothing else read the
 * pulse either. Workers now REGISTER their expected tick interval when they
 * start, which is the piece that makes "late" a decidable question.
 *
 * Registration happens at start(), after every early return, so a worker that
 * no-ops behind a disabled feature flag is never judged for not ticking.
 */

interface Pulse {
  ticks: number;
  lastTickAt: number;
}

interface Expectation {
  intervalMs: number;
  /** Baseline for staleness before the first tick lands. */
  registeredAt: number;
}

const pulses = new Map<string, Pulse>();
const expectations = new Map<string, Expectation>();

/**
 * How many missed ticks before a worker is called stalled. Deliberately
 * generous: one slow tick under load must not flap the health endpoint, and
 * the failure this catches is a permanent wedge, not a late tick.
 */
export const STALE_INTERVAL_MULTIPLE = 5;

export function recordTick(worker: string, at: number = Date.now()): void {
  const pulse = pulses.get(worker);
  if (pulse) {
    pulse.ticks += 1;
    pulse.lastTickAt = at;
  } else {
    pulses.set(worker, { ticks: 1, lastTickAt: at });
  }
}

/** Called by each worker's start() once it has genuinely begun ticking. */
export function registerTickExpectation(
  worker: string,
  intervalMs: number,
  at: number = Date.now()
): void {
  expectations.set(worker, { intervalMs, registeredAt: at });
}

export interface TickPulseEntry {
  worker: string;
  ticks: number;
  last_tick_ms_ago: number;
  /** null when the worker records ticks but never registered an interval. */
  expected_interval_ms: number | null;
  stale: boolean;
}

export function tickPulseSnapshot(now: number = Date.now()): TickPulseEntry[] {
  const workers = new Set([...pulses.keys(), ...expectations.keys()]);
  return [...workers].map((worker) => {
    const pulse = pulses.get(worker);
    const expectation = expectations.get(worker);
    // Before the first tick, measure from registration — otherwise a worker
    // that started and immediately wedged would look infinitely healthy.
    const since = pulse
      ? now - pulse.lastTickAt
      : expectation
        ? now - expectation.registeredAt
        : 0;
    return {
      worker,
      ticks: pulse?.ticks ?? 0,
      last_tick_ms_ago: since,
      expected_interval_ms: expectation?.intervalMs ?? null,
      stale: expectation ? since > expectation.intervalMs * STALE_INTERVAL_MULTIPLE : false
    };
  });
}

/** Workers that registered an interval and have missed too many ticks. */
export function stalledWorkers(now: number = Date.now()): string[] {
  return tickPulseSnapshot(now)
    .filter((entry) => entry.stale)
    .map((entry) => entry.worker);
}

export function resetTickPulseForTests(): void {
  pulses.clear();
  expectations.clear();
}
