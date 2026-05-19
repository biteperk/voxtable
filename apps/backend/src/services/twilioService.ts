import twilio from "twilio";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { CallStatus } from "../domain/types";
import { upsertCallLog } from "../repositories/callLogs";

type TwilioPayload = Record<string, any>;

const TWILIO_PROVIDER = "twilio";

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
    await upsertCallLog({
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      provider: TWILIO_PROVIDER,
      providerCallId: callSid,
      callerPhone: payload.From ?? null,
      status: "started",
      startedAt: new Date().toISOString()
    });
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

  await upsertCallLog({
    restaurantId: env.DEFAULT_RESTAURANT_ID,
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
