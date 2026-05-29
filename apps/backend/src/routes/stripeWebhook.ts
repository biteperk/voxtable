import { Router } from "express";
import type { Request } from "express";

import { asyncHandler } from "../http/asyncHandler";
import { logger } from "../utils/logger";
import {
  isWebhookProcessed,
  markWebhookFailed,
  markWebhookProcessed,
  recordWebhookEvent
} from "../repositories/stripeWebhookEvents";
import { handleBillingWebhook } from "../services/stripeService";
import { verifyWebhookSignature } from "../services/stripeClient";

type RequestWithRawBody = Request & { rawBody?: string };

// Stripe billing webhook. Signature is verified against the RAW body (captured
// by express.json's verify hook in app.ts, the same mechanism /cal/webhook
// relies on). Idempotent + order-independent: dedupe on event id, and the
// handler derives onboarding state from the event's current data via the
// monotonic state machine, so reprocessing a retried event is safe.
//
// Status contract: 400 on a bad signature (Stripe won't retry-storm a 4xx);
// 200 on success / duplicate / unattributed; 500 only on an unexpected
// processing error so Stripe RETRIES later — safe because the event stays
// unprocessed and reprocessing is idempotent.
export const stripeWebhookRouter = Router();

stripeWebhookRouter.post(
  "/stripe/webhook",
  asyncHandler(async (request: RequestWithRawBody, response) => {
    const rawBody = request.rawBody ?? "";
    const signature = request.header("stripe-signature");

    let event;
    try {
      event = verifyWebhookSignature(rawBody, signature);
    } catch {
      response.status(400).json({ error: "invalid_signature" });
      return;
    }

    // Dedupe: skip only if already fully processed. A re-delivered event whose
    // first attempt failed (recorded but unprocessed) is reprocessed.
    const fresh = await recordWebhookEvent(event.id, event.type);
    if (!fresh && (await isWebhookProcessed(event.id))) {
      response.json({ received: true, duplicate: true });
      return;
    }

    try {
      const outcome = await handleBillingWebhook(event);
      await markWebhookProcessed(event.id);
      response.json({ received: true, outcome });
    } catch (error) {
      await markWebhookFailed(event.id, (error as Error).message).catch(() => {});
      logger.error({ evt: "stripe_webhook_process_failed", stripe_event: event.type, error });
      // 500 → Stripe retries later; the event is left unprocessed and will be
      // re-derived idempotently on the next delivery.
      response.status(500).json({ received: false });
    }
  })
);
