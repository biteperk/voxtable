import twilio from "twilio";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { CallStatus } from "../domain/types";
import { getRestaurantIdByProviderCallId, upsertCallLog } from "../repositories/callLogs";
import { getRestaurantIdByDialedNumber } from "../repositories/restaurants";
import { logger } from "../utils/logger";

type TwilioPayload = Record<string, any>;

const TWILIO_PROVIDER = "twilio";

/**
 * Work out which restaurant a Twilio call belongs to.
 *
 * This used to be `env.DEFAULT_RESTAURANT_ID`, unconditionally, in production —
 * so once a second restaurant had a number, every call log from every venue was
 * filed against restaurant #1. The Retell path already resolves tenancy properly
 * (`resolveRestaurantIdForCall`); this mirrors it:
 *
 *   1. an existing call_log for this CallSid (the status callback arrives after
 *      the inbound webhook, so the first write has already resolved it),
 *   2. the dialed number — `To` on the inbound leg, `Called` on some callbacks.
 *
 * Returns null when it cannot be resolved. Callers fail safe rather than
 * attributing a call to the wrong tenant.
 */
async function resolveRestaurantIdForTwilioCall(
  payload: TwilioPayload,
  callSid: string
): Promise<string | null> {
  const fromLog = await getRestaurantIdByProviderCallId(TWILIO_PROVIDER, callSid);
  if (fromLog) return fromLog;

  const dialed = payload.To ?? payload.Called ?? null;
  const fromDialed = await getRestaurantIdByDialedNumber(dialed);
  if (fromDialed) return fromDialed;

  // Dev keeps the default so local testing works without provisioning numbers.
  return env.APP_ENV !== "production" ? env.DEFAULT_RESTAURANT_ID : null;
}

export function assertTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, string | string[] | undefined>
): void {
  if (!env.TWILIO_VALIDATE_SIGNATURE) {
    return;
  }

  if (!env.TWILIO_AUTH_TOKEN) {
    throw new AppError(
      500,
      "TWILIO_SIGNATURE_CONFIG_MISSING",
      "TWILIO_AUTH_TOKEN is required when TWILIO_VALIDATE_SIGNATURE=true."
    );
  }

  if (!signature) {
    throw new AppError(401, "TWILIO_SIGNATURE_MISSING", "Twilio signature is required.");
  }

  const normalizedParams = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(",") : String(value ?? "")
    ])
  );
  const isValid = twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    normalizedParams
  );

  if (!isValid) {
    throw new AppError(401, "TWILIO_SIGNATURE_INVALID", "Invalid Twilio signature.");
  }
}

export async function handleTwilioIncomingCall(body: unknown): Promise<string> {
  const payload = body as TwilioPayload;
  const callSid = getCallSid(payload);

  if (callSid) {
    const restaurantId = await resolveRestaurantIdForTwilioCall(payload, callSid);
    if (restaurantId) {
      await upsertCallLog({
        restaurantId,
        provider: TWILIO_PROVIDER,
        providerCallId: callSid,
        callerPhone: payload.From ?? null,
        status: "started",
        startedAt: new Date().toISOString()
      });
    } else {
      // Never guess. Filing this under the default tenant is what produced the
      // cross-tenant leak. The call still connects — the TwiML below does not
      // depend on the log — so an unmapped number degrades to a missing log
      // entry rather than a wrong one, and the warning tells us to map it.
      logger.warn({
        evt: "twilio_call_unmapped_number",
        provider_call_id: callSid,
        dialed: payload.To ?? payload.Called ?? null
      });
    }
  }

  const voiceResponse = new twilio.twiml.VoiceResponse();
  const dialAttributes: {
    action: string;
    answerOnBridge: boolean;
    callerId?: string;
    method: string;
  } = {
    answerOnBridge: true,
    action: `${env.PUBLIC_API_BASE_URL}/twilio/status`,
    method: "POST"
  };

  if (env.TWILIO_PHONE_NUMBER) {
    dialAttributes.callerId = env.TWILIO_PHONE_NUMBER;
  }

  const dial = voiceResponse.dial(dialAttributes);

  dial.sip(
    {
      statusCallback: `${env.PUBLIC_API_BASE_URL}/twilio/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST"
    },
    env.TWILIO_RETELL_SIP_URI
  );

  return voiceResponse.toString();
}

export async function handleTwilioStatusCallback(body: unknown): Promise<void> {
  const payload = body as TwilioPayload;
  const callSid = getCallSid(payload);

  if (!callSid) {
    return;
  }

  const restaurantId = await resolveRestaurantIdForTwilioCall(payload, callSid);
  if (!restaurantId) {
    logger.warn({
      evt: "twilio_status_unmapped_number",
      provider_call_id: callSid,
      dialed: payload.To ?? payload.Called ?? null
    });
    return;
  }

  await upsertCallLog({
    restaurantId,
    provider: TWILIO_PROVIDER,
    providerCallId: callSid,
    callerPhone: payload.From ?? payload.Caller ?? null,
    status: mapTwilioStatus(payload.CallStatus),
    recordingUrl: payload.RecordingUrl ?? null,
    latencyMs: null,
    transferredToStaff: false,
    startedAt: null,
    endedAt: payload.CallStatus === "completed" ? new Date().toISOString() : null
  });
}

function getCallSid(payload: TwilioPayload): string | undefined {
  return payload.CallSid ?? payload.ParentCallSid;
}

function mapTwilioStatus(status: unknown): CallStatus {
  switch (status) {
    case "queued":
    case "initiated":
    case "ringing":
      return "started";
    case "in-progress":
    case "answered":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
    case "failed":
    case "no-answer":
    case "canceled":
      return "failed";
    default:
      return "started";
  }
}
