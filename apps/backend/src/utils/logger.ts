/**
 * Structured logger with PII + secret redaction baked in.
 *
 * Replaces ad-hoc `console.log/warn/error` calls scattered across the backend.
 * Three guarantees:
 *
 *   1. Single-line JSON output — greppable, machine-parseable, no string
 *      concat surprises. Every line has `level`, `evt`, `ts`, and a
 *      `request_id` (when available via AsyncLocalStorage).
 *
 *   2. PII / secret redaction by default. Two layers:
 *      a. KEY-level: any field whose key ENDS in a sensitive name (phone,
 *         email, token, secret, signature, transcript, special_requests,
 *         caller_name, …) is replaced with "[REDACTED]" entirely.
 *      b. VALUE-level: every string value is scanned for phone-, email-,
 *         JWT- and key-shaped strings; matches are masked in place.
 *
 *   3. No `console.error(error)` foot-gun — passing an Error object spreads
 *      ONLY `name`/`message`/short `stack`, never the whole prototype chain
 *      (which can carry request bodies + auth headers from fetch-style errors).
 *
 * Call from inside a request handler and request_id is automatically attached.
 * Worker ticks run outside any context, so every worker log line carries
 * `request_id: undefined` today — no worker calls `withLogContext`. Per-batch
 * correlation ids are planned platform work; until they land, do not expect a
 * request_id on any line emitted from the worker process.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Request-scoped context (request_id propagation)
// ---------------------------------------------------------------------------

interface LogContext {
  request_id: string;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` inside a fresh logging context. Its ONLY caller today is the
 * requestLogger middleware, which sets request_id at the top of each HTTP
 * handler chain. No worker uses it — worker lines carry
 * `request_id: undefined`. (An earlier version of this comment claimed the
 * outbox worker sets a per-batch id; it never did, and trusting that during
 * an incident would send you hunting for a correlation that does not exist.)
 */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return contextStorage.run(context, fn);
}

export function currentRequestId(): string | undefined {
  return contextStorage.getStore()?.request_id;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Matched against the key with `_`/`-` stripped and lowercased, so
// `caller_phone`, `callerPhone` and `CALLER-PHONE` are one rule. An optional
// leading qualifier means `customer_phone`, `to_email`, `webhook_secret` and
// `x_cal_signature` are covered without listing each one; anchoring the END
// keeps `email_verified` and `tokens_used` readable.
const SENSITIVE_KEY_PATTERN =
  /^[a-z0-9]*(?:phone|phonenumber|email|attendee|attendees|authorization|apikey|token|secret|password|signature|transcript|specialrequest|specialrequests|callername)$/;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.toLowerCase().replace(/[_-]/g, ""));
}

// Patterns that look like real secrets/PII in free-form text.
// - Cal.com API keys: cal_live_<32 hex>
// - Retell API keys:  key_<base62 mix, ~30+ chars>
// - Stripe API keys:  sk_live_/sk_test_/rk_live_/rk_test_<24+ base62>. Must
//   never reach stdout — a leaked secret key is full account access. A
//   StripeAuthenticationError can echo the key it was called with.
// - Stripe webhook secrets: whsec_<base62>. Forging a webhook with this is
//   forging a payment event.
// - Bearer tokens:    "Bearer <anything>" (greedy until whitespace/quote)
// - Bare JWTs:        eyJ… . … . … — a Firebase ID token quoted in an error
//   message arrives without the "Bearer " prefix, so the rule above misses it,
//   and it is a working credential until it expires.
// - Email addresses:  every caller and every dashboard user has one, and they
//   turn up inside error strings ("no membership for sam@example.com").
// - E.164 phones:     +<10-15 digits>
// - AU local phones:  0<digit>XXXXXXXX — mobile (04..) and landline (02/03/07/08..).
//   Audit L5: catches the form libphonenumber sees BEFORE normalisation, e.g.
//   when an error stack quotes the raw input.
// - AU phones with the country code but no plus: 61<9 digits>, the other shape
//   raw caller input arrives in.
//
// Deliberately NOT here: a generic "any 10-15 digit run" rule. It would mask
// epoch milliseconds, order totals in cents and row counts — the numbers an
// incident is actually read with — for phone shapes the four rules above
// already cover.
const REDACTION_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /cal_live_[a-zA-Z0-9]{16,}/g, replacement: "cal_live_[REDACTED]" },
  { regex: /\bkey_[a-zA-Z0-9]{16,}\b/g, replacement: "key_[REDACTED]" },
  {
    regex: /\b(sk|rk)_(live|test)_[a-zA-Z0-9]{16,}\b/g,
    replacement: "$1_$2_[REDACTED]"
  },
  { regex: /\bwhsec_[a-zA-Z0-9]{16,}\b/g, replacement: "whsec_[REDACTED]" },
  { regex: /Bearer\s+[A-Za-z0-9._\-]+/g, replacement: "Bearer [REDACTED]" },
  {
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED-JWT]"
  },
  {
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED-EMAIL]"
  },
  { regex: /\+\d{10,15}\b/g, replacement: "+[REDACTED-PHONE]" },
  { regex: /\b0[234578]\d{8}\b/g, replacement: "[REDACTED-PHONE]" },
  { regex: /\b61[234578]\d{8}\b/g, replacement: "[REDACTED-PHONE]" }
];

function redactString(input: string): string {
  let out = input;
  for (const { regex, replacement } of REDACTION_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}

/**
 * Walk a value (object, array, string, primitive) and return a redacted copy.
 * Replaces sensitive-keyed fields wholesale, masks sensitive substrings inside
 * string values. Cycles are not followed (uses a WeakSet).
 */
function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redact(raw, seen);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error sanitisation
// ---------------------------------------------------------------------------

/**
 * Extract only the safe-to-log fields from an arbitrary error. Never spreads
 * the whole error object (which can contain `error.response.config.headers`
 * with auth tokens or `error.request.body` with request payloads).
 */
function sanitiseError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const err = error as Record<string, unknown>;
  const message = typeof err.message === "string" ? err.message : String(error);
  const stack =
    typeof err.stack === "string"
      ? err.stack.split("\n").slice(0, 8).join("\n")
      : undefined;
  const code = typeof err.code === "string" ? err.code : undefined;
  const status = typeof err.status === "number" ? err.status : undefined;
  return redact({
    name: (err.name as string | undefined) ?? "Error",
    message: message.slice(0, 1000),
    code,
    status,
    stack
  }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Logger surface
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: number =
  LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

function emit(level: LogLevel, fields: Record<string, unknown>): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    request_id: currentRequestId(),
    ...(redact(fields) as Record<string, unknown>)
  };
  const json = JSON.stringify(line);
  if (level === "error") {
    process.stderr.write(json + "\n");
  } else {
    process.stdout.write(json + "\n");
  }
}

export const logger = {
  debug: (fields: Record<string, unknown>) => emit("debug", fields),
  info: (fields: Record<string, unknown>) => emit("info", fields),
  warn: (fields: Record<string, unknown>) => emit("warn", fields),
  /**
   * Pass `{ evt, error, ...rest }`. The `error` field will be sanitised down
   * to name/message/code/status/short-stack — never the full object.
   */
  error: (fields: Record<string, unknown>) => {
    const { error, ...rest } = fields;
    emit("error", {
      ...rest,
      ...(error !== undefined ? { error: sanitiseError(error) } : {})
    });
  }
};

/**
 * Public helper for places that need to redact a free-form string going into
 * the DB (e.g. outbox_calcom.last_error). Same masking as the logger's
 * string-level redaction, no JSON wrapping.
 */
export function redactSecrets(s: string): string {
  return redactString(s);
}
