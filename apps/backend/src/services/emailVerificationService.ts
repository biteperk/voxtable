/**
 * Premium signup verification: a 6-digit code emailed via the notifications
 * outbox (branded, from our own domain) and typed on the verify screen. This
 * replaces Firebase's default verification email, which routinely lands in
 * spam. On confirmation we mark the Firebase account verified via the Admin
 * SDK — the rest of the stack (ID-token email_verified gate) is unchanged.
 *
 * Codes are stored hashed (sha256 over salt||code); the plaintext exists only
 * in the outbound email. Server-side send cooldown + hourly cap + guess cap
 * make the code space (10^6) unbruteforceable within its 15-minute TTL.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { env } from "../config/env";
import { getAdminApp } from "../auth/firebaseAuth";
import {
  consumeVerificationCode,
  getVerificationCode,
  incrementVerificationAttempts,
  upsertVerificationCode
} from "../repositories/emailVerification";
import { enqueueNotification } from "../repositories/notifications";
import { logger } from "../utils/logger";
import { renderVerificationCodeEmail } from "./emailTemplates";

export const CODE_TTL_MINUTES = 15;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_S = 60;
export const MAX_SENDS_PER_WINDOW = 6;
const SEND_WINDOW_MS = 60 * 60 * 1000;

// ---- Pure helpers (DB-free, unit-tested) ----

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}${code}`).digest("hex");
}

export function codeMatches(code: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashCode(code, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- Orchestration ----

export type IssueResult =
  | { ok: true; cooldownSeconds: number; expiresInSeconds: number }
  | { ok: false; reason: "cooldown" | "hourly_cap"; retryAfterSeconds: number };

export async function issueVerificationCode(uid: string, email: string): Promise<IssueResult> {
  const existing = await getVerificationCode(uid);
  const now = Date.now();

  let sendsInWindow = 1;
  let windowStartedAt = new Date(now);
  if (existing) {
    const sinceLastSend = (now - Date.parse(existing.last_sent_at)) / 1000;
    if (sinceLastSend < RESEND_COOLDOWN_S) {
      return {
        ok: false,
        reason: "cooldown",
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_S - sinceLastSend)
      };
    }
    const windowAge = now - Date.parse(existing.window_started_at);
    if (windowAge < SEND_WINDOW_MS) {
      if (existing.sends_in_window >= MAX_SENDS_PER_WINDOW) {
        return {
          ok: false,
          reason: "hourly_cap",
          retryAfterSeconds: Math.ceil((SEND_WINDOW_MS - windowAge) / 1000)
        };
      }
      sendsInWindow = existing.sends_in_window + 1;
      windowStartedAt = new Date(Date.parse(existing.window_started_at));
    }
  }

  const code = generateCode();
  const salt = randomBytes(16).toString("hex");
  const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);

  await upsertVerificationCode({
    uid,
    email,
    codeHash: hashCode(code, salt),
    salt,
    expiresAt,
    sendsInWindow,
    windowStartedAt
  });

  const rendered = renderVerificationCodeEmail(code, CODE_TTL_MINUTES);
  await enqueueNotification({
    restaurantId: null,
    channel: "email",
    recipient: email,
    kind: "email_verification_code",
    subject: rendered.subject,
    body: rendered.text,
    bodyHtml: rendered.html
  });

  logger.info({ evt: "verify_code_sent", uid, sends_in_window: sendsInWindow });
  return {
    ok: true,
    cooldownSeconds: RESEND_COOLDOWN_S,
    expiresInSeconds: CODE_TTL_MINUTES * 60
  };
}

export type ConfirmResult =
  | { outcome: "verified" }
  | { outcome: "invalid"; attemptsRemaining: number }
  | { outcome: "expired" }
  | { outcome: "too_many_attempts" }
  | { outcome: "no_code" };

export async function confirmVerificationCode(uid: string, code: string): Promise<ConfirmResult> {
  const row = await getVerificationCode(uid);
  if (!row || row.consumed_at) {
    return { outcome: "no_code" };
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    return { outcome: "expired" };
  }

  // Increment-then-check: parallel guesses each burn an attempt BEFORE the
  // comparison, so racing requests can never exceed the cap.
  const attempts = await incrementVerificationAttempts(uid);
  if (attempts > MAX_ATTEMPTS) {
    logger.warn({ evt: "verify_code_rejected", uid, reason: "too_many_attempts" });
    return { outcome: "too_many_attempts" };
  }

  if (!codeMatches(code, row.salt, row.code_hash)) {
    logger.info({ evt: "verify_code_rejected", uid, reason: "invalid", attempts });
    return { outcome: "invalid", attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attempts) };
  }

  await consumeVerificationCode(uid);

  // Mark the Firebase account verified so the standard ID-token gate opens.
  // Dev escape hatch: with auth verification off there's no real Firebase user
  // (and often no Admin credentials) — skip the Admin write, matching me.ts.
  if (env.APP_ENV === "production" || env.DASHBOARD_VERIFY_AUTH) {
    await getAdminApp().auth().updateUser(uid, { emailVerified: true });
  }

  logger.info({ evt: "verify_code_confirmed", uid });
  return { outcome: "verified" };
}
