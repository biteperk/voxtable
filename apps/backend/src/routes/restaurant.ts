import { Router } from "express";

import { AuthenticatedRequest, requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { restaurantProfileSchema, supportRequestSchema } from "../http/schemas";
import {
  findDuplicateRestaurant,
  getOnboardingStatus,
  getRestaurantProfile,
  getRestaurantSettings,
  setOnboardingStatus,
  updateRestaurantProfile,
  upsertRestaurantSettings
} from "../repositories/restaurants";
import { createSupportRequest } from "../repositories/supportRequests";
import { nextOnboardingStatus } from "../services/onboardingService";
import { normalizePhone } from "../utils/phone";

// Restaurant profile read/edit. Used by the onboarding wizard (profile step)
// and later by a settings page. Auth + tenant gated; edits are manager-only.
export const restaurantRouter = Router();

restaurantRouter.get(
  "/api/restaurant/profile",
  requireFirebaseAuth,
  resolveTenant,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const restaurantId = tenantId(request);
    const profile = await getRestaurantProfile(restaurantId);
    if (!profile) {
      throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
    }
    // Pull hours/duration from settings so the form is fully populated.
    let bookingDurationMinutes: number | null = null;
    let openingHours: unknown = null;
    try {
      const settings = await getRestaurantSettings(restaurantId);
      bookingDurationMinutes = settings.bookingDurationMinutes;
      openingHours = settings.openingHours;
    } catch {
      /* settings row may not exist yet — leave nulls */
    }
    response.json({
      profile: {
        ...profile,
        booking_duration_minutes: bookingDurationMinutes,
        opening_hours: openingHours
      }
    });
  })
);

restaurantRouter.patch(
  "/api/restaurant/profile",
  requireFirebaseAuth,
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const body = restaurantProfileSchema.parse(request.body);

    // Normalise the restaurant's advertised number to E.164 for the dedup check
    // + storage (so "02..." and "+612..." compare equal).
    const existingPhone =
      body.existing_phone_number !== undefined
        ? normalizePhone(body.existing_phone_number) ?? body.existing_phone_number
        : undefined;

    // Duplicate guard: if this advertised number already belongs to a DIFFERENT
    // restaurant, refuse rather than splitting bookings across two tenants.
    if (existingPhone) {
      const dup = await findDuplicateRestaurant({ existingPhoneNumber: existingPhone });
      if (dup && dup.id !== restaurantId) {
        throw new AppError(
          409,
          "DUPLICATE_RESTAURANT",
          `A restaurant ("${dup.name}") is already set up with that phone number. If this is your venue, ask the owner to invite you instead of creating a second account.`,
          { restaurant_name: dup.name }
        );
      }
    }

    const profile = await updateRestaurantProfile(restaurantId, {
      name: body.name,
      timezone: body.timezone,
      address: body.address,
      suburb: body.suburb,
      state: body.state,
      postcode: body.postcode,
      cuisineType: body.cuisine_type,
      contactEmail: body.contact_email,
      ownerName: body.owner_name,
      logoUrl: body.logo_url,
      existingPhoneNumber: existingPhone
    });

    if (body.booking_duration_minutes !== undefined || body.opening_hours !== undefined) {
      await upsertRestaurantSettings(restaurantId, {
        bookingDurationMinutes: body.booking_duration_minutes,
        openingHours: body.opening_hours
      });
    }

    // First completed profile advances the wizard account_created → profile.
    const current = await getOnboardingStatus(restaurantId);
    if (current) {
      const next = nextOnboardingStatus(current, "profile_completed");
      if (next !== current) await setOnboardingStatus(restaurantId, next);
    }

    response.json({ profile });
  })
);

restaurantRouter.post(
  "/api/support",
  requireFirebaseAuth,
  resolveTenant,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = supportRequestSchema.parse(request.body);
    const user = request.firebaseUser;
    const supportRequest = await createSupportRequest({
      restaurantId: tenantId(request),
      userId: user?.uid ?? "dev-local-user",
      userEmail: user?.email ?? "dev@local.test",
      category: body.category,
      subject: body.subject,
      message: body.message
    });

    response.status(201).json({
      support_request: {
        id: supportRequest.id,
        status: supportRequest.status,
        created_at: supportRequest.created_at
      }
    });
  })
);
