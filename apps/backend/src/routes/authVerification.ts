import { Router } from "express";
import { z } from "zod";

import {
  AuthenticatedRequest,
  requireFirebaseIdentityAllowUnverified
} from "../auth/firebaseAuth";
import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { verifyEmailLimiter } from "../http/rateLimiters";
import {
  confirmVerificationCode,
  issueVerificationCode
} from "../services/emailVerificationService";

// Premium signup verification: 6-digit code, emailed via the notifications
// outbox, typed on the verify screen. Both endpoints tolerate an UNVERIFIED
// (but authenticated) account — that's the whole point — and 404 while the
// kill-switch is off, which the frontend reads as "fall back to the legacy
// Firebase-link flow".
export const authVerificationRouter = Router();

function requireEnabled(): void {
  if (!env.EMAIL_VERIFICATION_CODE_ENABLED) {
    throw new AppError(404, "FEATURE_DISABLED", "Email verification codes are not enabled.");
  }
}

// Dev escape hatch (DASHBOARD_VERIFY_AUTH=false): same synthetic identity as
// /api/me, so the flow is exercisable locally and by smoke scripts.
function identityFor(request: AuthenticatedRequest): { uid: string; email: string } {
  const user = request.firebaseUser;
  if (user) {
    // Middleware guarantees email is present even for unverified accounts.
    return { uid: user.uid, email: user.email ?? "" };
  }
  return { uid: "dev-local-user", email: "dev@local.test" };
}

authVerificationRouter.post(
  "/api/auth/verify-email/send",
  requireFirebaseIdentityAllowUnverified,
  verifyEmailLimiter,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    requireEnabled();

    if (request.firebaseUser?.email_verified === true) {
      response.json({ ok: true, already_verified: true });
      return;
    }

    const { uid, email } = identityFor(request);
    const result = await issueVerificationCode(uid, email);

    if (!result.ok) {
      throw new AppError(
        429,
        result.reason === "cooldown" ? "RESEND_COOLDOWN" : "SEND_LIMIT",
        result.reason === "cooldown"
          ? "A code was just sent — give it a moment before requesting another."
          : "Too many codes requested — please try again later.",
        { retry_after_seconds: result.retryAfterSeconds }
      );
    }

    response.json({
      ok: true,
      cooldown_seconds: result.cooldownSeconds,
      expires_in_seconds: result.expiresInSeconds
    });
  })
);

const confirmSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from the email.")
});

authVerificationRouter.post(
  "/api/auth/verify-email/confirm",
  requireFirebaseIdentityAllowUnverified,
  verifyEmailLimiter,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    requireEnabled();

    if (request.firebaseUser?.email_verified === true) {
      response.json({ ok: true, verified: true, already_verified: true });
      return;
    }

    const { code } = confirmSchema.parse(request.body);
    const { uid } = identityFor(request);
    const result = await confirmVerificationCode(uid, code);

    switch (result.outcome) {
      case "verified":
        response.json({ ok: true, verified: true });
        return;
      case "invalid":
        throw new AppError(400, "INVALID_CODE", "That code isn't right — check the email and try again.", {
          attempts_remaining: result.attemptsRemaining
        });
      case "expired":
        throw new AppError(410, "CODE_EXPIRED", "That code has expired — send a new one.");
      case "too_many_attempts":
        throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many wrong guesses — send a new code.");
      case "no_code":
        throw new AppError(400, "NO_ACTIVE_CODE", "No active code — send one first.");
    }
  })
);
