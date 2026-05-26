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
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { markInboxFailed, markInboxProcessed, recordInboxEvent } from "../repositories/inbox";
import {
  computeInboxEventId,
  processInboxEvent,
  verifyCalcomSignature
} from "../services/calcomService";

type RequestWithRawBody = Express.Request & { rawBody?: string };

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

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

    const payload = request.body as Record<string, unknown>;
    const triggerEvent = String(payload?.triggerEvent ?? "");
    const createdAt = String(payload?.createdAt ?? "");

    // Replay-window guard: reject events older than 5 minutes. Cal.com retries
    // 5xx but should not be retrying ancient events with a fresh signature
    // (signatures are over the body, not the timestamp, so a replay attacker
    // could otherwise resubmit indefinitely).
    if (createdAt) {
      const ts = Date.parse(createdAt);
      if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
        throw new AppError(
          400,
          "CALCOM_REPLAY_REJECTED",
          `Cal.com event createdAt (${createdAt}) is outside the 5-minute replay window.`
        );
      }
    }

    const eventId = computeInboxEventId(payload);

    // Persist before processing. ON CONFLICT DO NOTHING — replays are no-ops.
    const isFresh = await recordInboxEvent({
      eventId,
      triggerEvent,
      rawPayload: payload
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
        payload: (payload.payload as Record<string, unknown>) ?? {}
      });
      await markInboxProcessed(eventId);
      response.status(200).json({ status: "processed" });
    } catch (error) {
      // Mark the inbox row failed so ops can replay manually. Don't 5xx —
      // we already accepted the event and persisted it; retrying via Cal.com
      // won't help (deterministic failure most likely).
      const message = (error as Error).message ?? String(error);
      await markInboxFailed(eventId, message);
      console.error(
        JSON.stringify({ evt: "cal_webhook_process_failed", event_id: eventId, error: message })
      );
      response.status(200).json({ status: "deferred", reason: message });
    }
  })
);
