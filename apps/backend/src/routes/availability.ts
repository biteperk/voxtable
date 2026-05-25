import { Router } from "express";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  availabilityRequestSchema,
  normalizePartySize,
  normalizeRestaurantId
} from "../http/schemas";
import { checkAvailability } from "../services/availabilityService";

export const availabilityRouter = Router();

availabilityRouter.post(
  "/availability/check",
  asyncHandler(async (request, response) => {
    const body = availabilityRequestSchema.parse(request.body);
    const partySize = normalizePartySize(body);

    if (!partySize) {
      throw new AppError(400, "PARTY_SIZE_REQUIRED", "party_size is required.");
    }

    const result = await checkAvailability({
      restaurantId: normalizeRestaurantId(body, env.DEFAULT_RESTAURANT_ID),
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
