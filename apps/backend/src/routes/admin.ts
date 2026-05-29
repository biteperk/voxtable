import { Router } from "express";

import { requireAdminRole, requireFirebaseAuth } from "../auth/firebaseAuth";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { adminProvisioningSchema } from "../http/schemas";
import {
  getProvisioning,
  getOnboardingFunnel,
  getOnboardingStatus,
  listByOnboardingStatus,
  setOnboardingStatus,
  setProvisioningBindings
} from "../repositories/restaurants";
import { assertCanGoLive } from "../services/onboardingService";
import { notifyRestaurant } from "../services/notificationService";
import { normalizePhone } from "../utils/phone";

// Internal provisioning console (VocoTable staff). Cross-tenant, so it is gated
// by requireAdminRole rather than per-restaurant membership.
export const adminRouter = Router();

adminRouter.use(requireFirebaseAuth);
adminRouter.use(requireAdminRole);

// Onboarding funnel snapshot — counts per status for drop-off analysis.
adminRouter.get(
  "/api/admin/funnel",
  asyncHandler(async (_request, response) => {
    const funnel = await getOnboardingFunnel();
    response.json({ funnel });
  })
);

// Restaurants waiting for a phone line + agent to be bound.
adminRouter.get(
  "/api/admin/provisioning-queue",
  asyncHandler(async (_request, response) => {
    const queue = await listByOnboardingStatus("provisioning");
    response.json({ restaurants: queue });
  })
);

// Bind the Twilio number / Retell number + agent for a restaurant. Numbers are
// normalized to E.164 so the inbound dialed-number lookup matches.
adminRouter.patch(
  "/api/admin/restaurants/:id/provisioning",
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const body = adminProvisioningSchema.parse(request.body);
    const updated = await setProvisioningBindings(id, {
      twilioPhoneNumber: body.twilio_phone_number
        ? normalizePhone(body.twilio_phone_number) ?? body.twilio_phone_number
        : undefined,
      retellPhoneNumber: body.retell_phone_number
        ? normalizePhone(body.retell_phone_number) ?? body.retell_phone_number
        : undefined,
      retellAgentId: body.retell_agent_id
    });
    // Once both the number and agent are bound, tell the owner their line is
    // ready so they can forward + verify.
    const prov = await getProvisioning(id);
    if (prov?.twilio_phone_number && prov?.retell_agent_id) {
      void notifyRestaurant("number_ready", id, { number: prov.twilio_phone_number });
    }
    response.json({ profile: updated });
  })
);

// Flip a fully-provisioned restaurant live. Requires the subscription gate
// (status past trial → provisioning) AND the telephony bindings in place.
adminRouter.post(
  "/api/admin/restaurants/:id/go-live",
  asyncHandler(async (request, response) => {
    const id = request.params.id!;
    const status = await getOnboardingStatus(id);
    if (!status) throw new AppError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found.");
    assertCanGoLive(status);

    const prov = await getProvisioning(id);
    if (!prov?.twilio_phone_number || !prov?.retell_agent_id) {
      throw new AppError(
        409,
        "PROVISIONING_INCOMPLETE",
        "Bind the Twilio number and Retell agent before going live."
      );
    }

    await setOnboardingStatus(id, "live");
    response.json({ onboarding_status: "live" });
  })
);
