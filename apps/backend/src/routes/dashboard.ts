import { Router } from "express";
import { z } from "zod";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { resolveTenant, tenantId } from "../auth/tenantContext";
import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  getCallLogById,
  getCallLogDailySeries,
  getCallLogStats,
  listCallLogs
} from "../repositories/callLogs";
import { listReservations } from "../repositories/reservations";
import { getRestaurantTimezone } from "../repositories/restaurants";
import { listTables } from "../repositories/tables";
import { getInboxStats } from "../repositories/inbox";
import { getOutboxStats } from "../repositories/outbox";
import { todayInTz } from "../utils/time";
import { getBreakerState } from "../services/calcomClient";
import { quotaSnapshot } from "../services/calcomQuotaTracker";
import { pool } from "../db/pool";

export const dashboardRouter = Router();

// Path-scoped to the dashboard's own routes. A bare router.use(mw) leaks onto
// every fall-through request (this router is mounted at "/" and ahead of
// meRouter/onboardingRouter), so a multi-restaurant account would get
// 409 RESTAURANT_SELECTION_REQUIRED on /api/me before it could ever load its
// memberships — a bootstrap deadlock. These prefixes cover every route below
// (/api/call-logs also matches /api/call-logs/:id; /api/analytics also matches
// /api/analytics/daily-series).
const DASHBOARD_PATHS = ["/api/reservations", "/api/tables", "/api/call-logs", "/api/analytics", "/api/ops"];
dashboardRouter.use(DASHBOARD_PATHS, requireFirebaseAuth);
dashboardRouter.use(DASHBOARD_PATHS, resolveTenant);

const listReservationsQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

dashboardRouter.get(
  "/api/reservations",
  asyncHandler(async (request, response) => {
    const query = listReservationsQuery.parse(request.query);
    const rows = await listReservations({
      restaurantId: tenantId(request),
      date: query.date,
      limit: query.limit
    });
    response.json({ reservations: rows });
  })
);

dashboardRouter.get(
  "/api/tables",
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const tz = await getRestaurantTimezone(restaurantId);
    const today = todayInTz(tz);
    const rows = await listTables(restaurantId, today);
    response.json({ tables: rows });
  })
);

const listCallLogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional()
});

dashboardRouter.get(
  "/api/call-logs",
  asyncHandler(async (request, response) => {
    const query = listCallLogsQuery.parse(request.query);
    const rows = await listCallLogs({
      restaurantId: tenantId(request),
      limit: query.limit
    });
    response.json({ call_logs: rows });
  })
);

const callLogIdParam = z.string().uuid();

dashboardRouter.get(
  "/api/call-logs/:id",
  asyncHandler(async (request, response) => {
    const id = callLogIdParam.parse(request.params.id);
    const row = await getCallLogById(id);

    if (!row || row.restaurant_id !== tenantId(request)) {
      throw new AppError(404, "CALL_LOG_NOT_FOUND", "Call log not found.");
    }

    response.json({ call_log: row });
  })
);

const analyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional()
});

dashboardRouter.get(
  "/api/analytics",
  asyncHandler(async (request, response) => {
    const query = analyticsQuery.parse(request.query);
    const stats = await getCallLogStats({
      restaurantId: tenantId(request),
      sinceDays: query.days ?? 7
    });
    response.json({ analytics: stats, period_days: query.days ?? 7 });
  })
);

dashboardRouter.get(
  "/api/analytics/daily-series",
  asyncHandler(async (request, response) => {
    const query = analyticsQuery.parse(request.query);
    const days = query.days ?? 7;
    const series = await getCallLogDailySeries({
      restaurantId: tenantId(request),
      days
    });
    response.json({ series, period_days: days });
  })
);

// Operations: surface Cal.com integration health for the dashboard ops tile.
// Returns plausible values whether the flag is on (real numbers) or off
// (zeros + "disabled" state). Firebase auth + email allowlist already gated.
//
// Audit Sweep I extension — now also reports today's voice-channel cost
// estimate + Cal.com daily quota usage. The cost numbers are a rolling
// proxy: Retell bills per minute, so we estimate from call_logs.duration.
dashboardRouter.get(
  "/api/ops/calcom-health",
  asyncHandler(async (request, response) => {
    const restaurantId = tenantId(request);
    const [outbox, inbox, costRow] = await Promise.all([
      // outbox/inbox/breaker/quota are platform-wide Cal.com integration state.
      getOutboxStats(),
      getInboxStats(),
      // voice_today is per-restaurant (the tenant's own call cost view).
      pool.query<{
        calls_today: string;
        bookings_today: string;
        duration_seconds_today: string;
      }>(
        `
        SELECT
          COUNT(*) FILTER (WHERE started_at >= date_trunc('day', now()))::text  AS calls_today,
          COUNT(*) FILTER (
            WHERE started_at >= date_trunc('day', now())
              AND booking_outcome = 'confirmed'
          )::text                                                                AS bookings_today,
          COALESCE(SUM(duration_seconds)
            FILTER (WHERE started_at >= date_trunc('day', now())), 0)::text     AS duration_seconds_today
        FROM call_logs
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      )
    ]);
    const breaker = getBreakerState();
    const quota = quotaSnapshot();
    const callsToday = Number(costRow.rows[0]?.calls_today ?? "0");
    const bookingsToday = Number(costRow.rows[0]?.bookings_today ?? "0");
    const durationSecToday = Number(costRow.rows[0]?.duration_seconds_today ?? "0");
    // Retell billing is roughly per-minute of LLM+TTS+STT; the published rate
    // varies. Surface duration and let ops do the math against whatever
    // rate card is current. ALSO surface a "minutes today" view because
    // that's the unit Retell's dashboard shows.
    response.json({
      enabled: env.CALCOM_SYNC_ENABLED,
      outbox,
      inbox,
      circuit_breaker: {
        state: breaker.state,
        consecutive_failures: breaker.consecutiveFailures,
        opened_at: breaker.openedAt ? new Date(breaker.openedAt).toISOString() : null
      },
      voice_today: {
        calls: callsToday,
        bookings_confirmed: bookingsToday,
        duration_seconds: durationSecToday,
        minutes_rounded_up: Math.ceil(durationSecToday / 60)
      },
      calcom_quota: quota
    });
  })
);
