import { Retell } from "retell-sdk";

import { env } from "../config/env";
import { formatVenueFaq } from "./venueFaq";
import { AppError } from "../domain/errors";
import { CallStatus } from "../domain/types";
import {
  availabilityRequestSchema,
  createBookingRequestSchema,
  createOrderRetellSchema,
  menuLookupRetellSchema,
  sendPaymentLinkRetellSchema,
  checkPaymentStatusRetellSchema,
  modifyBookingRequestSchema,
  normalizeModifyBookingArgs,
  normalizePartySize
} from "../http/schemas";
import { getCallLogIdByProviderCallId, getRestaurantIdByProviderCallId, upsertCallLog } from "../repositories/callLogs";
import { enqueueNotification } from "../repositories/notifications";
import { isSmsEnabled, shouldTextOrderConfirmation } from "./notificationService";
import {
  getRestaurantIdByDialedNumber,
  getRestaurantName,
  getRestaurantVoiceContext,
  getRestaurantTimezone,
  getRetellAgentId,
  getVoicePausedAt,
  getOnboardingStatus
} from "../repositories/restaurants";
import { normalizePhone } from "../utils/phone";
import { enrichLogContext, logger } from "../utils/logger";
import type { OpeningHours } from "../domain/types";
import {
  dayNameInTz,
  formatDailyWindow,
  formatTodayStatus,
  isWithinDailyWindow,
  nowTimeInTz,
  todayInTz,
  tomorrowInTz
} from "../utils/time";
import { checkAvailability } from "./availabilityService";
import { createBooking, modifyBooking } from "./bookingService";
import { buildMenuHighlights, buildMenuStatus, getMenu, lookupMenu } from "./menuService";
import { searchMenuItemsByName } from "../repositories/menu";
import {
  claimOpsStateKey,
  getOpsState,
  listOpsStateByPrefix,
  purgeOpsStateByPrefix,
  setOpsState
} from "../repositories/opsState";
import { pool } from "../db/pool";
import { getOrderPaymentSnapshot } from "../repositories/orders";
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

// Retell's signature covers the body only — no timestamp, no nonce — so a
// captured /retell/tools/create-booking or send-payment-link request verified
// forever (#268). The body itself carries call.start_timestamp, and an attacker
// cannot strip or change it without breaking the signature, so bounding on it
// bounds the replay. Generous window: a call can legitimately run long, and a
// tool call always arrives while the call is live — hours, never days.
// Payloads with no call timestamp (e.g. inbound webhooks) are left alone: for
// them the window would add nothing the signature check doesn't already do.
const RETELL_REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;

