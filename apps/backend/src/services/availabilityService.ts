import { AppError } from "../domain/errors";
import { DbClient, pool } from "../db/pool";
import { AvailabilityInput, AvailabilityResult } from "../domain/types";
import { findAvailableTable } from "../repositories/availability";
import { getMaxTableCapacity } from "../repositories/tables";
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
  // Did ANY candidate time fall inside opening hours? If none did, the venue is
  // shut — a different answer from "we're full", and one the caller can act on.
  let anyTimeWasOpen = false;

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
    anyTimeWasOpen = true;

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
    // Distinguish "we are busy" from "we could never seat you". Both used to
    // return the same sentence about the requested TIME, so a party of twelve
    // was invited to try another hour — nine offsets of advice that could not
    // possibly help. The venue's largest table is a hard ceiling: there is no
    // table-combining anywhere in the system, so one party must fit one table.
    // Closed beats capacity: if the venue is shut that day, the party size is
    // beside the point and quoting a table ceiling would be a non-sequitur.
    if (!anyTimeWasOpen) {
      return {
        available: false,
        reason: "closed",
        requestedTime: input.time,
        suggestedTime: null,
        suggestedTimes: [],
        tableIds: [],
        tableLabel: null,
        message:
          "We're closed then, so I can't book that time. Would another day suit?",
        naturalAlternativesMessage: null
      };
    }

    const maxCapacity = await getMaxTableCapacity(input.restaurantId, db);
    const partyTooLarge = maxCapacity !== null && input.partySize > maxCapacity;

    return {
      available: false,
      reason: partyTooLarge ? "party_too_large" : "no_availability",
      requestedTime: input.time,
      suggestedTime: null,
      suggestedTimes: [],
      tableIds: [],
      tableLabel: null,
      // maxCapacity === null means the venue has no active tables at all — a
      // misconfiguration, not a party-size problem, so it keeps the generic
      // wording rather than claiming "our largest table seats null".
      message: partyTooLarge
        ? `Our largest table seats ${maxCapacity}, so I can't fit a group of ${input.partySize} on one table. ` +
          `Let me take your name and number and the team will call you back to sort something out.`
        : "No suitable table is available near the requested time.",
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
    reason: exactMatch ? "available" : "no_availability",
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
