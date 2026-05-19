import { AppError } from "../domain/errors";
import { BookingResult, CreateBookingInput, ReservationStatus } from "../domain/types";
import { pool } from "../db/pool";
import { attachReservationToCallLog, upsertCallLog } from "../repositories/callLogs";
import {
  cancelReservation,
  createReservation,
  getReservationById,
  updateReservation,
  upsertCustomer
} from "../repositories/reservations";
import { checkAvailability, requireAvailableTable } from "./availabilityService";
import { formatVoiceTime } from "../utils/time";

export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  const lockClient = await pool.connect();

  try {
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
      `${input.restaurantId}:${input.date}`
    ]);

    const callLogId =
      input.callLogId ??
      (input.providerCallId
        ? await upsertCallLog({
            restaurantId: input.restaurantId,
            provider: input.provider ?? "retell",
            providerCallId: input.providerCallId,
            callerPhone: input.customerPhone,
            status: "in_progress",
            startedAt: new Date().toISOString()
          }, lockClient)
        : undefined);

    const availability = await checkAvailability(
      {
        restaurantId: input.restaurantId,
        date: input.date,
        time: input.time,
        partySize: input.partySize
      },
      lockClient
    );
    const tableId = requireAvailableTable(availability);

    const customerId = await upsertCustomer(
      {
        restaurantId: input.restaurantId,
        name: input.customerName,
        phone: input.customerPhone
      },
      lockClient
    );

    const reservation = await createReservation(
      {
        restaurantId: input.restaurantId,
        customerId,
        tableId,
        date: input.date,
        time: input.time,
        partySize: input.partySize,
        source: input.source,
        notes: input.notes,
        callLogId
      },
      lockClient
    );

    if (callLogId) {
      await attachReservationToCallLog(callLogId, reservation.id, lockClient);
    }

    await lockClient.query("COMMIT");

    return {
      bookingId: reservation.id,
      status: reservation.status,
      confirmationMessage: `Confirmed. ${input.customerName} has a table for ${input.partySize} on ${input.date} at ${formatVoiceTime(input.time)}.`
    };
  } catch (error) {
    await lockClient.query("ROLLBACK");
    throw error;
  } finally {
    lockClient.release();
  }
}

export async function modifyBooking(input: {
  bookingId: string;
  date?: string;
  time?: string;
  partySize?: number;
  notes?: string;
  status?: ReservationStatus;
}): Promise<BookingResult> {
  const current = await getReservationById(input.bookingId);

  if (!current) {
    throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
  }

  const nextDate = input.date ?? current.reservation_date;
  const nextTime = input.time ?? current.start_time.slice(0, 5);
  const nextPartySize = input.partySize ?? current.party_size;
  const shouldRecheckAvailability =
    input.date !== undefined || input.time !== undefined || input.partySize !== undefined;

  let tableId: string | undefined;

  if (shouldRecheckAvailability && (input.status ?? current.status) !== "cancelled") {
    const availability = await checkAvailability({
      restaurantId: current.restaurant_id,
      date: nextDate,
      time: nextTime,
      partySize: nextPartySize,
      excludeReservationId: current.id
    });
    tableId = requireAvailableTable(availability);
  }

  const reservation = await updateReservation({
    id: current.id,
    tableId,
    date: input.date,
    time: input.time,
    partySize: input.partySize,
    notes: input.notes,
    status: input.status
  });

  return {
    bookingId: reservation.id,
    status: reservation.status,
    confirmationMessage: `Updated. The booking is now ${reservation.status}.`
  };
}

export async function cancelBooking(input: {
  bookingId: string;
  reason?: string;
}): Promise<BookingResult> {
  const reservation = await cancelReservation({
    id: input.bookingId,
    reason: input.reason
  });

  if (!reservation) {
    throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
  }

  return {
    bookingId: reservation.id,
    status: reservation.status,
    confirmationMessage: "Cancelled. The reservation has been cancelled."
  };
}