export function assertRetellFreshness(body: unknown): void {
  if (!env.RETELL_VERIFY_SIGNATURE) return;
  const call = (body as RetellPayload | undefined)?.call as RetellPayload | undefined;
  const startTimestamp = Number(call?.start_timestamp);
  if (!Number.isFinite(startTimestamp) || startTimestamp <= 0) return;
  if (Math.abs(Date.now() - startTimestamp) > RETELL_REPLAY_WINDOW_MS) {
    throw new AppError(
      401,
      "RETELL_REPLAY_REJECTED",
      "Retell payload's call timestamp is outside the replay window."
    );
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

/**
 * Which Retell agent answers this call, and why.
 *
 * `RETELL_AGENT_ID` is a pre-multi-tenant relic: ONE agent for the whole
 * deployment. Letting an unprovisioned venue borrow it hands the caller another
 * venue's persona — the exact failure this path exists to prevent — so it is
 * allowed only outside production posture, for local single-tenant dev.
 * deploy-backend.yml already strips the variable from Cloud Run, so staging and
 * production get `none` and emit no override at all: Retell then falls back to
 * whatever the number itself carries, which on a correctly registered
 * webhook-mode number is nothing. Silence is the honest outcome for a venue
 * that was never finished being provisioned; another venue's greeting is not.
 *
 * Pure so the production branch is testable — `env` is parsed once at import,
 * so APP_ENV cannot be flipped inside a test that imports this module.
 */
/**
 * Does the agent have a number it can actually use?
 *
 * Exported so the withheld-caller-ID case is testable without a call: it is the
 * branch that decides whether the agent asks for a phone number, and getting it
 * wrong books a guest nobody can ring back.
 */
export function callerPhoneKnownFlag(callerPhoneForAgent: string): "yes" | "no" {
  return callerPhoneForAgent === "" ? "no" : "yes";
}

export function resolveOverrideAgentId(
  perRestaurantAgentId: string | null,
  appEnv: string,
  envAgentId: string | undefined
): { agentId: string | undefined; source: "venue" | "env" | "none" } {
  if (perRestaurantAgentId) return { agentId: perRestaurantAgentId, source: "venue" };
  if (appEnv !== "production" && envAgentId) return { agentId: envAgentId, source: "env" };
  return { agentId: undefined, source: "none" };
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
  // What the AGENT sees. A withheld caller ID arrives as "anonymous", and
  // passing that through meant the agent fed the literal string to
  // create_booking (400, live call 19 Aug 2026). "" tells the prompt to ask
  // the caller for a number instead. The call log keeps the raw value — for
  // forensics, "anonymous" is information.
  const callerPhoneForAgent = normalizePhone(callerPhoneRaw) ?? "";
  // Whether we have a usable number, said plainly. The prompt cannot reliably
  // branch on an empty string — "is {{caller_phone}} empty" asks a model to
  // reason about the absence of a value, and it guesses. A literal "yes"/"no"
  // is something it can match. Without this the agent skips asking a withheld
  // caller for a number and books them with no way to reach them.
  const callerPhoneKnown = callerPhoneKnownFlag(callerPhoneForAgent);

  // One cached query for the venue's identity + FAQ, one uncached query for the
  // agent id (kept separate so a rebind lands on the very next call), and one
  // uncached query for the pause flag (same reason — a pause must land now).
  const [venue, perRestaurantAgentId, voicePausedAt, onboardingStatus] = await Promise.all([
    getRestaurantVoiceContext(restaurantId),
    getRetellAgentId(restaurantId),
    getVoicePausedAt(restaurantId),
    // Uncached, same reason as the pause flag: a billing suspension must land on
    // the very next call. 'suspended' is written only by the billing lapse path,
    // so it is a safe proxy for "paused for non-payment".
    getOnboardingStatus(restaurantId)
  ]);
  const { timezone: tz, name: restaurantName, ownerName } = venue;

  // Kill switch: a paused venue routes to the shared "we're not taking bookings"
  // agent and hands it only the venue name. Return before the menu/hours queries
  // — the paused agent never uses them. If RETELL_PAUSED_AGENT_ID is unset we
  // send no override (the call falls through to the number's own handling); the
  // tool gate in handleRetellFunction is still the hard guarantee against a
  // booking. metadata.voice_paused is set either way so a call is attributable.
  if (voicePausedAt) {
    logger.warn({ evt: "voice_paused_inbound", restaurant_id: restaurantId });
    return {
      call_inbound: {
        ...(env.RETELL_PAUSED_AGENT_ID ? { override_agent_id: env.RETELL_PAUSED_AGENT_ID } : {}),
        dynamic_variables: { restaurant_name: restaurantName },
        metadata: { restaurant_id: restaurantId, source: "vocotable", voice_paused: "true" }
      }
    };
  }

  // Billing pause (recoverable): a venue unpaid past its grace window is
  // 'suspended'. Route it to the same "not taking bookings" agent as a manual
  // pause and stop before the menu/hours queries. Kept as a distinct signal from
  // voice_paused_at so an owner resuming a rush-pause never lifts a billing
  // suspension. It resumes automatically when Stripe reports the payment.
  if (onboardingStatus === "suspended") {
    logger.warn({ evt: "billing_suspended_inbound", restaurant_id: restaurantId });
    return {
      call_inbound: {
        ...(env.RETELL_PAUSED_AGENT_ID ? { override_agent_id: env.RETELL_PAUSED_AGENT_ID } : {}),
        dynamic_variables: { restaurant_name: restaurantName },
        metadata: { restaurant_id: restaurantId, source: "vocotable", billing_suspended: "true" }
      }
    };
  }

  const agentChoice = resolveOverrideAgentId(perRestaurantAgentId, env.APP_ENV, env.RETELL_AGENT_ID);
  const overrideAgentId = agentChoice.agentId;
  if (agentChoice.source === "env") {
    logger.warn({
      evt: "retell_inbound_env_agent_fallback",
      restaurant_id: restaurantId,
      agent_id: overrideAgentId
    });
  } else if (agentChoice.source === "none") {
    logger.error({
      evt: "retell_inbound_no_agent_bound",
      restaurant_id: restaurantId,
      to_number: inbound.to_number ?? null
    });
  }

  await upsertCallLog({
    restaurantId,
    provider: RETELL_PROVIDER,
    providerCallId: getProviderCallId(inbound),
    callerPhone,
    status: "started",
    startedAt: new Date().toISOString()
  });

  const now = new Date();
  // Both menu variables are computed together. buildMenuStatus used to be a
  // bare `await` inside the response literal; adding a second one there would
  // have put another serial DB round-trip on /retell/inbound, the one path that
  // must not get slower. Both fail open to "" on their own.
  const menuNowHm = nowTimeInTz(tz, now);
  const [menuStatus, menuHighlights] = await Promise.all([
    buildMenuStatus(restaurantId, menuNowHm),
    buildMenuHighlights(restaurantId, menuNowHm)
  ]);
  return {
    call_inbound: {
      ...(overrideAgentId ? { override_agent_id: overrideAgentId } : {}),
      dynamic_variables: {
        restaurant_id: restaurantId,
        restaurant_name: restaurantName,
        // Supplied so prompts can name the owner without baking one in.
        owner_name: ownerName,
        // The venue's own answers to parking / access / dietary / BYO style
        // questions. "" when the venue has none, which the prompt treats as
        // "offer to take a message" — never invent an answer.
        venue_faq: formatVenueFaq(venue.faq, restaurantId),
        restaurant_timezone: tz,
        caller_phone: callerPhoneForAgent,
        caller_phone_known: callerPhoneKnown,
        today: todayInTz(tz, now),
        tomorrow: tomorrowInTz(tz, now),
        now_local: nowTimeInTz(tz, now),
        weekday_local: dayNameInTz(tz, now),
        // Precomputed open/closed sentence the agent speaks verbatim — no
        // mid-call reasoning over the hours table, no check_availability call
        // just to learn today is a closed day. "" = no hours configured.
        today_status: formatTodayStatus(venue.openingHours as OpeningHours, tz, now),
        // Same doctrine for menu periods (call_4e871f4b, 30 Aug 2026: three
        // haloumi variants offered for a 2 PM pickup, one breakfast-only, one
        // late-night-only; the order was refused only at create_order and the
        // caller gave up). Precomputed, spoken verbatim, "" when the venue has
        // no windowed items. Fail-open inside buildMenuStatus.
        menu_status: menuStatus,
        // The owner's own ranked picks, in his order, preloaded so the agent
        // can answer "what do you recommend?" instantly instead of spending a
        // tool round-trip — and so it recommends what the venue wants sold
        // rather than whatever the search index surfaces. "" = nothing ranked,
        // and the prompt falls back to menu_lookup.
        menu_highlights: menuHighlights
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

/**
 * Above the venue's auto-book ceiling the agent takes a message instead.
 *
 * The venue owner asked for anything above a small party to reach him
 * personally. Enforced here rather than in the prompt because otherwise
 * check_availability happily reports a real free table for a larger party, and
 * an agent told a table is free will book it.
 */
export function partyTooLargeResponse(
  partySize: number,
  ownerName: string | null
): {
  available: false;
  success: false;
  reason: "party_needs_venue";
  message: string;
  natural_alternatives_message: string;
  confirmation_message: string;
} {
  const who = ownerName?.trim() ? ownerName.trim() : "the team";
  const message =
    `For a group of ${partySize} I'll get ${who} to give you a call and sort it out properly — ` +
    `could I grab your name and the best number to reach you on?`;
  return {
    available: false,
    success: false,
    reason: "party_needs_venue",
    message,
    natural_alternatives_message: message,
    confirmation_message: message
  };
}

/**
 * What the agent should do after an availability result. Kept out of the prompt
 * because a tool result is read at decision time and prompt prose is not: the
 * agent must confirm the booking with the caller exactly once and wait for a
 * yes before it commits, even when the caller gave every detail up front.
 */
export function availabilityNextStep(result: {
  available: boolean;
  reason?: string;
  suggestedTimes?: string[];
}): string | undefined {
  if (result.reason === "party_too_large" || result.reason === "party_needs_venue") {
    return undefined;
  }
  if (result.available) {
    return (
      "Do NOT call create_booking in this turn, and do not repeat the date, time or party size now. " +
      "If you do not have the booking name yet, ask for it — nothing else. Once you have the name, " +
      "read the booking back ONCE — party, time, date and name — ending with 'shall I lock it in?', " +
      "then WAIT for their yes."
    );
  }
  if (result.suggestedTimes && result.suggestedTimes.length > 0) {
    return (
      "Offer the suggested times without repeating the party size or date. Once the caller picks one, " +
      "ask for the booking name if you do not have it, then read the booking back ONCE — party, time, " +
      "date and name — ending with 'shall I lock it in?', and WAIT for their yes before create_booking."
    );
  }
  return undefined;
}

/** Is this party above the venue's auto-book ceiling? 0 disables the cap. */
export function exceedsAutoBookCap(partySize: number | undefined, cap: number): boolean {
  if (!cap || cap <= 0) return false;
  return typeof partySize === "number" && Number.isFinite(partySize) && partySize > cap;
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

  // Per-venue kill switch. A caller who reached the paused agent never gets here
  // (it has no tools), so this exists for the RACE: a call already in flight on
  // the real agent when the owner pauses stays on the real agent (the inbound
  // override is per-call), and this is what stops it booking. Refused with the
  // same response as the global VOICE_BOOKING_ENABLED gate above.
  if (await getVoicePausedAt(restaurantId)) {
    logger.warn({ evt: "voice_paused_refusal", tool: name, restaurant_id: restaurantId });
    return voiceBookingDisabledResponse();
  }

  // Billing pause: a venue suspended for non-payment must not book, even for a
  // call already in flight when the sweep suspended it. Same refusal as above.
  if ((await getOnboardingStatus(restaurantId)) === "suspended") {
    logger.warn({ evt: "billing_suspended_refusal", tool: name, restaurant_id: restaurantId });
    return voiceBookingDisabledResponse();
  }

  // The cap is checked before availability, not after. If she is told a table
  // exists she will offer it, and taking it back reads as the system failing.
  const requestedPartySize = Number(
    (args.party_size ?? args.partySize ?? args.partysize) as unknown
  );
  if (
    (name === "check_availability" ||
      name === "checkavailability" ||
      name === "create_booking" ||
      name === "createbooking") &&
    exceedsAutoBookCap(requestedPartySize, env.VOICE_AUTOBOOK_MAX_PARTY)
  ) {
    const venue = await getRestaurantVoiceContext(restaurantId);
    logger.info({
      evt: "party_above_autobook_cap",
      tool: name,
      restaurant_id: restaurantId,
      party_size: requestedPartySize,
      cap: env.VOICE_AUTOBOOK_MAX_PARTY
    });
    return partyTooLargeResponse(requestedPartySize, venue.ownerName);
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
      // Lets the prompt tell "we're busy, try another time" apart from "we can
      // never seat this many" — the second must offer a callback, not a slot.
      reason: result.reason,
      requested_time: result.requestedTime,
      suggested_time: result.suggestedTime,
      suggested_times: result.suggestedTimes,
      table_label: result.tableLabel,
      message: result.message,
      natural_alternatives_message: result.naturalAlternativesMessage,
      // Read by the model at the exact moment it decides what to do next, which
      // is where prompt prose kept losing: with everything front-loaded the
      // agent chained check_availability → create_booking in one turn and never
      // asked the caller (issue #389, F2). One mishearing of "eight" for "three"
      // then books the wrong table. The instruction rides on the result instead.
      next_step: availabilityNextStep(result)
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
      // Short and detail-free: the agent reads it verbatim and moves on. The
      // facts travel as fields so a mismatch with what the caller agreed to
      // can be spoken as a difference, not as a recap.
      confirmation_message: result.confirmationMessage,
      customer_name: result.customerName,
      date: result.date,
      time: result.time,
      party_size: result.partySize
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
    // Window annotations are judged at the venue's current wall clock, so the
    // agent knows at OFFER time what the kitchen will refuse at ORDER time.
    const result = await lookupMenu({
      restaurantId,
      query: parsed.data.query,
      category: parsed.data.category,
      nowHm: nowTimeInTz(await getRestaurantTimezone(restaurantId))
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

    // Wall-clock time the food will actually be SERVED, in the restaurant's
    // own timezone, for daily menu windows (breakfast until noon, lunch
    // specials, happy hour). The window used to be checked against the time of
    // the CALL — on call_4e871f4b (30 Aug) that was coincidentally right, but
    // a 10 AM caller ordering a breakfast item for 2 PM pickup would have
    // passed, and a 4 PM caller pre-ordering tomorrow's breakfast would have
    // been refused. When a parseable pickup time exists, judge that; otherwise
    // fall back to now.
    const restaurantTz = await getRestaurantTimezone(restaurantId);
    const pickupHm = /^([01]?\d|2[0-3]):[0-5]\d/.exec(pickupTime)?.[0] ?? null;
    const serveHm = pickupHm ?? nowTimeInTz(restaurantTz);

    for (const itemInput of parsed.data.items) {
      // Before trusting the best AVAILABLE match, check whether what the caller
      // actually said matches something the kitchen has switched off. Without
      // this the unavailable item simply disappears and the next-best row is
      // taken silently: on 26 Aug 2026 "Fish & Chips" (off, $22) became "Chips"
      // ($9) — Bella said "fish and chips" the whole call, the kitchen got
      // chips, and the caller paid for chips. A substitution nobody agreed to
      // is worse than a refusal, because only the refusal can be corrected.
      const withUnavailable = await searchMenuItemsByName(restaurantId, itemInput.name, 6, {
        includeUnavailable: true
      });
      const bestOverall = withUnavailable[0];
      if (bestOverall && !bestOverall.is_available) {
        const bestAvailable = withUnavailable.find((m) => m.is_available);
        // Only when the unavailable item is a genuinely better match than
        // anything sellable — otherwise an off item with a vaguely similar name
        // would block an order the caller really did mean.
        if (!bestAvailable || bestOverall.similarity > bestAvailable.similarity + 0.05) {
          logger.info({
            evt: "order_item_unavailable_refused",
            restaurant_id: restaurantId,
            requested: itemInput.name,
            matched: bestOverall.name
          });
          throw new AppError(
            400,
            "ITEM_UNAVAILABLE",
            `Sorry, ${bestOverall.name} isn't available at the moment. Would you like something else?`,
            { item_name: bestOverall.name }
          );
        }
      }

      const lookup = await lookupMenu({
        restaurantId,
        query: itemInput.name,
        nowHm: serveHm
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
      // silent acceptance the kitchen can't honour. Judged at serve time, not
      // call time (see serveHm above).
      if (!isWithinDailyWindow(serveHm, top.available_from, top.available_until)) {
        const windowSpoken = formatDailyWindow(top.available_from, top.available_until);
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

    // Takeaway confirmation text. A guest who orders on the phone walks away with
    // nothing to look at — no name, no pickup time, no total — and rings back to
    // check. The payment-link path already proves this outbox route works; this
    // is the same enqueue for an order nobody is paying for up front.
    //
    // Deliberately narrow:
    //   - takeaway only. A dine-in pre-order is attached to a booking whose own
    //     confirmation already went out.
    //   - never on a replay, or a retried tool call texts the guest twice.
    //   - never throws. The order is already in the kitchen; a failed SMS must
    //     not turn a good order into an apology.
    // isSmsEnabled() matters as much as the flag: without a configured sender the
    // worker never claims these rows, so they would sit pending and then all flush
    // the moment a sender is switched on — texting people about orders they picked
    // up hours earlier. Booking SMS has always gated this way; this did not, and
    // the deploy-then-configure order would have built exactly that backlog.
    const smsTo = normalizePhone(call ? getCallerPhone(call) : null);
    // smsTo repeated in the condition so TypeScript narrows it to a string; the
    // predicate owns the policy, this owns the type.
    if (
      smsTo !== null &&
      shouldTextOrderConfirmation({
        isTakeaway: !reservationId,
        isReplay: result.isReplay,
        flagEnabled: env.ORDER_CONFIRMATION_SMS_ENABLED,
        senderConfigured: isSmsEnabled(),
        hasPhone: true
      })
    ) {
      try {
        const venue = await getRestaurantName(restaurantId);
        const when = pickupTime ? ` Ready ${pickupTime}.` : "";
        await enqueueNotification({
          restaurantId,
          channel: "sms",
          recipient: smsTo,
          kind: "order_confirmation",
          // "Do not reply": the BitePerk sender ID is alphanumeric and one-way, so a
          // guest replying "can I add chips" gets silence and assumes we read it.
          // Same wording as the booking texts.
          body:
            `${venue}: ${result.confirmationMessage}${when} Order under ${pickupName}. ` +
            `Questions? Call the venue. Do not reply.`
        });
      } catch (error) {
        logger.error({
          evt: "order_confirmation_sms_enqueue_failed",
          order_id: result.order.id,
          error
        });
      }
    }

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

    // Start the watcher. The order_payments row is the durable record; this
    // call-scoped key is what the payment checks read to know how many times
    // they have looked and what they last saw, and what the call-end backstop
    // looks for when deciding whether a guest was left mid-payment.
    if (outcome.sent) {
      // Same scoping rule as check_payment_status, so the two agree on the key.
      const watchCallId = parsed.data.call_id ?? parsed.data.callId ?? null;
      const watchScope = watchCallId ? `${watchCallId}:${orderId}` : `order:${orderId}`;
      await setOpsState(`payment_watch:${watchScope}`, {
        order_id: orderId,
        restaurant_id: restaurantId,
        state: "unpaid",
        checks: 0,
        started_at: new Date().toISOString()
      });
      logger.info({
        evt: "payment_watch_started",
        restaurant_id: restaurantId,
        order_id: orderId,
        call_id: watchCallId
      });
    }

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
    const result = await modifyBooking({
      ...normalizeModifyBookingArgs(parsed.data),
      restaurantId,
      source: "voice"
    });
    return {
      booking_id: result.bookingId,
      status: result.status,
      confirmation_message: result.confirmationMessage,
      customer_name: result.customerName,
      date: result.date,
      time: result.time,
      party_size: result.partySize
    };
  }

  if (name === "check_payment_status" || name === "checkpaymentstatus") {
    // A caller who has just paid asks "did that go through?". Before this tool
    // Bella answered "I can't see payment status on my end" — true at the time,
    // and a poor answer when the money has moved and the system knows it.
    const parsed = checkPaymentStatusRetellSchema.safeParse(args);
    if (!parsed.success) {
      throw new AppError(
        400,
        "CHECK_PAYMENT_STATUS_INVALID",
        `check_payment_status args invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    const orderId = parsed.data.order_id ?? parsed.data.orderId;
    if (!orderId) {
      throw new AppError(
        400,
        "PAYMENT_STATUS_REQUIRES_ORDER",
        "I'll need to take the order first — what would you like?"
      );
    }

    // Primary, not the replica, and three states not two — see
    // getOrderPaymentSnapshot for why both matter in this exact moment.
    const snapshot = await getOrderPaymentSnapshot(orderId, restaurantId);
    if (!snapshot) {
      throw new AppError(404, "ORDER_NOT_FOUND", "I can't find that order — let me take it again.");
    }

    // Scope to THIS call so a guest who rings back is told again. Without a
    // call_id we fall back to the order alone: announce once ever, rather than
    // crash or announce every time.
    const callId = parsed.data.call_id ?? parsed.data.callId ?? null;
    const scope = callId ? `${callId}:${orderId}` : `order:${orderId}`;
    const watchKey = `payment_watch:${scope}`;
    const announcedKey = `payment_announced:${scope}`;

    // pool, not the default readPool: this key was written by the PREVIOUS check
    // moments earlier, and a replica read cannot see it yet. That kept check_count
    // pinned at 1 on every call, which quietly made the three-check ceiling
    // unreachable — she would have polled forever. Same replica trap as the
    // payment read above; fixing one and not the other fixed nothing.
    const watch = await getOpsState(watchKey, pool);
    const previousState = (watch?.value as { state?: string } | undefined)?.state ?? null;
    const checkCount = Number((watch?.value as { checks?: number } | undefined)?.checks ?? 0) + 1;

    if (previousState && previousState !== snapshot.state) {
      logger.info({
        evt: "payment_state_changed",
        restaurant_id: restaurantId,
        order_id: orderId,
        call_id: callId,
        from: previousState,
        to: snapshot.state
      });
    }
    await setOpsState(watchKey, {
      order_id: orderId,
      restaurant_id: restaurantId,
      state: snapshot.state,
      checks: checkCount,
      updated_at: new Date().toISOString()
    });
    logger.info({
      evt: "payment_check",
      restaurant_id: restaurantId,
      order_id: orderId,
      call_id: callId,
      state: snapshot.state,
      check_count: checkCount
    });

    // Announce-once is decided by Postgres, not by the prompt: an atomic claim
    // cannot be won twice, so two overlapping tool calls can never both break
    // the news. A prompt instruction here would be a request, not a guarantee.
    let announce = false;
    if (snapshot.state === "paid") {
      announce = await claimOpsStateKey(announcedKey, {
        order_id: orderId,
        restaurant_id: restaurantId,
        announced_at: new Date().toISOString()
      });
      if (announce) {
        logger.info({
          evt: "payment_announced",
          restaurant_id: restaurantId,
          order_id: orderId,
          call_id: callId
        });
      }
    }

    // One flat shape; the LLM reads confirmation_message aloud either way, so a
    // caller never hears a status code. `processing` is deliberately neither
    // success nor failure — an in-flight payment reported as failed sends a
    // guest to pay twice.
    const message =
      snapshot.state === "paid"
        ? announce
          ? "Beautiful — that's come through. You're all set."
          : "Yep, still all good — that's paid."
        : snapshot.state === "processing"
          ? "I can see the payment's processing — I'll keep an eye on it."
          : snapshot.state === "refunded"
            ? "That one shows as refunded — the team can sort it out for you."
            : "Not showing as paid just yet. No rush — or you can simply pay when you arrive.";

    return {
      paid: snapshot.state === "paid",
      state: snapshot.state,
      announce,
      check_count: checkCount,
      order_number: snapshot.orderNumber,
      confirmation_message: message
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

  // A guest can be mid-payment when a call ends — including when they simply
  // hang up, which never reaches end_call and so never reaches any prompt rule.
  // This webhook fires for those calls too, so the record is made right here
  // rather than depending on what the model did.
  if (event === "call_ended" || event === "call_analyzed") {
    await reconcilePaymentWatchers(providerCallId, restaurantId);
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

/**
 * Close out any payment watcher left open when the call ended.
 *
 * The pre-end_call check in the prompt makes the CALLER's experience right; it
 * cannot make the RECORD right, because end_call is Retell's own tool and a
 * caller who hangs up never reaches it. A watcher with no announcement means
 * someone was mid-payment when the line dropped — worth one log line and worth
 * being queryable, rather than inferred later from silence.
 *
 * Never throws into the webhook: a bookkeeping failure must not make Retell
 * retry a call event.
 */
async function reconcilePaymentWatchers(providerCallId: string, restaurantId: string): Promise<void> {
  try {
    const watchers = await listOpsStateByPrefix(`payment_watch:${providerCallId}:`);
    for (const watcher of watchers) {
      const orderId = (watcher.value as { order_id?: string } | undefined)?.order_id ?? null;
      const state = (watcher.value as { state?: string } | undefined)?.state ?? "unknown";
      const scope = watcher.key.slice("payment_watch:".length);
      const announced = await getOpsState(`payment_announced:${scope}`);
      if (!announced) {
        logger.warn({
          evt: "payment_watch_unresolved",
          restaurant_id: restaurantId,
          provider_call_id: providerCallId,
          order_id: orderId,
          last_state: state
        });
      }
    }
    if (watchers.length > 0) {
      await purgeOpsStateByPrefix(`payment_watch:${providerCallId}:`, "0 seconds");
    }
  } catch (error) {
    logger.warn({ evt: "payment_watch_reconcile_failed", provider_call_id: providerCallId, error });
  }
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
