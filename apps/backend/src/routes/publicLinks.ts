import { Router } from "express";

import { asyncHandler } from "../http/asyncHandler";
import { publicLinkLimiter } from "../http/rateLimiters";
import { logger } from "../utils/logger";
import { resolvePayLink, resolveReceiptLink } from "../services/orderPaymentService";

/**
 * Guest-facing short links carried in the payment and receipt texts.
 *
 * PUBLIC and unauthenticated by design: the guest has no account. Firebase
 * Hosting rewrites /pay/** and /receipt/** on the dashboard host to this API,
 * which answers a 302 - no page load, no JavaScript, no CORS. The token is the
 * only credential, so: validate its shape before touching the database, never
 * cache, never echo the token or the Stripe URL into a log, and send every
 * non-pay outcome to the same branded page so a response never says whether a
 * token exists.
 */
export const publicLinksRouter = Router();

publicLinksRouter.get(
  "/pay/:token",
  publicLinkLimiter,
  asyncHandler(async (request, response) => {
    const resolution = await resolvePayLink(String(request.params.token ?? ""));
    logger.info({ evt: "public_pay_link", outcome: resolution.outcome });
    response.set("Cache-Control", "no-store").redirect(302, resolution.location);
  })
);

publicLinksRouter.get(
  "/receipt/:token",
  publicLinkLimiter,
  asyncHandler(async (request, response) => {
    const resolution = await resolveReceiptLink(String(request.params.token ?? ""));
    logger.info({ evt: "public_receipt_link", outcome: resolution.outcome });
    response.set("Cache-Control", "no-store").redirect(302, resolution.location);
  })
);
