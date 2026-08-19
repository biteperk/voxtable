/**
 * Low-level HTTP client for the Cal.com v2 API.
 *
 * Why this lives separately from `calcomService`:
 *   - Forces a single place where every Cal.com call goes through the same
 *     timeout, retry-classification, and circuit-breaker logic.
 *   - Makes it trivial to swap for a mock in smoke tests (just stub `request`).
 *   - Keeps the higher-level service free of HTTP transport concerns.
 *
 * Error taxonomy:
 *   - `CalcomTransientError` — 5xx, 429, or network/timeout. Caller should
 *     leave the outbox row pending so the worker retries with backoff.
 *   - `CalcomPermanentError`  — 4xx (except 429). Caller should mark the
 *     outbox row failed; retrying won't help (bad payload, missing field, …).
 *
 * Circuit breaker:
 *   - Module memory is the working copy; ops_state is the durable copy. Every
 *     transition writes through (best-effort), and the first Cal.com call
 *     after a process start hydrates from the stored row — so a restart
 *     mid-outage resumes with the breaker open instead of hammering a down
 *     Cal.com from a fresh "closed".
 *   - Opens after 10 consecutive transient failures inside a 60 s window.
 *   - Stays open for 60 s, then enters half-open. The next call probes; if it
 *     succeeds the breaker closes, otherwise it opens again.
 *
 * Nothing in this file mutates Cal.com data — that's `calcomService`. This is
 * pure plumbing.
 */

import { env } from "../config/env";
import { logger } from "../utils/logger";
import { getOpsState, setOpsState } from "../repositories/opsState";
import { recordCalcomRequest } from "./calcomQuotaTracker";

export class CalcomTransientError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "CalcomTransientError";
  }
}

export class CalcomPermanentError extends Error {
  constructor(public readonly status: number, public readonly body: string, message: string) {
    super(message);
    this.name = "CalcomPermanentError";
  }
}

export class CalcomCircuitOpenError extends CalcomTransientError {
  constructor() {
    super(null, "Cal.com circuit breaker is open; refusing call");
    this.name = "CalcomCircuitOpenError";
  }
}

// --- Circuit breaker state (module-scoped, in-memory) -------------------------

type BreakerState = "closed" | "open" | "half-open";

const BREAKER_FAILURE_THRESHOLD = 10;
const BREAKER_FAILURE_WINDOW_MS = 60_000;
const BREAKER_OPEN_DURATION_MS = 60_000;

let breakerState: BreakerState = "closed";
let consecutiveFailures = 0;
let firstFailureAt: number | null = null;
let openedAt: number | null = null;

function shouldShortCircuit(): boolean {
  if (breakerState === "closed") return false;
  if (breakerState === "open") {
    if (openedAt !== null && Date.now() - openedAt >= BREAKER_OPEN_DURATION_MS) {
      breakerState = "half-open";
      return false; // allow ONE probe through
    }
    return true;
  }
  // half-open: let the probe through (caller will record outcome).
  return false;
}

function recordSuccess(): void {
  const wasOpenOrHalf = breakerState !== "closed";
  consecutiveFailures = 0;
  firstFailureAt = null;
  if (wasOpenOrHalf) {
    breakerState = "closed";
    openedAt = null;
    // Audit L3: log breaker recovery so ops can correlate with Cal.com outages.
    logger.info({ evt: "calcom_breaker_closed" });
    mirrorBreakerState();
  }
}

function recordTransientFailure(): void {
  const now = Date.now();

  // A failure while half-open means the single probe call failed — Cal.com is
  // still unhealthy. Re-open immediately (the documented "otherwise it opens
  // again" contract). Without this the breaker lingers in half-open and lets
  // every subsequent call through until the failure count rebuilds to the
  // threshold, defeating the point of probing.
  if (breakerState === "half-open") {
    breakerState = "open";
    openedAt = now;
    logger.warn({ evt: "calcom_breaker_reopened", reason: "half_open_probe_failed" });
    mirrorBreakerState();
    return;
  }

  if (firstFailureAt === null || now - firstFailureAt > BREAKER_FAILURE_WINDOW_MS) {
    firstFailureAt = now;
    consecutiveFailures = 1;
  } else {
    consecutiveFailures += 1;
  }
  if (consecutiveFailures >= BREAKER_FAILURE_THRESHOLD && breakerState !== "open") {
    breakerState = "open";
    openedAt = now;
    // Audit L3: log breaker trip. healthAlerter posts to Slack on the next
    // tick; this gives us the structured log line for forensic correlation.
    logger.warn({
      evt: "calcom_breaker_open",
      consecutive_failures: consecutiveFailures,
      window_ms: BREAKER_FAILURE_WINDOW_MS
    });
  }
  mirrorBreakerState();
}

