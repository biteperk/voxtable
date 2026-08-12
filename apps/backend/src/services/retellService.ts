import { Retell } from "retell-sdk";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { CallStatus } from "../domain/types";
import {
  availabilityRequestSchema,
  createBookingRequestSchema,
  createOrderRetellSchema,
  menuLookupRetellSchema,
  sendPaymentLinkRetellSchema,
  modifyBookingRequestSchema,
  normalizeModifyBookingArgs,
  normalizePartySize
} from "../http/schemas";
import { getCallLogIdByProviderCallId, getRestaurantIdByProviderCallId, upsertCallLog } from "../repositories/callLogs";
import {
  getRestaurantIdByDialedNumber,
  getRestaurantName,
  getRestaurantTimezone,
  getRetellAgentId
} from "../repositories/restaurants";
import { normalizePhone } from "../utils/phone";
import { enrichLogContext, logger } from "../utils/logger";
import {
  dayNameInTz,
  formatVoiceTime,
  isWithinDailyWindow,
  nowTimeInTz,
  todayInTz,
  tomorrowInTz
} from "../utils/time";
import { checkAvailability } from "./availabilityService";
import { createBooking, modifyBooking } from "./bookingService";
import { getMenu, lookupMenu } from "./menuService";
import { createOrder, orderContentFingerprint } from "./orderService";
import { createOrderPaymentLink } from "./orderPaymentService";

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

  // Retell signs webhooks with the dedicated dashboard "Secret Key (Webhook)",
  // which is distinct from the REST API key. Prefer RETELL_WEBHOOK_SECRET; fall
  // back to RETELL_API_KEY for older single-key accounts.
  const signingSecret = env.RETELL_WEBHOOK_SECRET ?? env.RETELL_API_KEY;
  if (!signingSecret) {
    throw new AppError(
      500,
      "RETELL_SIGNATURE_CONFIG_MISSING",
      "RETELL_WEBHOOK_SECRET (or RETELL_API_KEY) is required when RETELL_VERIFY_SIGNATURE=true."
    );
  }

  if (!headerValue) {
    throw new AppError(401, "RETELL_SIGNATURE_MISSING", "Retell signature is required.");
  }

  const isValid = await Retell.verify(rawBody ?? "", signingSecret, headerValue);

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

  enrichLogContext({ provider_call_id: String(call.call_id) });
  await persistRetellCall(event, call, payload);
}

export async function handleRetellInbound(body: unknown): Promise<unknown> {
  const payload = body as RetellPayload;
  const inbound = payload.call_inbound as RetellPayload | undefined;

  if (payload.event !== "call_inbound" || !inbound) {
    throw new AppError(400, "INVALID_RETELL_INBOUND", "Retell call_inbound payload is required.");
  }

  // Resolve the tenant from the TRUSTED dialed number (the number the caller
  // rang). Never from LLM-supplied data. Fail safe: an unmapped number in
  // production must NOT bind to a default tenant (cross-tenant booking risk) —
  // we return without a restaurant so Bella has no booking context, rather than
  // booking at the wrong restaurant. Dev keeps the default for local testing.
  const restaurantId = withDevDefault(await getRestaurantIdByDialedNumber(inbound.to_number));
  if (!restaurantId) {
    logger.warn({ evt: "retell_inbound_unmapped_number", to_number: inbound.to_number ?? null });
    return {
      call_inbound: {
        metadata: {
          source: "vocotable",
          restaurant_unconfigured: "true",
          inbound_to_number: inbound.to_number ?? ""
        }
      }
    };
  }

  const inboundCallId = getProviderCallId(inbound);
  if (inboundCallId) {
    enrichLogContext({ provider_call_id: inboundCallId });
  }

  const callerPhoneRaw = inbound.from_number ?? null;
  const callerPhone = normalizePhone(callerPhoneRaw) ?? callerPhoneRaw;

  const [tz, restaurantName, perRestaurantAgentId] = await Promise.all([
    getRestaurantTimezone(restaurantId),
    getRestaurantName(restaurantId),
    getRetellAgentId(restaurantId)
  ]);
  // Route to the restaurant's own agent when provisioned; fall back to the
  // single env agent (pre-multi-tenant default) otherwise.
  const overrideAgentId = perRestaurantAgentId ?? env.RETELL_AGENT_ID;

  await upsertCallLog({
    restaurantId,
    provider: RETELL_PROVIDER,
    providerCallId: getProviderCallId(inbound),
    callerPhone,
    status: "started",
    startedAt: new Date().toISOString()
  });

  const now = new Date();
  return {
    call_inbound: {
      ...(overrideAgentId ? { override_agent_id: overrideAgentId } : {}),
      dynamic_variables: {
        restaurant_id: restaurantId,
        restaurant_name: restaurantName,
        restaurant_timezone: tz,
        caller_phone: callerPhone ?? "",
        today: todayInTz(tz, now),
        tomorrow: tomorrowInTz(tz, now),
        now_local: nowTimeInTz(tz, now),
        weekday_local: dayNameInTz(tz, now)
      },
      metadata: {
        restaurant_id: restaurantId,
        source: "vocotable",
        inbound_from_number: inbound.from_number ?? "",
        inbound_to_number: inbound.to_number ?? ""
      }
    }
  };
}

