/**
 * In-memory rolling-window counter of Retell auth failures (401/403 on any
 * `/retell/*` path).
 *
 * Why this exists: a wrong / stale / non-webhook-badged `RETELL_API_KEY`
 * makes `assertRetellSignature` reject EVERY signed Retell request with a
 * 401 in a few ms. The call still connects, the agent still talks — but every
 * tool call (check_availability, create_booking, menu_lookup, create_order)
 * bounces at the signature gate, so NO booking is ever written. This failure
 * is otherwise invisible: handled AppErrors weren't logged, and the caller
 * hears a normal-sounding agent. This counter feeds `healthAlerter` so the
 * failure pages ops instead of silently dropping bookings.
 *
 * Single-process, in-memory — resets on container restart. That's the same
 * trade-off the rest of healthAlerter makes and is fine for a single-tenant
 * deploy.
 */

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETAINED = 512; // hard cap so a sustained storm can't grow unbounded

let failureTimestamps: number[] = [];
let lastFailureAt: number | null = null;

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  // Drop anything outside the window. Filter is cheap at these volumes; the
  // MAX_RETAINED cap is the real backstop against an unbounded storm.
  const oldest = failureTimestamps[0];
  if (oldest !== undefined && oldest < cutoff) {
    failureTimestamps = failureTimestamps.filter((t) => t >= cutoff);
  }
}

/** Record one 401/403 on the signed Retell surface. */
export function recordRetellAuthFailure(at: number = Date.now()): void {
  failureTimestamps.push(at);
  lastFailureAt = at;
  prune(at);
  if (failureTimestamps.length > MAX_RETAINED) {
    failureTimestamps = failureTimestamps.slice(-MAX_RETAINED);
  }
}

export interface RetellAuthSnapshot {
  failures_last_5min: number;
  last_failure_at: string | null;
  window_ms: number;
}

/** Snapshot of auth failures inside the rolling window. */
export function retellAuthSnapshot(now: number = Date.now()): RetellAuthSnapshot {
  prune(now);
  return {
    failures_last_5min: failureTimestamps.length,
    last_failure_at: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
    window_ms: WINDOW_MS
  };
}

/** Test/diagnostic helper — clears the window. */
export function resetRetellAuthFailures(): void {
  failureTimestamps = [];
  lastFailureAt = null;
}