export function getBreakerState(): { state: BreakerState; consecutiveFailures: number; openedAt: number | null } {
  return { state: breakerState, consecutiveFailures, openedAt };
}

// Write-through of the breaker into ops_state. The worker is the only
// process that DRIVES the breaker, so its module state stays the working
// copy; the row serves two readers: /api/ops/calcom-health in the API
// process (whose own breaker instance never trips — the rollback runbook
// used to tell the on-call to trust an endpoint that could not tell the
// truth), and this module's own next incarnation after a restart (see
// hydrateBreakerFromOpsState). Best-effort by design: a breaker that trips
// BECAUSE the network is down must never block, or fail, on another write.
function mirrorBreakerState(): void {
  void setOpsState("calcom-breaker", {
    state: breakerState,
    consecutiveFailures,
    firstFailureAt,
    openedAt
  }).catch((error) => {
    logger.warn({ evt: "calcom_breaker_mirror_failed", error: (error as Error).message });
  });
}

// The restart path: before the first Cal.com call of a process lifetime,
// adopt whatever the previous incarnation last mirrored. Without this, a
// worker restart mid-outage forgot the breaker was open and hammered a down
// Cal.com from a fresh "closed" until the failures rebuilt to threshold.
// Memoized so it costs one DB read per process, and best-effort: if the read
// fails we proceed from "closed" exactly as before this existed.
let hydration: Promise<void> | null = null;

export function hydrateBreakerFromOpsState(): Promise<void> {
  hydration ??= (async () => {
    try {
      const stored = await getOpsState("calcom-breaker");
      if (!stored) return;
      const storedState = stored.state;
      if (storedState !== "closed" && storedState !== "open" && storedState !== "half-open") return;
      breakerState = storedState === "half-open" ? "open" : storedState;
      consecutiveFailures = Number(stored.consecutiveFailures ?? 0);
      firstFailureAt = typeof stored.firstFailureAt === "number" ? stored.firstFailureAt : null;
      openedAt = typeof stored.openedAt === "number" ? stored.openedAt : null;
      // An adopted "open" with no timestamp can never half-open on its own.
      if (breakerState === "open" && openedAt === null) {
        openedAt = Date.now();
      }
      if (breakerState !== "closed") {
        logger.info({ evt: "calcom_breaker_hydrated", state: breakerState, opened_at: openedAt });
      }
    } catch (error) {
      logger.warn({ evt: "calcom_breaker_hydrate_failed", error: (error as Error).message });
    }
  })();
  return hydration;
}

// Exposed only for tests; resets every counter, reopens the gate, and forgets
// the hydration so the next call re-adopts from ops_state — which is also how
// tests simulate a process restart without spawning one.
export function resetBreakerForTests(): void {
  breakerState = "closed";
  consecutiveFailures = 0;
  firstFailureAt = null;
  openedAt = null;
  hydration = null;
}

// --- Request primitive --------------------------------------------------------

export interface CalcomRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;                      // e.g. "/bookings"
  body?: Record<string, unknown>;    // omitted on GET/DELETE
  query?: Record<string, string | number | undefined>;
  /** Bypass auth — used only for health probes that don't need a key. */
  skipAuth?: boolean;
  /** Override the configured timeout for a single call (rare). */
  timeoutMs?: number;
  /**
   * Optional Idempotency-Key. Used by the outbox executor — keying on the
   * outbox row's UUID means a network blip mid-push gets the SAME booking
   * back on retry instead of a duplicate. Cal.com v2 honours the standard
   * Idempotency-Key header per RFC draft.
   */
  idempotencyKey?: string;
  /**
   * Override the `cal-api-version` header for a single call.
   *
   * Cal.com versions PER ENDPOINT, not per API: bookings are pinned below at
   * 2024-08-13, but /event-types is documented at 2024-06-14 and sending the
   * bookings version there is not guaranteed to resolve. A blanket bump of the
   * default would break create and cancel, so the override is per-call and the
   * default stays where every proven call path already is.
   */
  apiVersion?: string;
}

export interface CalcomResponse<T> {
  status: number;
  data: T;
  durationMs: number;
}

/**
 * Send a request to the Cal.com v2 API. Throws CalcomTransientError or
 * CalcomPermanentError; callers should let outbox-worker logic decide retry.
 *
 * No request body validation — the higher-level service builds the payload.
 */
