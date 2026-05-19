import { AppError } from "../domain/errors";
import { DbClient, pool } from "../db/pool";
import { AvailabilityInput, AvailabilityResult } from "../domain/types";
import { findAvailableTable } from "../repositories/availability";
import { getRestaurantSettings } from "../repositories/restaurants";
import { formatVoiceTime, fromMinutes, isWithinOpeningHours, toMinutes } from "../utils/time";

const suggestionOffsets = [0, 30, -30, 60, -60, 90, -90, 120, -120];

export async function checkAvailability(
  input: AvailabilityInput,
  db: DbClient = pool
): Promise<AvailabilityResult> {
  const settings = await getRestaurantSettings(input.restaurantId, db);

  for (const offset of suggestionOffsets) {
    const candidateTime = fromMinutes(toMinutes(input.time) + offset);

    if (
      !isWithinOpeningHours(
        input.date,
        candidateTime,
        settings.bookingDurationMinutes,
        settings.openingHours
      )
    ) {
      continue;
    }

    const table = await findAvailableTable(
      {
        restaurantId: input.restaurantId,
        date: input.date,
        time: candidateTime,
        partySize: input.partySize,
        durationMinutes: settings.bookingDurationMinutes,
        excludeReservationId: input.excludeReservationId
      },
      db
    );

    if (!table) {
      continue;
    }

    const exactMatch = candidateTime === input.time;

    return {
      available: exactMatch,
      requestedTime: input.time,
      suggestedTime: candidateTime,
      tableIds: [table.id],
      tableLabel: table.label,
      message: exactMatch
        ? `Available at ${formatVoiceTime(candidateTime)}.`
        : `The requested time is not available. ${formatVoiceTime(candidateTime)} is available.`
    };
  }

  return {
    available: false,
    requestedTime: input.time,
    suggestedTime: null,
    tableIds: [],
    tableLabel: null,
    message: "No suitable table is available near the requested time."
  };
}

export function requireAvailableTable(result: AvailabilityResult): string {
  const tableId = result.tableIds[0];

  if (!result.available || !tableId) {
    throw new AppError(409, "BOOKING_NOT_AVAILABLE", result.message, result);
  }

  return tableId;
}
