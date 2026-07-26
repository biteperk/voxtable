import { AppError } from "../domain/errors";
import { DbClient, pool } from "../db/pool";
import { AvailabilityInput, AvailabilityResult } from "../domain/types";
import { findAvailableTable } from "../repositories/availability";
import { getRestaurantSettings } from "../repositories/restaurants";
import { formatVoiceTime, fromMinutes, isWithinOpeningHours, toMinutes } from "../utils/time";

const suggestionOffsets = [0, 30, -30, 60, -60, 90, -90, 120, -120];
const MAX_ALTERNATIVES = 3;

export async function checkAvailability(
  input: AvailabilityInput,
  db: DbClient = pool
): Promise<AvailabilityResult> {
  const settings = await getRestaurantSettings(input.restaurantId, db);

  let primary: { time: string; tableId: string; tableLabel: string | null } | null = null;
  const alternatives: string[] = [];

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
        seatingPreference: input.seatingPreference,
        excludeReservationId: input.excludeReservationId
      },
      db
    );

    if (!table) {
      continue;
    }

    if (!primary) {
      primary = { time: candidateTime, tableId: table.id, tableLabel: table.label };
      if (candidateTime === input.time) {
        // Exact match — still keep walking other offsets to collect alts the
        // LLM can offer if the caller wants to shift.
        continue;
      }
    } else if (alternatives.length < MAX_ALTERNATIVES && candidateTime !== primary.time) {
      alternatives.push(candidateTime);
    }

    if (primary && alternatives.length >= MAX_ALTERNATIVES) break;
  }

  if (!primary) {
    return {
      available: false,
      requestedTime: input.time,
      suggestedTime: null,
      suggestedTimes: [],
      tableIds: [],
      tableLabel: null,
      message: "No suitable table is available near the requested time.",
      naturalAlternativesMessage: null
    };
  }

  const exactMatch = primary.time === input.time;
  const allTimes = [primary.time, ...alternatives];
  const naturalAlternativesMessage =
    !exactMatch && alternatives.length > 0
      ? `I can offer ${humanJoin(allTimes.map(formatVoiceTime))}.`
      : alternatives.length > 0
        ? `I can also offer ${humanJoin(alternatives.map(formatVoiceTime))} if that suits.`
        : null;

  return {
    available: exactMatch,
    requestedTime: input.time,
    suggestedTime: primary.time,
    suggestedTimes: allTimes,
    tableIds: [primary.tableId],
    tableLabel: primary.tableLabel,
    message: exactMatch
      ? `Available at ${formatVoiceTime(primary.time)}.`
      : `The requested time is not available. ${formatVoiceTime(primary.time)} is available.`,
    naturalAlternativesMessage
  };
}

function humanJoin(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

export function requireAvailableTable(result: AvailabilityResult): string {
  const tableId = result.tableIds[0];

  if (!result.available || !tableId) {
    throw new AppError(409, "BOOKING_NOT_AVAILABLE", result.message, result);
  }

  return tableId;
}
