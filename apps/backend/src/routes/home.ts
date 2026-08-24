/**
 * The venue home page's data.
 *
 * ONE endpoint on purpose. The obvious alternative — have the page call
 * /api/reservations, /api/orders/active and /api/ops/calcom-health — cannot
 * work: those three carry three different role gates. /api/orders/active is
 * kitchen-only and /api/ops is manager-only, so a `server` would get a page that
 * half-loads and two 403s in the console. Designing the response around the
 * surface instead of the existing routes is what lets every role see a whole
 * page.
 *
 * Role shapes what is PRESENT, never whether the request succeeds: a figure the
 * caller may not see is simply absent, so the client renders fewer cells rather
 * than an error.
 */

import { Router } from "express";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { resolveTenant, tenantId, tenantRole } from "../auth/tenantContext";
import { getHomeSummary } from "../repositories/home";
import { getRestaurantName, getRestaurantTimezone } from "../repositories/restaurants";
import { asyncHandler } from "../http/asyncHandler";
import { todayInTz } from "../utils/time";

export const homeRouter = Router();

const HOME_PATHS = ["/api/home"];
homeRouter.use(HOME_PATHS, requireFirebaseAuth);
homeRouter.use(HOME_PATHS, resolveTenant);

/** Roles allowed to see each figure. Absent ≠ forbidden — it just isn't rendered. */
const CAN_SEE_COVERS = new Set(["staff", "server", "manager", "owner"]);
const CAN_SEE_ORDERS = new Set(["kitchen", "manager", "owner"]);
const CAN_SEE_CALLS = new Set(["manager", "owner"]);

homeRouter.get(
  "/api/home/summary",
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const role = tenantRole(request);

    const [timeZone, name] = await Promise.all([
      getRestaurantTimezone(restaurantId),
      getRestaurantName(restaurantId)
    ]);

    // The venue's own calendar day. Using the server's would roll "tonight" over
    // mid-service for any venue east of UTC — which is all of them.
    const localDate = todayInTz(timeZone);
    const summary = await getHomeSummary(restaurantId, localDate, timeZone);

    response.json({
      venue: { id: restaurantId, name, time_zone: timeZone, local_date: localDate },
      service: {
        covers_booked: CAN_SEE_COVERS.has(role) ? summary.covers_booked : undefined,
        bookings_today: CAN_SEE_COVERS.has(role) ? summary.bookings_today : undefined,
        next_booking_time: CAN_SEE_COVERS.has(role) ? summary.next_booking_time : undefined,
        orders_waiting: CAN_SEE_ORDERS.has(role) ? summary.orders_waiting : undefined,
        calls_answered: CAN_SEE_CALLS.has(role) ? summary.calls_answered : undefined
      }
    });
  })
);