/**
 * What Bella tells the caller while VOICE_BOOKING_ENABLED is off. The same
 * sentence is spread across every message field the different tools return
 * (`message`, `natural_alternatives_message`, `confirmation_message`), so
 * whichever one the agent's prompt reads, the caller hears the refusal —
 * never a half-taken booking.
 */
export function voiceBookingDisabledResponse(): {
  available: false;
  success: false;
  message: string;
  natural_alternatives_message: string;
  confirmation_message: string;
} {
  const message =
    "I'm sorry — our booking system is briefly offline for maintenance, so I can't " +
    "take or change bookings right now. Please call back a little later, and thank " +
    "you for your patience.";
  return {
    available: false,
    success: false,
    message,
    natural_alternatives_message: message,
    confirmation_message: message
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

  // Pin the call id to the log context: every line logged while serving this
  // tool call — including the errorHandler's, if it throws — now carries
  // provider_call_id, the one id Retell's dashboard also shows. Before this,
  // "which call did that 500 belong to?" had no answer.
  if (providerCallId) {
    enrichLogContext({ provider_call_id: providerCallId });
  }
  logger.info({ evt: "retell_tool_call", tool: name });

  if (call?.call_id) {
    await persistRetellCall("function_call", call, { event: "function_call" });
  }

  // The kill switch refuses every tool AFTER the call is persisted (the
  // dashboard should still show calls arriving while the switch is off) and
  // BEFORE anything can read or write booking state.
  if (!env.VOICE_BOOKING_ENABLED) {
    logger.warn({ evt: "voice_booking_disabled_refusal", tool: name });
    return voiceBookingDisabledResponse();
  }

  // Resolve the tenant from the trusted call (dialed number / persisted call_log
  // row), never from LLM-supplied args. Fail safe in production if unresolved.
  const restaurantId = withDevDefault(await resolveRestaurantIdForCall(call));
  if (!restaurantId) {
    throw new AppError(
      409,
      "RESTAURANT_NOT_CONFIGURED",
      "Sorry, this phone line isn't fully set up yet. Please try again later."
    );
  }

  if (name === "check_availability" || name === "checkavailability") {
    const result = await checkAvailability(
      normalizeAvailabilityArgs(
        {
          ...args,
          provider_call_id: providerCallId
        },
        restaurantId
      )
    );
    return {
      available: result.available,
      requested_time: result.requestedTime,
      suggested_time: result.suggestedTime,
      suggested_times: result.suggestedTimes,
      table_label: result.tableLabel,
      message: result.message,
      natural_alternatives_message: result.naturalAlternativesMessage
    };
  }

  if (name === "create_booking" || name === "createbooking") {
    const result = await createBooking(
      normalizeBookingArgs(
        {
          ...args,
          provider_call_id: providerCallId
        },
        restaurantId
      )
    );
    return {
      booking_id: result.bookingId,
      status: result.status,
      confirmation_message: result.confirmationMessage
    };
  }

  if (name === "menu_lookup" || name === "menulookup") {
    const parsed = menuLookupRetellSchema.safeParse(args);
    if (!parsed.success) {
      throw new AppError(
        400,
        "MENU_LOOKUP_INVALID",
        `menu_lookup args invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    const result = await lookupMenu({
      restaurantId,
      query: parsed.data.query,
      category: parsed.data.category
    });
    return {
      matches: result.matches,
      ambiguous: result.ambiguous,
      speakable_summary: result.speakable_summary
    };
  }

  if (name === "create_order" || name === "createorder") {
    const parsed = createOrderRetellSchema.safeParse(args);
    if (!parsed.success) {
      throw new AppError(
        400,
        "CREATE_ORDER_INVALID",
        `create_order args invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    const reservationId = parsed.data.reservation_id ?? parsed.data.reservationId;
    const pickupName = (parsed.data.pickup_name ?? parsed.data.pickupName ?? "").trim();
    const pickupTime = (parsed.data.pickup_time ?? parsed.data.pickupTime ?? "").trim();

    // Takeaway is a first-class order type. This used to throw
    // ORDER_REQUIRES_BOOKING whenever there was no reservation, which made the
    // voice path unusable for phone pickup — the caller was offered a table
    // they never asked for. orderService.createOrder has always taken
    // reservationId as optional; only this guard stood in the way.
    //
    // What the kitchen actually needs on a pickup ticket is a name to call
    // out, so that is what we require in a reservation's place.
    if (!reservationId && !pickupName) {
      throw new AppError(
        400,
        "ORDER_NEEDS_NAME",
        "Could I grab a name for the pickup order?"
      );
    }
    const callId = parsed.data.call_id ?? parsed.data.callId ?? providerCallId;

    // Resolve spoken item names to menu_item_ids inside this handler so the
    // LLM doesn't need to know UUIDs. Ambiguity returns a structured error
    // Bella can read out.
    const resolvedItems: Array<{
      menuItemId: string;
      variantId?: string;
      quantity: number;
      modifierIds?: string[];
      specialRequests?: string;
    }> = [];

    // Wall-clock "now" in the restaurant's own timezone, for daily menu
    // windows (breakfast until noon, lunch specials, happy hour).
    const restaurantTz = await getRestaurantTimezone(restaurantId);
    const nowHm = nowTimeInTz(restaurantTz);

    for (const itemInput of parsed.data.items) {
      const lookup = await lookupMenu({
        restaurantId,
        query: itemInput.name
      });
      if (lookup.matches.length === 0) {
        throw new AppError(
          404,
          "MENU_ITEM_NOT_FOUND",
          `I can't find "${itemInput.name}" on our menu. Want me to read what we have?`
        );
      }
      // If EVERY plausible match is a licensed item ("mojito" matching three
      // cocktail-list entries), skip the which-one question — the answer is
      // the same refusal regardless, and asking first is noise.
      const topMatches = lookup.matches.slice(0, 3);
      if (topMatches.every((m) => m.is_restricted)) {
        throw new AppError(
          400,
          "RESTRICTED_ITEM",
          `I can't take drink orders over the phone — licensing rules. I'll pop a note on the order and the team can sort it when you pick up.`
        );
      }
      if (lookup.ambiguous) {
        // Dedupe candidate names — identical names in two categories would
        // otherwise produce the unanswerable "Classic Mojito or Classic
        // Mojito?".
        const candidates = Array.from(new Set(topMatches.map((m) => m.name)));
        if (candidates.length > 1) {
          throw new AppError(400, "AMBIGUOUS_ITEM", `Did you mean ${candidates.join(" or ")}?`, {
            candidates
          });
        }
      }
      const top = lookup.matches[0]!;

      // Licensed items: never sold over the phone (responsible service of
      // alcohol). The item stays on the menu and staff can ring it up — Bella
      // takes a note instead.
      if (top.is_restricted) {
        throw new AppError(
          400,
          "RESTRICTED_ITEM",
          `I can't take drink orders over the phone — licensing rules. I'll pop a note on the order and the team can sort ${top.name} when you pick up.`
        );
      }

      // Daily windows: a breakfast item at 8pm gets a helpful redirect, not a
      // silent acceptance the kitchen can't honour.
      if (!isWithinDailyWindow(nowHm, top.available_from, top.available_until)) {
        const from = top.available_from ? formatVoiceTime(top.available_from.slice(0, 5)) : null;
        const until = top.available_until ? formatVoiceTime(top.available_until.slice(0, 5)) : null;
        const windowSpoken =
          from && until ? `between ${from} and ${until}` : from ? `from ${from}` : `until ${until}`;
        throw new AppError(
          400,
          "ITEM_NOT_AVAILABLE_NOW",
          `${top.name} is only served ${windowSpoken}. Want something from the all-day menu instead?`
        );
      }

      // Resolve variant by name within this menu item if provided.
      let variantId: string | undefined;
      const variantName = (itemInput.variant_name ?? itemInput.variantName ?? "").trim();
      if (variantName) {
        const fullMenu = await getMenu(restaurantId);
        const matchedItem = fullMenu.categories
          .flatMap((c) => c.items)
          .find((i) => i.id === top.id);
        const variant = matchedItem?.variants.find(
          (v) => v.name.toLowerCase() === variantName.toLowerCase()
        );
        if (!variant) {
          throw new AppError(
            400,
            "INVALID_VARIANT",
            `${top.name} doesn't come in ${variantName}. Options are ${matchedItem?.variants.map((v) => v.name).join(", ") || "standard"}.`
          );
        }
        variantId = variant.id;
      }

      // Resolve modifier choices by group_name + value(s).
      const modifierIds: string[] = [];
      const modifierChoices = itemInput.modifier_choices ?? itemInput.modifierChoices ?? {};
      if (Object.keys(modifierChoices).length > 0) {
        const fullMenu = await getMenu(restaurantId);
        const matchedItem = fullMenu.categories
          .flatMap((c) => c.items)
          .find((i) => i.id === top.id);
        for (const [groupName, choices] of Object.entries(modifierChoices)) {
          const group = matchedItem?.modifier_groups.find(
            (g) => g.group_name.toLowerCase() === groupName.toLowerCase()
          );
          if (!group) {
            throw new AppError(
              400,
              "UNKNOWN_MODIFIER_GROUP",
              `${top.name} doesn't have a ${groupName} option.`
            );
          }
          const choiceList = Array.isArray(choices) ? choices : [choices];
          for (const choice of choiceList) {
            const option = group.options.find(
              (o) => o.name.toLowerCase() === String(choice).toLowerCase()
            );
            if (!option) {
              throw new AppError(
                400,
                "UNKNOWN_MODIFIER",
                `${groupName} options are ${group.options.map((o) => o.name).join(", ")}. Which would you like?`
              );
            }
            modifierIds.push(option.id);
          }
        }
      }

      resolvedItems.push({
        menuItemId: top.id,
        variantId,
        quantity: itemInput.quantity,
        modifierIds: modifierIds.length ? modifierIds : undefined,
        specialRequests: itemInput.special_requests ?? itemInput.specialRequests
      });
    }

    // Pickup details ride along in special_instructions so they land on the
    // KDS ticket without a schema migration. They are also part of the
    // idempotency fingerprint below, which is what we want: two different
    // pickup orders in one call must not collide.
    const callerInstructions =
      parsed.data.special_instructions ?? parsed.data.specialInstructions;
    const pickupNote = reservationId
      ? undefined
      : ["Pickup:", pickupName, pickupTime ? `at ${pickupTime}` : ""]
          .filter(Boolean)
          .join(" ");
    // Pickup note first so the callout name always survives the cap. 700, not
    // the schema's per-field 500: both parts can legitimately coexist and the
    // column is TEXT \u2014 a silent 500 cut here would eat the tail of a real
    // allergy note.
    const specialInstructions =
      [pickupNote, callerInstructions].filter(Boolean).join(" \u2014 ").slice(0, 700) || undefined;

    // Audit B8: the key used to be the bare call_id, so ONE call could only
    // ever place ONE order — the guest added a Coke mid-call, heard the
    // confirmation (built from the FIRST order's items), and the Coke was
    // never made or billed. Keying on call + content keeps true retries of
    // the same tool call idempotent while letting a second, different order
    // in the same call go through.
    const idempotencyKey = callId
      ? `${callId}:${orderContentFingerprint(resolvedItems, specialInstructions)}`
      : undefined;

    // The audit-trail FK that existed since the KDS schema but was never
    // written on the voice path. persistRetellCall upserted the call log at
    // the top of this handler, so the row exists by now.
    const callLogId = providerCallId
      ? await getCallLogIdByProviderCallId("retell", providerCallId, restaurantId)
      : null;

    const result = await createOrder({
      restaurantId,
      reservationId,
      source: "voice",
      items: resolvedItems,
      specialInstructions,
      idempotencyKey,
      createdBy: "voice:retell",
      createdFromCallLogId: callLogId ?? undefined
    });

    return {
      order_id: result.order.id,
      order_number: result.order.order_number,
      confirmation_message: result.confirmationMessage,
      is_replay: result.isReplay
    };
  }

  if (name === "send_payment_link" || name === "sendpaymentlink") {
    const parsed = sendPaymentLinkRetellSchema.safeParse(args);
    if (!parsed.success) {
      throw new AppError(
        400,
        "SEND_PAYMENT_LINK_INVALID",
        `send_payment_link args invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    const orderId = parsed.data.order_id ?? parsed.data.orderId;
    if (!orderId) {
      throw new AppError(
        400,
        "PAYMENT_REQUIRES_ORDER",
        "I'll need to take the order first — what would you like?"
      );
    }
    // Recipient: a number the caller read out beats the caller ID; both go
    // through normalizePhone inside the service (withheld numbers refuse
    // politely, never dead-air).
    const phone =
      parsed.data.phone ??
      parsed.data.phone_number ??
      parsed.data.phoneNumber ??
      (call ? getCallerPhone(call) : null);

    const outcome = await createOrderPaymentLink({
      restaurantId,
      orderId,
      recipientPhone: phone,
      actor: "voice:retell",
      source: "voice"
    });

    // One flat shape for both branches — the LLM reads confirmation_message
    // aloud either way. The checkout URL is deliberately absent everywhere:
    // the model can't leak (or misread out) what it never sees.
    return {
      sent: outcome.sent,
      ...(outcome.sent
        ? {
            payment_id: outcome.paymentId,
            is_replay: outcome.isReplay,
            expires_in_minutes: outcome.expiresInMinutes
          }
        : { reason: outcome.code }),
      confirmation_message: outcome.confirmationMessage
    };
  }

  if (name === "modify_booking" || name === "modifybooking") {
    // Mid-call corrections: caller realises after create_booking that we got
    // the name wrong, or wants to change time / party / notes. Schema-validated
    // via modifyBookingRequestSchema — booking_id is required, everything
    // else partial. The schema accepts both snake_case (Retell convention) and
    // camelCase (defensive) keys.
    const parsed = modifyBookingRequestSchema.safeParse(args);
    if (!parsed.success) {
      throw new AppError(
        400,
        "MODIFY_BOOKING_INVALID",
        `modify_booking args invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`
      );
    }
    const result = await modifyBooking({ ...normalizeModifyBookingArgs(parsed.data), restaurantId });
    return {
      booking_id: result.bookingId,
      status: result.status,
      confirmation_message: result.confirmationMessage
    };
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

  // Resolve the tenant from the trusted call. The upsert overwrites
  // restaurant_id on conflict, so using a default here would CLOBBER the
  // correct tenant on every function_call/webhook — resolve it instead. If
  // unresolved in production, skip persisting rather than mislabel the row.
  const restaurantId = withDevDefault(await resolveRestaurantIdForCall(call));
  if (!restaurantId) {
    logger.warn({ evt: "retell_call_unresolved_tenant", provider_call_id: providerCallId });
    return;
  }

  const analysis = extractCallAnalysis(call);

  await upsertCallLog({
    restaurantId,
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
    endedAt: fromRetellTimestamp(call.end_timestamp),
    intent: analysis.intent,
    bookingOutcome: analysis.booking_outcome,
    userSentiment: analysis.user_sentiment,
    inVoicemail: analysis.in_voicemail,
    callSuccessful: analysis.call_successful,
    specialRequests: analysis.special_requests,
    callerName: analysis.caller_name,
    analysisJson: analysis.extras
  });
}

interface ExtractedAnalysis {
  intent: string | null;
  booking_outcome: string | null;
  user_sentiment: string | null;
  in_voicemail: boolean | null;
  call_successful: boolean | null;
  special_requests: string | null;
  caller_name: string | null;
  extras: Record<string, unknown> | null;
}

function extractCallAnalysis(call: RetellPayload): ExtractedAnalysis {
  const analysis = (call.call_analysis ?? {}) as Record<string, unknown>;
  const custom = (analysis.custom_analysis_data ?? {}) as Record<string, unknown>;

  const intent = normalizeEnum(custom.intent, ["book", "modify", "cancel", "info", "other"]);
  const booking_outcome = normalizeEnum(custom.booking_outcome, [
    "confirmed",
    "no_availability",
    "declined",
    "transferred",
    "none"
  ]);
  const user_sentiment = normalizeEnum(analysis.user_sentiment, [
    "positive",
    "neutral",
    "negative",
    "unknown"
  ]);
  const in_voicemail = typeof analysis.in_voicemail === "boolean" ? analysis.in_voicemail : null;
  const call_successful =
    typeof analysis.call_successful === "boolean" ? analysis.call_successful : null;
  const special_requests =
    typeof custom.special_requests === "string" && custom.special_requests.trim().length > 0
      ? custom.special_requests.trim()
      : null;
  const caller_name =
    typeof custom.caller_name === "string" && custom.caller_name.trim().length > 0
      ? custom.caller_name.trim()
      : null;

  // Spill any other custom fields into analysis_json so we don't lose anything
  // Retell or we add in the future.
  const knownCustomKeys = new Set([
    "intent",
    "booking_outcome",
    "special_requests",
    "caller_name"
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(custom)) {
    if (!knownCustomKeys.has(k)) extras[k] = v;
  }

  return {
    intent,
    booking_outcome,
    user_sentiment,
    in_voicemail,
    call_successful,
    special_requests,
    caller_name,
    extras: Object.keys(extras).length > 0 ? extras : null
  };
}

function normalizeEnum(value: unknown, allowed: string[]): string | null {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase().trim();
  return allowed.includes(v) ? v : null;
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

function normalizeAvailabilityArgs(args: Record<string, unknown>, restaurantId: string) {
  // SECURITY: LLM-supplied restaurant_id is ignored. The restaurantId is the
  // trusted value resolved from the dialed number / persisted call_log row, so
  // a crafted prompt can't redirect a booking to another restaurant.
  const parsed = availabilityRequestSchema.parse({
    date: args.date,
    time: args.time,
    party_size: args.party_size,
    partySize: args.partySize,
    seating_preference: args.seating_preference,
    seatingPreference: args.seatingPreference
  });
  const partySize = normalizePartySize(parsed);

  if (!partySize) {
    throw new AppError(400, "PARTY_SIZE_REQUIRED", "party_size is required.");
  }

  return {
    restaurantId,
    date: parsed.date,
    time: parsed.time,
    partySize,
    seatingPreference: (parsed.seating_preference ?? parsed.seatingPreference)?.trim()
  };
}

function normalizeBookingArgs(args: Record<string, unknown>, restaurantId: string) {
  // SECURITY: LLM-supplied restaurant_id ignored; restaurantId is the trusted
  // resolved tenant (see normalizeAvailabilityArgs).
  const parsed = createBookingRequestSchema.parse({
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
    seating_preference: args.seating_preference,
    seatingPreference: args.seatingPreference,
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

  // Stopgap (A): until Bella does real zone-aware allocation (B), fold any seating
  // preference into the booking notes so staff see it on the floor and can honour
  // it manually. Tagged so it's scannable, and capped to the notes column bound.
  const seatingPref = (parsed.seating_preference ?? parsed.seatingPreference)?.trim();
  const baseNotes = parsed.notes?.trim();
  let notes = baseNotes || undefined;
  if (seatingPref) {
    const tagged = `Seating preference: ${seatingPref}`;
    notes = (baseNotes ? `${tagged}\n${baseNotes}` : tagged).slice(0, 1000);
  }

  return {
    restaurantId,
    customerName,
    customerPhone,
    date: parsed.date,
    time: parsed.time,
    partySize,
    source: "voice" as const,
    notes,
    seatingPreference: seatingPref,
    callLogId: parsed.call_log_id ?? parsed.callLogId,
    provider: RETELL_PROVIDER,
    providerCallId: parsed.provider_call_id ?? parsed.providerCallId
  };
}

/**
 * Resolve the tenant for an in-call Retell event from TRUSTED sources only,
 * in priority order:
 *   1. the persisted call_logs row (written at inbound / first event from the
 *      dialed number),
 *   2. the dialed number on the call object (`to_number`) — works even when
 *      /retell/inbound never fired (static inbound_agent_id config),
 *   3. server-set call.metadata.restaurant_id (we wrote it; not LLM-influenced).
 *
 * Deliberately does NOT read retell_llm_dynamic_variables — those can be shaped
 * by prompt content and would reopen the cross-tenant injection vector. Returns
 * null when unresolved; callers apply withDevDefault + fail safe.
 */
async function resolveRestaurantIdForCall(call: RetellPayload | undefined): Promise<string | null> {
  const providerCallId = getProviderCallId(call);
  if (providerCallId) {
    const fromLog = await getRestaurantIdByProviderCallId(RETELL_PROVIDER, providerCallId);
    if (fromLog) return fromLog;
  }
  const toNumber = call?.to_number ?? call?.metadata?.inbound_to_number ?? null;
  const fromDialed = await getRestaurantIdByDialedNumber(toNumber);
  if (fromDialed) return fromDialed;
  const fromMeta = call?.metadata?.restaurant_id ?? call?.metadata?.restaurantId;
  if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  return null;
}

/**
 * Apply the dev-only default-tenant fallback. In production an unresolved id
 * stays null so callers fail safe (a misconfigured call must never book at the
 * default restaurant); in dev it falls back so local testing works.
 */
function withDevDefault(resolved: string | null): string | null {
  if (resolved) return resolved;
  return env.APP_ENV !== "production" ? env.DEFAULT_RESTAURANT_ID : null;
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
