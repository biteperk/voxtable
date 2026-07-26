import { Router } from "express";
import { z } from "zod";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { requireAnyMemberRole, requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  getCallLogById,
  getCallLogDailySeries,
  getCallLogMonthlySeries,
  getCallLogStats,
  listCallLogs
} from "../repositories/callLogs";
import { listReservations } from "../repositories/reservations";
import { getRestaurantSettings, getRestaurantTimezone } from "../repositories/restaurants";
import { listAvailableTables } from "../repositories/availability";
import {
  activateTable,
  createTable,
  deactivateTable,
  deleteTable,
  listManagedTables,
  listTables,
  updateTableMetadata
} from "../repositories/tables";
import { normalizePartySize, tableAvailabilityQuerySchema, tablePayloadSchema, updateTableMetadataSchema } from "../http/schemas";
import { getInboxStats } from "../repositories/inbox";
import { getOutboxStats } from "../repositories/outbox";
import { isWithinOpeningHours, todayInTz } from "../utils/time";
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
const FRONT_OF_HOUSE_PATHS = ["/api/reservations", "/api/tables", "/api/call-logs"];
const MANAGER_DASHBOARD_PATHS = ["/api/analytics", "/api/ops"];
const FRONT_OF_HOUSE_ROLES = ["staff", "server", "manager", "owner"] as const;
dashboardRouter.use(DASHBOARD_PATHS, requireFirebaseAuth);
dashboardRouter.use(DASHBOARD_PATHS, resolveTenant);
dashboardRouter.use(FRONT_OF_HOUSE_PATHS, requireAnyMemberRole(FRONT_OF_HOUSE_ROLES));
dashboardRouter.use(MANAGER_DASHBOARD_PATHS, requireMemberRole("manager"));

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

dashboardRouter.get(
  "/api/tables/manage",
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const rows = await listManagedTables(tenantId(request));
    response.json({ tables: rows });
  })
);

dashboardRouter.get(
  "/api/tables/available",
  asyncHandler(async (request, response) => {
    const query = tableAvailabilityQuerySchema.parse(request.query);
    const partySize = normalizePartySize(query);

    if (!partySize) {
      throw new AppError(400, "PARTY_SIZE_REQUIRED", "party_size is required.");
    }

    const restaurantId = tenantId(request);
    const settings = await getRestaurantSettings(restaurantId);
    if (!isWithinOpeningHours(query.date, query.time, settings.bookingDurationMinutes, settings.openingHours)) {
      response.json({ tables: [] });
      return;
    }

    const tables = await listAvailableTables({
      restaurantId,
      date: query.date,
      time: query.time,
      partySize,
      durationMinutes: settings.bookingDurationMinutes,
      excludeReservationId: query.exclude_reservation_id ?? query.excludeReservationId
    });

    response.json({ tables });
  })
);

dashboardRouter.post(
  "/api/tables",
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const body = tablePayloadSchema.parse(request.body);
    const created = await createTable(tenantId(request), {
      label: body.label,
      minCapacity: body.min_capacity ?? body.minCapacity ?? 1,
      maxCapacity: body.max_capacity ?? body.maxCapacity!,
      zone: body.zone,
      description: body.description,
      attributes: body.attributes
    });
    response.status(201).json({ table: created });
  })
);

// Manager edit of table map metadata.
// Auth + tenant are already resolved by the path-scoped middleware above, and
// the front-of-house gate let manager/server through — the extra
// requireMemberRole("manager") here narrows the WRITE to manager+ (a server can
// view the floor but not relabel tables). Tenant-scoped in the repository, so a
// cross-tenant id is a 404, never a cross-restaurant write.
const tableIdParam = z.string().uuid();

dashboardRouter.patch(
  "/api/tables/:id",
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const id = tableIdParam.parse(request.params.id);
    const body = updateTableMetadataSchema.parse(request.body);

    const patch: {
      label?: string;
      minCapacity?: number;
      maxCapacity?: number;
      zone?: string | null;
      description?: string | null;
      attributes?: string[];
    } = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.min_capacity !== undefined || body.minCapacity !== undefined) {
      patch.minCapacity = body.min_capacity ?? body.minCapacity;
    }
    if (body.max_capacity !== undefined || body.maxCapacity !== undefined) {
      patch.maxCapacity = body.max_capacity ?? body.maxCapacity;
    }
    if (body.zone !== undefined) patch.zone = body.zone;
    if (body.attributes !== undefined) patch.attributes = body.attributes;
    if (body.description !== undefined) {
      patch.description = body.description && body.description.trim() ? body.description.trim() : null;
    }

    const updated = await updateTableMetadata(tenantId(request), id, patch);
    if (!updated) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Table not found.");
    }
    response.json({ table: updated });
  })
);

dashboardRouter.post(
  "/api/tables/:id/deactivate",
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const id = tableIdParam.parse(request.params.id);
    const updated = await deactivateTable(tenantId(request), id);
    if (!updated) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Table not found.");
    }
    response.status(204).send();
  })
);

dashboardRouter.post(
  "/api/tables/:id/activate",
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const id = tableIdParam.parse(request.params.id);
    const updated = await activateTable(tenantId(request), id);
    if (!updated) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Table not found.");
    }
    response.json({ table: updated });
  })
);

dashboardRouter.delete(
  "/api/tables/:id",
  requireMemberRole("manager"),
  asyncHandler(async (request, response) => {
    const id = tableIdParam.parse(request.params.id);
    const deleted = await deleteTable(tenantId(request), id);
    if (!deleted) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Table not found.");
    }
    response.status(204).send();
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

// `days` drives the legacy rolling window; `from`/`to` (restaurant-local
// YYYY-MM-DD, inclusive) drive the calendar-month view. When both a range and
// `days` are present the range wins.
const analyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const monthlySeriesQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).optional()
});

dashboardRouter.get(
  "/api/analytics",
  asyncHandler(async (request, response) => {
    const query = analyticsQuery.parse(request.query);
    const restaurantId = tenantId(request);
    if (query.from && query.to) {
      const timezone = await getRestaurantTimezone(restaurantId);
      const stats = await getCallLogStats({ restaurantId, from: query.from, to: query.to, timezone });
      response.json({ analytics: stats, from: query.from, to: query.to });
      return;
    }
    const stats = await getCallLogStats({ restaurantId, sinceDays: query.days ?? 7 });
    response.json({ analytics: stats, period_days: query.days ?? 7 });
  })
);

dashboardRouter.get(
  "/api/analytics/daily-series",
  asyncHandler(async (request, response) => {
    const query = analyticsQuery.parse(request.query);
    const restaurantId = tenantId(request);
    if (query.from && query.to) {
      const timezone = await getRestaurantTimezone(restaurantId);
      const series = await getCallLogDailySeries({ restaurantId, from: query.from, to: query.to, timezone });
      response.json({ series, from: query.from, to: query.to });
      return;
    }
    const days = query.days ?? 7;
    const series = await getCallLogDailySeries({ restaurantId, days });
    response.json({ series, period_days: days });
  })
);

// Per-calendar-month call totals for the trend chart + month-over-month deltas.
// Always TZ-aware (restaurant-local months); defaults to the last 12 months.
dashboardRouter.get(
  "/api/analytics/monthly-series",
  asyncHandler(async (request, response) => {
    const { months } = monthlySeriesQuery.parse(request.query);
    const restaurantId = tenantId(request);
    const timezone = await getRestaurantTimezone(restaurantId);
    const series = await getCallLogMonthlySeries({ restaurantId, months: months ?? 12, timezone });
    response.json({ series, months: months ?? 12 });
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
