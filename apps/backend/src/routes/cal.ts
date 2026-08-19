/**
 * `POST /cal/webhook` — Cal.com webhook receiver.
 *
 * Critical-path constraints:
 *   * MUST always 200 (or 4xx for bad input) — never 5xx. Cal.com retries 5xx
 *     forever which would amplify our outage.
 *   * MUST verify HMAC on the raw body BEFORE parsing as JSON.
 *   * MUST be idempotent — Cal.com retries are common, so the inbox table
 *     dedup'd by event_id is the source of truth.
 *   * Returns within ~100 ms — processing is decoupled from receipt. The
 *     route writes to the inbox and triggers async processing.
 *
 * Flag short-circuit: if `CALCOM_SYNC_ENABLED=false` the endpoint returns 410
 * Gone so a stale webhook config can't dribble events into a system that
 * isn't ready for them.
 */

import { Router } from "express";

import { env } from "../config/env";
import { AppError, PermanentInboxError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  markInboxDeadLettered,
  markInboxProcessed,
  markInboxRetry,
  recordInboxEvent
} from "../repositories/inbox";
import {
  computeInboxEventId,
  processInboxEvent,
  verifyCalcomSignature
} from "../services/calcomService";
import { calcomWebhookEnvelopeSchema } from "../services/calcomSchemas";
import { logger } from "../utils/logger";

type RequestWithRawBody = Express.Request & { rawBody?: string };

// How long before the retry worker first looks at a row the inline attempt
// failed on. Short: most inline failures are contention (a day lock, the pool)
// that clears in seconds, and the worker's own backoff takes over from there.
const INLINE_FAILURE_RETRY_MS = 15_000;

// Cal.com's own retry schedule backs off well past five minutes, which is what
// this used to be — so a legitimate vendor retry of an event we 5xx'd arrived
// outside the window, got a 400, and Cal.com stopped trying. The window exists
// to bound replay of a captured request, and an hour still does that: the
// signature covers the body, and inbox_calcom_events dedupes on it regardless.
const REPLAY_WINDOW_MS = 60 * 60 * 1000;

export const calRouter = Router();

calRouter.post(
  "/cal/webhook",
  asyncHandler(async (request, response) => {
    // Flag check first — if Cal.com sync is off, refuse loudly with 410 so
    // ops sees the misconfiguration in Cal.com's webhook delivery logs.
    if (!env.CALCOM_SYNC_ENABLED) {
      response.status(410).json({ error: "Cal.com sync is disabled." });
      return;
    }

    const raw = (request as RequestWithRawBody).rawBody ?? "";
    if (!raw) {
      throw new AppError(400, "CALCOM_EMPTY_BODY", "Webhook body was empty.");
    }

    // HMAC over the raw body. We constant-time compare inside verify.
    const signatureHeader =
      request.header("x-cal-signature-256") ?? request.header("x-cal-signature");
    if (!verifyCalcomSignature(raw, signatureHeader)) {
      throw new AppError(401, "CALCOM_SIGNATURE_INVALID", "Invalid Cal.com signature.");
    }

    // Schema-validate the envelope. Cal.com SHOULD always send a triggerEvent
    // + payload, but a corrupted retry / future API change could ship junk.
    // Better to reject with a clear 400 than to dereference garbage downstream.
    const parsed = calcomWebhookEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "CALCOM_ENVELOPE_INVALID",
        `Cal.com webhook envelope failed schema: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`
      );
    }
    const payload = parsed.data;
    const triggerEvent = payload.triggerEvent;
    const createdAt = payload.createdAt ?? "";

    // Replay-window guard: reject events outside the replay window. Cal.com retries
    // 5xx but should not be retrying ancient events with a fresh signature
    // (signatures are over the body, not the timestamp, so a replay attacker
    // could otherwise resubmit indefinitely).
    if (createdAt) {
      const ts = Date.parse(createdAt);
      if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
        throw new AppError(
          400,
          "CALCOM_REPLAY_REJECTED",
          `Cal.com event createdAt (${createdAt}) is outside the replay window.`
        );
      }
    }

    const eventId = computeInboxEventId(payload as Record<string, unknown>);

    // Persist before processing. ON CONFLICT DO NOTHING — replays are no-ops.
    const isFresh = await recordInboxEvent({
      eventId,
      triggerEvent,
      rawPayload: payload as Record<string, unknown>
    });

    if (!isFresh) {
      // Idempotent ack — Cal.com saw a non-2xx earlier and retried; we've
      // already recorded the event. Tell them we have it without re-processing.
      response.status(200).json({ status: "duplicate" });
      return;
    }

    // Process inline — fast (no Cal.com HTTP calls in the BOOKING_CANCELLED
    // path; BOOKING_CREATED may invoke bookingService which holds an advisory
    // lock briefly). Cap latency by tightening the body validation upstream
    // rather than introducing another queue here.
    try {
      await processInboxEvent({
        triggerEvent,
        createdAt,
        payload: payload.payload ?? {}
      });
      await markInboxProcessed(eventId);
      response.status(200).json({ status: "processed" });
    } catch (error) {
      // Still a 200: we have already accepted and persisted the event, and a
      // 5xx would make Cal.com retry on its own schedule forever.
      //
      // But this is now attempt ONE, not the end. The row stays claimable and
      // calcomInboxWorker picks it up when its backoff elapses. Before that
      // worker existed this branch only stamped an error, so a booking lost to
      // a lock wait or a pool timeout was lost for good — we did not retry it
      // and, because of the 200, neither did Cal.com.
      const message = (error as Error).message ?? String(error);

      // The inline path classifies exactly as the retry worker does, so the two
      // cannot drift. A refusal or an unmapped venue has already cancelled the
      // booking back on Cal.com — scheduling a retry would fire that cancel a
      // second time and, if it ever succeeded, create a reservation for a
      // booking the guest has been told is off.
      if (error instanceof PermanentInboxError) {
        await markInboxDeadLettered(eventId, `Not retryable: ${message}`);
        logger.error({ evt: "cal_webhook_process_permanent", event_id: eventId, error });
      } else {
        await markInboxRetry(eventId, message, INLINE_FAILURE_RETRY_MS);
        logger.error({ evt: "cal_webhook_process_failed", event_id: eventId, error });
      }
      response.status(200).json({ status: "deferred", reason: message });
    }
  })
);
