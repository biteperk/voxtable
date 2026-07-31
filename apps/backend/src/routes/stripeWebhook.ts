import { Router } from "express";
import type { Request } from "express";

import { asyncHandler } from "../http/asyncHandler";
import { withAdvisoryLock } from "../db/pool";
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
    } catch (error) {
      // Distinguish "this isn't from Stripe" from "we aren't configured to
      // check". verifyWebhookSignature throws 503 BILLING_NOT_CONFIGURED when
      // STRIPE_WEBHOOK_SECRET is missing or billing is switched off — reporting
      // that as a 400 tells Stripe never to retry, so a rotated secret would
      // silently drop every subscription event. Never swallow this silently:
      // the old bare `catch {}` here had no log line at all.
      const code = (error as { code?: string }).code;
      if (code === "BILLING_NOT_CONFIGURED") {
        logger.error({ evt: "stripe_webhook_not_configured", error });
        response.status(500).json({ error: "not_configured" });
        return;
      }
      logger.warn({ evt: "stripe_webhook_bad_signature", has_signature: Boolean(signature) });
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

    // The record-then-check above leaves a gap: if the SAME event is delivered
    // twice while the first is still in flight, the second sees "recorded but
    // not processed" and handles it again — double emails, double state writes.
    // Stripe re-delivers on timeout, so this is a routine occurrence, not a
    // corner case. Serialise per event id and let the loser ack as a duplicate.
    try {
      const attempt = await withAdvisoryLock(`stripe-webhook:${event.id}`, async () => {
        const outcome = await handleBillingWebhook(event);
        await markWebhookProcessed(event.id);
        return outcome;
      });

      if (!attempt.ran) {
        logger.info({ evt: "stripe_webhook_concurrent_duplicate", stripe_event: event.type });
        response.json({ received: true, duplicate: true });
        return;
      }
      response.json({ received: true, outcome: attempt.result });
    } catch (error) {
      await markWebhookFailed(event.id, (error as Error).message).catch(() => {});
      logger.error({ evt: "stripe_webhook_process_failed", stripe_event: event.type, error });
      // 500 → Stripe retries later; the event is left unprocessed and will be
      // re-derived idempotently on the next delivery.
      response.status(500).json({ received: false });
    }
  })
);
