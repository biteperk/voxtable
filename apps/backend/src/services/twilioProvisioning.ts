import twilio from "twilio";

import { env } from "../config/env";
import { AppError } from "../domain/errors";

/**
 * Twilio number provisioning for auto-provisioning (Phase 4b). Buys an AU local
 * number and points its Voice webhook at our /twilio/voice handler, which
 * already returns the TwiML that dials the Retell SIP trunk — so we reuse the
 * existing inbound path rather than configuring a per-number SIP trunk.
 *
 * Idempotency is the caller's responsibility (the worker checks the job payload
 * / restaurants.twilio_phone_number before buying).
 */

function client() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new AppError(503, "TWILIO_NOT_CONFIGURED", "Twilio credentials are not configured.");
  }
  return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
}

function voiceUrl(): string {
  return `${env.PUBLIC_API_BASE_URL.replace(/\/$/, "")}/twilio/voice`;
}

/**
 * Read-only search for a purchasable AU number. Split from the purchase so
 * the worker's crash-window marker can wrap ONLY the call that spends money —
 * a 429 on this search used to trip the marker and permanently brick the job.
 */
export async function searchAuNumber(): Promise<string> {
  const c = client();
  const available = await c
    .availablePhoneNumbers("AU")
    .local.list({
      ...(env.PROVISIONING_TWILIO_AREA_CODE
        ? { areaCode: Number(env.PROVISIONING_TWILIO_AREA_CODE) }
        : {}),
      limit: 1
    });
  const candidate = available[0];
  if (!candidate) {
    throw new AppError(502, "NO_NUMBER_AVAILABLE", "No Twilio number available to purchase.");
  }
  return candidate.phoneNumber;
}

/** The one call that spends money. Kept minimal so the caller's crash-window
 *  marker brackets nothing but this HTTP request. */
export async function purchaseAuNumber(
  candidatePhoneNumber: string
): Promise<{ phoneNumber: string; sid: string }> {
  const c = client();
  const purchased = await c.incomingPhoneNumbers.create({
    phoneNumber: candidatePhoneNumber,
    voiceUrl: voiceUrl(),
    voiceMethod: "POST"
  });
  return { phoneNumber: purchased.phoneNumber, sid: purchased.sid };
}

/**
 * Did this error PROVABLY happen before Twilio executed the purchase?
 * 4xx (including 429 rate-limit) means the request was rejected — no number
 * was allocated, so retrying cannot double-buy and the crash-window marker
 * can be cleared. 5xx and network errors are genuinely ambiguous (the
 * purchase may have gone through) — the marker must stay.
 */
export function isDefinitelyNotPurchased(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/** Ensure the number's Voice webhook points at our TwiML handler (idempotent). */
export async function configureVoiceWebhook(sid: string): Promise<void> {
  const c = client();
  await c.incomingPhoneNumbers(sid).update({ voiceUrl: voiceUrl(), voiceMethod: "POST" });
}
