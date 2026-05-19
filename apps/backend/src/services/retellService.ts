import { Retell } from "retell-sdk";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { CallStatus } from "../domain/types";
import {
  availabilityRequestSchema,
  createBookingRequestSchema,
  normalizePartySize,
  normalizeRestaurantId
} from "../http/schemas";
import { upsertCallLog } from "../repositories/callLogs";
import { checkAvailability } from "./availabilityService";
import { createBooking } from "./bookingService";

type RetellPayload = Record<string, any>;

interface RetellFunctionRequest {
  name?: string;
  call?: RetellPayload;
  args?: unknown;
}

const RETELL_PROVIDER = "retell";

export async function assertRetellSignature(
  headerValue: string | undefined,
  rawBody: string | undefined
): Promise<void> {
  if (!env.RETELL_VERIFY_SIGNATURE) {
    return;
  }

  if (!env.RETELL_API_KEY) {
    throw new AppError(
      500,
      "RETELL_SIGNATURE_CONFIG_MISSING",
      "RETELL_API_KEY is required when RETELL_VERIFY_SIGNATURE=true."
    );
  }

  if (!headerValue) {
    throw new AppError(401, "RETELL_SIGNATURE_MISSING", "Retell signature is required.");
  }

  const isValid = await Retell.verify(rawBody ?? "", env.RETELL_API_KEY, headerValue);

  if (!isValid) {
    throw new AppError(401, "RETELL_SIGNATURE_INVALID", "Invalid Retell signature.");
  }
}

export async function handleRetellWebhook(body: unknown): Promise<void> {
  const payload = body as RetellPayload;
  const event = String(payload.event ?? "");
  const call = payload.call as RetellPayload | undefined;

  if (!event) {
    throw new AppError(400, "INVALID_RETELL_WEBHOOK", "Retell webhook event is required.");
  }

  if (!call?.call_id) {
    return;
  }

  await persistRetellCall(event, call, payload);
}

export async function handleRetellInbound(body: unknown): Promise<unknown> {
  const payload = body as RetellPayload;
  const inbound = payload.call_inbound as RetellPayload | undefined;

  if (payload.event !== "call_inbound" || !inbound) {
    throw new AppError(400, "INVALID_RETELL_INBOUND", "Retell call_inbound payload is required.");
  }

  await upsertCallLog({
    restaurantId: env.DEFAULT_RESTAURANT_ID,
    provider: RETELL_PROVIDER,
    providerCallId: getProviderCallId(inbound),
    callerPhone: inbound.from_number ?? null,
    status: "started",
    startedAt: new Date().toISOString()
  });

  return {
    call_inbound: {
      ...(env.RETELL_AGENT_ID ? { override_agent_id: env.RETELL_AGENT_ID } : {}),
      dynamic_variables: {
        restaurant_id: env.DEFAULT_RESTAURANT_ID,
        restaurant_name: "Natalia's Bistro",
        caller_phone: inbound.from_number ?? ""
      },
      metadata: {
        restaurant_id: env.DEFAULT_RESTAURANT_ID,
        source: "vocotable",
        inbound_from_number: inbound.from_number ?? "",
        inbound_to_number: inbound.to_number ?? ""
      }
    }
  };
}

export async function handleRetellFunction(
  body: unknown,
  fallbackName?: string
): Promise<unknown> {
  const payload = body as RetellFunctionRequest;
  const name = normalizeFunctionName(payload.name ?? fallbackName);
  const call = payload.call as RetellPayload | undefined;
  const args = extractFunctionArgs(payload);
  const providerCallId = getProviderCallId(call);

  if (call?.call_id) {
    await persistRetellCall("function_call", call, { event: "function_call" });
  }

  if (name === "check_availability" || name === "checkavailability") {
    return checkAvailability(
      normalizeAvailabilityArgs({
        ...args,
        provider_call_id: providerCallId
      })
    );
  }

  if (name === "create_booking" || name === "createbooking") {
    return createBooking(
      normalizeBookingArgs({
        ...args,
        provider_call_id: providerCallId
      })
    );
  }

  throw new AppError(400, "UNKNOWN_RETELL_FUNCTION", `Unknown Retell function: ${name}`);
}

async function persistRetellCall(
  event: string,
  call: RetellPayload,
  payload: RetellPayload
): Promise<void> {
  const providerCallId = getProviderCallId(call);

  if (!providerCallId) {
    return;
  }

  await upsertCallLog({
    restaurantId: getRestaurantId(call),
    provider: RETELL_PROVIDER,
    providerCallId,
    callerPhone: getCallerPhone(call),
    status: mapRetellStatus(event, call),
    transcript: getTranscript(call),
    summary: getSummary(call),
    recordingUrl: call.recording_url ?? call.scrubbed_recording_url ?? null,
    latencyMs: getLatencyMs(call),
    transferredToStaff: event.startsWith("transfer_") || Boolean(payload.transfer_destination),
    startedAt: fromRetellTimestamp(call.start_timestamp),
    endedAt: fromRetellTimestamp(call.end_timestamp)
  });
}

