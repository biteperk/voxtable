import { Router } from "express";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireAnyMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { availabilityRequestSchema, normalizePartySize } from "../http/schemas";
import { checkAvailability } from "../services/availabilityService";

export const availabilityRouter = Router();

// Dashboard-only availability probe (manual booking UI). The voice path calls
// the availabilityService directly, so this HTTP route is auth + tenant gated —
// it must never check/book against the default tenant for an anonymous caller.
availabilityRouter.post(
  "/availability/check",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(["staff", "server", "manager", "owner"]),
  asyncHandler(async (request, response) => {
    const body = availabilityRequestSchema.parse(request.body);
    const partySize = normalizePartySize(body);

    if (!partySize) {
      throw new AppError(400, "PARTY_SIZE_REQUIRED", "party_size is required.");
    }

    const result = await checkAvailability({
      restaurantId: tenantId(request),
      date: body.date,
      time: body.time,
      partySize
    });

    response.json({
      available: result.available,
      requested_time: result.requestedTime,
      suggested_time: result.suggestedTime,
      suggested_times: result.suggestedTimes,
      table_ids: result.tableIds,
      table_label: result.tableLabel,
      message: result.message,
      natural_alternatives_message: result.naturalAlternativesMessage
    });
  })
);