export async function calcomRequest<T = unknown>(options: CalcomRequestOptions): Promise<CalcomResponse<T>> {
  await hydrateBreakerFromOpsState();
  if (shouldShortCircuit()) {
    throw new CalcomCircuitOpenError();
  }

  // URL constructor quirk: `new URL("/bookings", "https://api.cal.com/v2")`
  // resolves to "https://api.cal.com/bookings" because a leading slash on
  // the path is treated as ABSOLUTE and replaces baseUrl's path entirely.
  // Cal.com routes everything under /v2/* — without the prefix you get a
  // NestJS "Cannot POST /bookings" 404. Hand-stitch the URL instead.
  const baseClean = env.CALCOM_BASE_URL.replace(/\/+$/, "");
  const pathClean = options.path.startsWith("/") ? options.path : `/${options.path}`;
  const url = new URL(baseClean + pathClean);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    // Cal.com v2 requires an explicit API version header to avoid silent
    // breakage when they ship a new default. Versioned per endpoint — see
    // CalcomRequestOptions.apiVersion before changing this default.
    "cal-api-version": options.apiVersion ?? "2024-08-13"
  };
  if (options.idempotencyKey) {
    // Standard Idempotency-Key header — Cal.com returns the same booking on a
    // retry with the same key rather than creating a duplicate. Without this,
    // a network blip mid-POST followed by an outbox retry would produce two
    // calendar events for the same reservation.
    headers["idempotency-key"] = options.idempotencyKey;
  }
  if (!options.skipAuth) {
    if (!env.CALCOM_API_KEY) {
      // Defensive: should be enforced by env validation when sync is enabled,
      // but a misconfigured dev box would otherwise produce a confusing 401.
      throw new CalcomPermanentError(
        0,
        "",
        "CALCOM_API_KEY is not configured; cannot call Cal.com (set CALCOM_SYNC_ENABLED=true and provide credentials)."
      );
    }
    headers.authorization = `Bearer ${env.CALCOM_API_KEY}`;
  }

  const timeoutMs = options.timeoutMs ?? env.CALCOM_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    recordTransientFailure();
    // Audit Sweep I: network errors + timeouts still cost a rate-limit slot
    // at Cal.com's edge in most cases; count them so the quota tracker isn't
    // falsely optimistic.
    recordCalcomRequest();
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Cal.com request timed out after ${timeoutMs}ms (${options.method} ${options.path})`
        : `Cal.com network error (${options.method} ${options.path}): ${(error as Error).message}`;
    throw new CalcomTransientError(null, message);
  }
  const durationMs = Date.now() - startedAt;

  // Quota counter — every reply (success or 4xx/5xx) counts against Cal.com's
  // rate limit. Recording AFTER the response confirms a real round-trip.
  recordCalcomRequest();

  // The abort deadline stays ARMED until the body has been consumed.
  //
  // fetch() resolves as soon as the response HEADERS arrive. clearTimeout used
  // to run here, before the read below — so a peer (or a proxy) that sent
  // "200 OK" and then stalled the body left `await response.text()` hanging
  // with no signal, no socket deadline and no statement_timeout to save it,
  // because no query was in flight.
  //
  // That is not a slow request, it is a permanently wedged worker: the outbox
  // executor runs INSIDE an open transaction, so the hang holds FOR UPDATE
  // locks on the claimed rows and a write-pool connection for the life of the
  // container, and tickInFlight never resets. Nothing detected it either —
  // /workerz answered 200 regardless and the depth alert needs 100 queued rows.
  //
  // Best-effort JSON parse — error responses sometimes ship text/plain.
  let rawText: string;
  try {
    rawText = await response.text();
  } catch (error) {
    recordTransientFailure();
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Cal.com response body timed out after ${timeoutMs}ms (${options.method} ${options.path})`
        : `Cal.com response body read failed (${options.method} ${options.path}): ${(error as Error).message}`;
    throw new CalcomTransientError(null, message);
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    // leave parsed as null; downstream gets the raw text in the error body
  }

  if (response.status >= 200 && response.status < 300) {
    recordSuccess();
    return { status: response.status, data: parsed as T, durationMs };
  }

  if (response.status === 429 || response.status >= 500) {
    recordTransientFailure();
    throw new CalcomTransientError(
      response.status,
      `Cal.com transient ${response.status} (${options.method} ${options.path}): ${rawText.slice(0, 200)}`
    );
  }

  // 4xx other than 429 — won't succeed on retry.
  throw new CalcomPermanentError(
    response.status,
    rawText.slice(0, 1000),
    `Cal.com permanent ${response.status} (${options.method} ${options.path}): ${rawText.slice(0, 200)}`
  );
}