function mapRetellStatus(event: string, call: RetellPayload): CallStatus {
  if (event.startsWith("transfer_")) {
    return "transferred";
  }

  if (event === "call_started" || event === "function_call") {
    return "in_progress";
  }

  if (event === "transcript_updated") {
    return call.end_timestamp ? "completed" : "in_progress";
  }

  if (event === "call_ended" || event === "call_analyzed") {
    const reason = String(call.disconnection_reason ?? "");

    if (reason.startsWith("dial_") || reason.includes("error")) {
      return "failed";
    }

    return "completed";
  }

  return "started";
}

function normalizeFunctionName(name: string | undefined): string {
  return String(name ?? "").trim().replace(/-/g, "_").toLowerCase();
}

function extractFunctionArgs(payload: RetellFunctionRequest): Record<string, unknown> {
  if (payload.args !== undefined) {
    return parseJsonObject(payload.args);
  }

  const directPayload = payload as RetellPayload;
  const directArgs = directPayload.arguments ?? directPayload.parameters;

  if (directArgs !== undefined) {
    return parseJsonObject(directArgs);
  }

  const { name: _name, call: _call, ...argsOnlyPayload } = directPayload;
  return parseJsonObject(argsOnlyPayload);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;

      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch (_error) {
      throw new AppError(400, "INVALID_RETELL_ARGUMENTS", "Retell function arguments must be valid JSON.");
    }

    throw new AppError(400, "INVALID_RETELL_ARGUMENTS", "Retell function arguments must be a JSON object.");
  }

  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeAvailabilityArgs(args: Record<string, unknown>) {
  const parsed = availabilityRequestSchema.parse({
    restaurant_id: args.restaurant_id,
    restaurantId: args.restaurantId,
    date: args.date,
    time: args.time,
    party_size: args.party_size,
    partySize: args.partySize
  });
  const partySize = normalizePartySize(parsed);

  if (!partySize) {
    throw new AppError(400, "PARTY_SIZE_REQUIRED", "party_size is required.");
  }

  return {
    restaurantId: normalizeRestaurantId(parsed, env.DEFAULT_RESTAURANT_ID),
    date: parsed.date,
    time: parsed.time,
    partySize
  };
}

function normalizeBookingArgs(args: Record<string, unknown>) {
  const parsed = createBookingRequestSchema.parse({
    restaurant_id: args.restaurant_id,
    restaurantId: args.restaurantId,
    customer_name: args.customer_name,
    customerName: args.customerName,
    customer_phone: args.customer_phone,
    customerPhone: args.customerPhone,
    date: args.date,
    time: args.time,
    party_size: args.party_size,
    partySize: args.partySize,
    source: "voice",
    notes: args.notes,
    call_log_id: args.call_log_id,
    callLogId: args.callLogId,
    provider_call_id: args.provider_call_id,
    providerCallId: args.providerCallId
  });
  const customerName = parsed.customer_name ?? parsed.customerName;
  const customerPhone = parsed.customer_phone ?? parsed.customerPhone;
  const partySize = normalizePartySize(parsed);

  if (!customerName) {
    throw new AppError(400, "CUSTOMER_NAME_REQUIRED", "customer_name is required.");
  }

  if (!customerPhone) {
    throw new AppError(400, "CUSTOMER_PHONE_REQUIRED", "customer_phone is required.");
  }

  if (!partySize) {
    throw new AppError(400, "PARTY_SIZE_REQUIRED", "party_size is required.");
  }

  return {
    restaurantId: normalizeRestaurantId(parsed, env.DEFAULT_RESTAURANT_ID),
    customerName,
    customerPhone,
    date: parsed.date,
    time: parsed.time,
    partySize,
    source: "voice" as const,
    notes: parsed.notes,
    callLogId: parsed.call_log_id ?? parsed.callLogId,
    provider: RETELL_PROVIDER,
    providerCallId: parsed.provider_call_id ?? parsed.providerCallId
  };
}

function getRestaurantId(call: RetellPayload): string {
  return (
    call.metadata?.restaurant_id ??
    call.metadata?.restaurantId ??
    call.retell_llm_dynamic_variables?.restaurant_id ??
    call.retell_llm_dynamic_variables?.restaurantId ??
    env.DEFAULT_RESTAURANT_ID
  );
}

function getProviderCallId(call: RetellPayload | undefined): string | undefined {
  return call?.call_id === undefined ? undefined : String(call.call_id);
}

function getCallerPhone(call: RetellPayload): string | null {
  return call.from_number ?? call.metadata?.caller_phone ?? null;
}

function getTranscript(call: RetellPayload): string | null {
  if (typeof call.transcript === "string") {
    return call.transcript;
  }

  return null;
}

function getSummary(call: RetellPayload): string | null {
  return (
    call.call_analysis?.call_summary ??
    call.call_analysis?.summary ??
    call.call_summary ??
    null
  );
}

function getLatencyMs(call: RetellPayload): number | null {
  const candidates = [
    call.latency?.e2e?.p50,
    call.latency?.e2e?.p90,
    call.latency_ms,
    call.latencyMs
  ];

  const value = candidates.find((candidate) => Number.isFinite(Number(candidate)));
  return value === undefined ? null : Math.round(Number(value));
}

function fromRetellTimestamp(value: unknown): string | null {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}
