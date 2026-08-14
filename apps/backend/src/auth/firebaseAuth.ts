import { NextFunction, Request, Response } from "express";
import { applicationDefault, getApp, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { getUserMemberships } from "../repositories/members";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/withTimeout";
import type { TenantContext } from "./tenantContext";

let initialized = false;

function ensureInitialized(): App {
  if (initialized) {
    return getApp();
  }

  if (!env.FIREBASE_PROJECT_ID) {
    throw new AppError(
      500,
      "FIREBASE_NOT_CONFIGURED",
      "FIREBASE_PROJECT_ID is required to verify ID tokens."
    );
  }

  initializeApp({
    credential: applicationDefault(),
    projectId: env.FIREBASE_PROJECT_ID
  });
  initialized = true;
  return getApp();
}

// Parse a comma-separated allowlist into a lowercase, trimmed, deduped Set for
// O(1) lookup. Empty in dev (allow-anyone behaviour), required-non-empty in
// production (enforced by env.ts superRefine).
const parseEmailSet = (csv: string | undefined): Set<string> =>
  new Set((csv ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

const allowedEmails = parseEmailSet(env.DASHBOARD_ALLOWED_EMAILS);

// DASHBOARD_MANAGER_EMAILS and DASHBOARD_KITCHEN_EMAILS are no longer read
// here. They used to derive a role for a user with no membership row, via the
// MULTITENANCY_LEGACY_FALLBACK bridge that migration 027 retired. Roles now
// come from restaurant_members and nowhere else. Both vars survive as seed
// input only (db/seed.ts), which writes real membership rows from them.

// Platform admins (VoxTable staff) — gate the cross-tenant provisioning console.
const adminEmails = parseEmailSet(env.DASHBOARD_ADMIN_EMAILS);

export interface AuthenticatedRequest extends Request {
  firebaseUser?: DecodedIdToken;
  // Populated by resolveTenant (multi-tenant dashboard routes). Optional because
  // requireFirebaseAuth runs on routes that don't resolve a tenant (e.g. /api/me
  // before a restaurant exists, onboarding create).
  tenant?: TenantContext;
}

/**
 * Is this email in the platform bootstrap allowlist? The allowlist still gates
 * who may authenticate at all (see `enforceAllowlist` below); it no longer
 * decides what anyone may do once inside — restaurant_members does that.
 */
export function isAllowlistedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails.has(email.toLowerCase());
}

/**
 * The Firebase Admin app, for the rare service that must write to Firebase
 * Auth itself (e.g. the verification-code flow marking an email verified).
 */
export function getAdminApp(): App {
  return ensureInitialized();
}

async function firebaseAuthMiddleware(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
  options: { enforceAllowlist: boolean; allowUnverified?: boolean }
): Promise<void> {
  // Dev escape hatch — mirrors RETELL_VERIFY_SIGNATURE / TWILIO_VALIDATE_SIGNATURE.
  // Production env validation forces this true.
  if (!env.DASHBOARD_VERIFY_AUTH) {
    next();
    return;
  }

  // Linear-time parse. This header is attacker-controlled and pre-auth, so no
  // regex with overlapping quantifiers belongs here.
  const header = request.header("authorization") ?? "";
  const token =
    header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : "";

  if (!token) {
    return next(
      new AppError(401, "MISSING_BEARER_TOKEN", "Authorization: Bearer <token> required.")
    );
  }

  // Token verification gets its own try/catch so ONLY a bad token maps to 401.
  // (Previously the catch wrapped the allowlist membership lookup too, so a
  // transient DB failure was reported as 401 INVALID_TOKEN — the frontend then
  // force-refreshed a perfectly good token, got 401 again, and signed the user
  // out. A DB blip must be a 5xx, not a mass sign-out.)
  //
  // Same reasoning forces the timeout to be a 503, not a 401: verifyIdToken
  // fetches Google's signing certs on a cold cache, and that fetch has no
  // deadline of its own — a hung cert endpoint would otherwise hang every
  // dashboard request behind it.
  let decoded: DecodedIdToken;
  try {
    const app = ensureInitialized();
    decoded = await withTimeout(
      getAuth(app).verifyIdToken(token),
      env.FIREBASE_AUTH_TIMEOUT_MS,
      () => new AppError(503, "AUTH_UNAVAILABLE", "Token verification timed out — please retry.")
    );
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 503) {
      logger.warn({ evt: "auth_verify_timeout", timeout_ms: env.FIREBASE_AUTH_TIMEOUT_MS });
      return next(error);
    }
    return next(new AppError(401, "INVALID_TOKEN", "ID token verification failed."));
  }

  // A verified email is required for EVERY authenticated request, regardless
  // of the allowlist. This must sit ABOVE the allowlist branch: with open
  // signup (empty allowlist) the allowlist check is skipped entirely, so
  // without this an unverified email/password account would pass auth and
  // reach cost-bearing actions (OCR, provisioning). Google sign-ins are
  // pre-verified, so this is transparent for them.
  if (!decoded.email || (decoded.email_verified !== true && !options.allowUnverified)) {
    logger.warn({
      evt: "auth_email_not_verified",
      uid: decoded.uid,
      email_verified: decoded.email_verified === true
    });
    return next(
      new AppError(403, "EMAIL_NOT_VERIFIED", "Please verify your email address to continue.")
    );
  }

  // Email allowlist - defence-in-depth on top of Firebase project audience
  // check. Invited restaurant members are also allowed even when their email
  // is not in the platform bootstrap allowlist; otherwise manager-driven
  // staff onboarding would still require an ops env change per employee.
  // With SELF_SERVE_SIGNUP_ENABLED the allowlist stops gating dashboard
  // routes entirely — any verified account may sign up and create a tenant
  // (that IS the semantics of self-serve; membership scoping still isolates
  // tenants, and requireAdminRole keeps its own DASHBOARD_ADMIN_EMAILS gate).
  if (allowedEmails.size > 0 && !env.SELF_SERVE_SIGNUP_ENABLED) {
    const email = decoded.email.toLowerCase();
    const allowlisted = allowedEmails.has(email);
    if (options.enforceAllowlist && !allowlisted) {
      let hasMembership = false;
      try {
        hasMembership = (await getUserMemberships(decoded.uid)).length > 0;
      } catch (error) {
        logger.error({ evt: "auth_membership_lookup_failed", uid: decoded.uid, error });
        return next(
          new AppError(503, "AUTH_LOOKUP_FAILED", "Could not verify account access — please retry.")
        );
      }
      if (!hasMembership) {
        logger.warn({ evt: "auth_email_not_allowlisted", uid: decoded.uid });
        return next(
          new AppError(403, "EMAIL_NOT_ALLOWLISTED", "This account is not authorised.")
        );
      }
    }
  }

  request.firebaseUser = decoded;
  next();
}

export async function requireFirebaseAuth(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction
): Promise<void> {
  return firebaseAuthMiddleware(request, response, next, { enforceAllowlist: true });
}

export async function requireFirebaseIdentity(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction
): Promise<void> {
  return firebaseAuthMiddleware(request, response, next, { enforceAllowlist: false });
}

/**
 * Identity check that tolerates an unverified email — ONLY for the
 * verify-email endpoints themselves (a user must be able to request/confirm a
 * code before they're verified). Everything else keeps the verified gate.
 */
export async function requireFirebaseIdentityAllowUnverified(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction
): Promise<void> {
  return firebaseAuthMiddleware(request, response, next, {
    enforceAllowlist: false,
    allowUnverified: true
  });
}

/**
 * Platform-admin gate (VoxTable staff) for the cross-tenant provisioning
 * console. Apply AFTER requireFirebaseAuth. In dev (verify auth off) it allows
 * through; in production it refuses if no admin allowlist is configured.
 */
export function requireAdminRole(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction
): void {
  if (!env.DASHBOARD_VERIFY_AUTH) {
    next();
    return;
  }
  if (adminEmails.size === 0) {
    return next(new AppError(503, "ADMIN_ROLE_NOT_CONFIGURED", "Admin role not configured."));
  }
  const email = request.firebaseUser?.email?.toLowerCase();
  if (!email || !adminEmails.has(email)) {
    return next(new AppError(403, "ADMIN_ROLE_REQUIRED", "This action requires a platform admin."));
  }
  next();
}

export function actorFor(request: AuthenticatedRequest): string {
  return request.firebaseUser?.uid ?? request.firebaseUser?.email ?? "anonymous";
}
