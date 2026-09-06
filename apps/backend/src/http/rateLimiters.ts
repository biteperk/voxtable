import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

import type { AuthenticatedRequest } from "../auth/firebaseAuth";

/**
 * Per-account (else per-IP) rate limiters for the cost-bearing public surface.
 *
 * The app-wide limiter in app.ts caps raw requests per IP (incl. unauthenticated
 * floods that 401 before reaching a handler). These complement it: applied
 * AFTER requireFirebaseAuth, they cap how often a *single authenticated account*
 * can hit an expensive endpoint — stopping a logged-in user (or a botnet of
 * cheap Google accounts) from scripting mass tenant creation or burning
 * vision-LLM (OCR) calls. Keyed by Firebase uid when present, falling back to an
 * IPv6-safe IP key.
 */
function uidOrIpKey(request: Request): string {
  const uid = (request as AuthenticatedRequest).firebaseUser?.uid;
  if (uid) return `uid:${uid}`;
  return ipKeyGenerator(request.ip ?? "unknown");
}

// Restaurant creation is a once-ever action per owner (idempotent thereafter).
// 10/hour/account absorbs retries + double-submits while blocking scripted
// tenant spam.
export const createRestaurantLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: uidOrIpKey,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts — please try again later." } }
});

// Menu OCR ingest triggers a paid vision-LLM call. Per-minute burst cap that
// complements the per-day cap (MENU_OCR_MAX_JOBS_PER_DAY) so 25 jobs can't all
// fire in one minute.
export const menuIngestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: uidOrIpKey,
  message: { error: { code: "RATE_LIMITED", message: "You're uploading menus too quickly — please wait a moment." } }
});

// Verify-email code endpoints (send + confirm). The service enforces its own
// DB-backed send cooldown and guess cap; this is the outer belt that also
// covers pre-verification accounts hammering the route itself.
export const verifyEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: uidOrIpKey,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts — please try again later." } }
});

// Payment-link sends cost real money (SMS) and put a payment request in a
// guest's hands — cap per staff account on top of the DB-side per-order cap
// (max 3 attempts/hour, enforced in orderPaymentService).
export const paymentLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: uidOrIpKey,
  message: { error: { code: "RATE_LIMITED", message: "Too many payment links — please try again later." } }
});

// Mutating platform-admin actions (bind, unbind, go-live, re-enqueue, support
// updates). Cost-bearing — a re-enqueue can lead to a Twilio purchase, go-live
// fires owner notifications — and there are few admins, so a modest per-account
// cap absorbs any scripted mistake without slowing real ops work.
export const adminActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: uidOrIpKey,
  message: { error: { code: "RATE_LIMITED", message: "Too many admin actions — please slow down." } }
});

// Contact-details upsert (signup flush + profile edits). Cheap write to the
// caller's own users row, but deliberately reachable by any verified account
// pre-allowlist — so cap it like restaurant creation.
export const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: uidOrIpKey,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts — please try again later." } }
});

// Public short links (/pay/<token>, /receipt/<token>): unauthenticated by
// design, one 302 each. Tokens are 22 random base64url chars, so enumeration is
// hopeless, but a scripted scan should still hit a wall well before it costs a
// database read per attempt. Per IP; guests open a link once or twice.
export const publicLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (request: Request) => ipKeyGenerator(request.ip ?? "unknown"),
  message: { error: { code: "RATE_LIMITED", message: "Too many requests - please try again shortly." } }
});
