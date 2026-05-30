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
