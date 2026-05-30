import { NextFunction, Request, Response } from "express";
import admin from "firebase-admin";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { logger } from "../utils/logger";
import type { TenantContext } from "./tenantContext";

let initialized = false;

function ensureInitialized(): admin.app.App {
  if (initialized) {
    return admin.app();
  }

  if (!env.FIREBASE_PROJECT_ID) {
    throw new AppError(
      500,
      "FIREBASE_NOT_CONFIGURED",
      "FIREBASE_PROJECT_ID is required to verify ID tokens."
    );
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: env.FIREBASE_PROJECT_ID
  });
  initialized = true;
  return admin.app();
}

// Parsed once at module load: lowercase, trimmed, deduped via Set for O(1)
// lookup. Empty in dev (allow-anyone behaviour), required-non-empty in
// production (enforced by env.ts superRefine).
const allowedEmails = new Set(
  (env.DASHBOARD_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// Manager allowlist — gates menu CRUD, payment toggles, and order cancellation.
// The kitchen kiosk account is NOT in this set; kitchen staff can read the
// menu and update order status but can't edit prices or refund payments.
// Phase 2 upgrades this to Firebase custom claims (`role: manager`).
const managerEmails = new Set(
  (env.DASHBOARD_MANAGER_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// Platform admins (VocoTable staff) — gate the cross-tenant provisioning console.
const adminEmails = new Set(
  (env.DASHBOARD_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export interface AuthenticatedRequest extends Request {
  firebaseUser?: admin.auth.DecodedIdToken;
  // Populated by resolveTenant (multi-tenant dashboard routes). Optional because
  // requireFirebaseAuth runs on routes that don't resolve a tenant (e.g. /api/me
  // before a restaurant exists, onboarding create).
  tenant?: TenantContext;
}

/**
 * Is this email in the manager allowlist? Used by the multi-tenancy legacy
 * bridge (tenantContext) to assign a role to pre-backfill allowlisted users.
 */
export function isManagerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return managerEmails.has(email.toLowerCase());
}

export async function requireFirebaseAuth(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction
): Promise<void> {
  // Dev escape hatch — mirrors RETELL_VERIFY_SIGNATURE / TWILIO_VALIDATE_SIGNATURE.
  // Production env validation forces this true.
  if (!env.DASHBOARD_VERIFY_AUTH) {
    next();
    return;
  }

  const header = request.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return next(
      new AppError(401, "MISSING_BEARER_TOKEN", "Authorization: Bearer <token> required.")
    );
  }

  try {
    const app = ensureInitialized();
    const decoded = await app.auth().verifyIdToken(match[1]!);

    // A verified email is required for EVERY authenticated request, regardless
    // of the allowlist. This must sit ABOVE the allowlist branch: with open
    // signup (empty allowlist) the allowlist check is skipped entirely, so
    // without this an unverified email/password account would pass auth and
    // reach cost-bearing actions (OCR, provisioning). Google sign-ins are
    // pre-verified, so this is transparent for them.
    if (!decoded.email || decoded.email_verified !== true) {
      logger.warn({
        evt: "auth_email_not_verified",
        uid: decoded.uid,
        email_verified: decoded.email_verified === true
      });
      return next(
        new AppError(403, "EMAIL_NOT_VERIFIED", "Please verify your email address to continue.")
      );
    }

    // Email allowlist — defence-in-depth on top of Firebase project audience
    // check (which verifyIdToken already enforces via the projectId passed to
    // initializeApp). Empty allowlist = allow any verified account (dev only;
    // production env.ts superRefine forbids the empty case).
    if (allowedEmails.size > 0) {
      const email = decoded.email.toLowerCase();
      if (!allowedEmails.has(email)) {
        logger.warn({ evt: "auth_email_not_allowlisted", uid: decoded.uid });
        return next(
          new AppError(403, "EMAIL_NOT_ALLOWLISTED", "This account is not authorised.")
        );
      }
    }

    request.firebaseUser = decoded;
    next();
  } catch (error) {
    if (error instanceof AppError) {
      return next(error);
    }
    next(new AppError(401, "INVALID_TOKEN", "ID token verification failed."));
  }
}

/**
 * Manager gate — apply AFTER `requireFirebaseAuth`. Reads
 * DASHBOARD_MANAGER_EMAILS; in dev mode (verify auth off) it allows through.
 */
export function requireManagerRole(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction
): void {
  if (!env.DASHBOARD_VERIFY_AUTH) {
    next();
    return;
  }
  if (managerEmails.size === 0) {
    // Production safety: if no manager allowlist is configured, refuse to
    // gate destructive routes rather than silently allowing everyone.
    return next(
      new AppError(503, "MANAGER_ROLE_NOT_CONFIGURED", "Manager role not configured.")
    );
  }
  const email = request.firebaseUser?.email?.toLowerCase();
  if (!email || !managerEmails.has(email)) {
    return next(
      new AppError(403, "MANAGER_ROLE_REQUIRED", "This action requires a manager account.")
    );
  }
  next();
}

/**
 * Platform-admin gate (VocoTable staff) for the cross-tenant provisioning
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
