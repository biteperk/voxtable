import { Router } from "express";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireAnyMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  cancelBookingRequestSchema,
  createBookingRequestSchema,
  normalizePartySize,
  updateBookingRequestSchema
} from "../http/schemas";
import { cancelBooking, createBooking, modifyBooking } from "../services/bookingService";
import {
  completeReservation,
  getReservationForTenant,
  seatReservation
} from "../repositories/reservations";
import { z } from "zod";

export const bookingsRouter = Router();
const bookingIdParamSchema = z.string().uuid();
const FRONT_OF_HOUSE_ROLES = ["staff", "server", "manager", "owner"] as const;

// Dashboard-only mutation. The voice path bypasses HTTP and calls
// services/bookingService.createBooking directly, so we can safely gate
// this endpoint behind Firebase auth — protects against anonymous booking
// spam now that the dashboard explicitly POSTs here for manual entries.
bookingsRouter.post(
  "/bookings",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(FRONT_OF_HOUSE_ROLES),
  asyncHandler(async (request, response) => {
    const body = createBookingRequestSchema.parse(request.body);
    const customerName = body.customer_name ?? body.customerName;
    const customerPhone = body.customer_phone ?? body.customerPhone;
    const partySize = normalizePartySize(body);

    if (!customerName) {
      throw new AppError(400, "CUSTOMER_NAME_REQUIRED", "customer_name is required.");
    }

    if (!customerPhone) {
      throw new AppError(400, "CUSTOMER_PHONE_REQUIRED", "customer_phone is required.");
    }

    if (!partySize) {
      throw new AppError(400, "PARTY_SIZE_REQUIRED", "party_size is required.");
    }

    const result = await createBooking({
      restaurantId: tenantId(request),
      customerName,
      customerPhone,
      date: body.date,
      time: body.time,
      partySize,
      tableId: body.table_id ?? body.tableId,
      source: body.source,
      notes: body.notes,
      seatingPreference: body.seating_preference ?? body.seatingPreference,
      callLogId: body.call_log_id ?? body.callLogId,
      providerCallId: body.provider_call_id ?? body.providerCallId
    });

    response.status(201).json({
      booking_id: result.bookingId,
      status: result.status,
      confirmation_message: result.confirmationMessage
    });
  })
);

// PATCH and cancel are dashboard-only mutations — the voice path uses
// /retell/tools/modify-booking (HMAC-gated). Require Firebase auth so an
// attacker who learns a reservation UUID (URL leak, log scrape) can't
// silently change or cancel someone else's reservation.
bookingsRouter.patch(
  "/bookings/:id",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(FRONT_OF_HOUSE_ROLES),
  asyncHandler(async (request, response) => {
    const body = updateBookingRequestSchema.parse(request.body);
    const bookingId = bookingIdParamSchema.parse(request.params.id);

    const result = await modifyBooking({
      bookingId,
      date: body.date,
      time: body.time,
      partySize: body.party_size ?? body.partySize,
      notes: body.notes,
      status: body.status,
      restaurantId: tenantId(request)
    });

    response.json({
      booking_id: result.bookingId,
      status: result.status,
      confirmation_message: result.confirmationMessage
    });
  })
);

bookingsRouter.post(
  "/bookings/:id/cancel",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(FRONT_OF_HOUSE_ROLES),
  asyncHandler(async (request, response) => {
    const body = cancelBookingRequestSchema.parse(request.body);
    const bookingId = bookingIdParamSchema.parse(request.params.id);
    const result = await cancelBooking({
      bookingId,
      reason: body.reason,
      restaurantId: tenantId(request)
    });

    response.json({
      booking_id: result.bookingId,
      status: result.status,
      confirmation_message: result.confirmationMessage
    });
  })
);

// PR2 floor-state transitions. Single UPDATE in the repo; on no-op we do a
// follow-up SELECT to disambiguate 404 (truly missing) from 409 (already in
// the target state / cancelled / no_show). Matches the M3 cancel pattern.
bookingsRouter.post(
  "/bookings/:id/seat",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(FRONT_OF_HOUSE_ROLES),
  asyncHandler(async (request, response) => {
    const bookingId = bookingIdParamSchema.parse(request.params.id);
    const restaurantId = tenantId(request);
    const updated = await seatReservation(bookingId, restaurantId);

    if (!updated) {
      const existing = await getReservationForTenant(bookingId, restaurantId);
      if (!existing) {
        throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
      }
      throw new AppError(
        409,
        "BOOKING_NOT_SEATABLE",
        `Cannot seat reservation in status '${existing.status}' (seated_at=${existing.seated_at ?? "null"}, completed_at=${existing.completed_at ?? "null"}).`
      );
    }

    response.json({ reservation: updated });
  })
);

bookingsRouter.post(
  "/bookings/:id/complete",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(FRONT_OF_HOUSE_ROLES),
  asyncHandler(async (request, response) => {
    const bookingId = bookingIdParamSchema.parse(request.params.id);
    const restaurantId = tenantId(request);
    const updated = await completeReservation(bookingId, restaurantId);

    if (!updated) {
      const existing = await getReservationForTenant(bookingId, restaurantId);
      if (!existing) {
        throw new AppError(404, "BOOKING_NOT_FOUND", "Booking was not found.");
      }
      throw new AppError(
        409,
        "BOOKING_NOT_COMPLETABLE",
        `Cannot complete reservation in status '${existing.status}' (completed_at=${existing.completed_at ?? "null"}).`
      );
    }

    response.json({ reservation: updated });
  })
);
