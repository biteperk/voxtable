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
import { getOutboxStatsForRestaurant } from "../repositories/outbox";
import { isWithinOpeningHours, nowTimeInTz, todayInTz } from "../utils/time";
import { getOpsState } from "../repositories/opsState";
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
const listTablesQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional()
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
    const query = listTablesQuery.parse(request.query);
    const restaurantId = tenantId(request);
    const tz = await getRestaurantTimezone(restaurantId);
    // The floor view must run on the VENUE's clock, not the browser's: a
    // manager checking from another timezone would otherwise see the "Now"
    // marker hours out and the date picker default to the wrong day.
    const today = todayInTz(tz);
    const date = query.date ?? today;
    const [rows, settings] = await Promise.all([
      listTables(restaurantId, date),
      getRestaurantSettings(restaurantId).catch(() => null)
    ]);
    response.json({
      date,
      today,
      timezone: tz,
      now: nowTimeInTz(tz),
      booking_duration_minutes: settings?.bookingDurationMinutes ?? null,
      opening_hours: settings?.openingHours ?? null,
      tables: rows
    });
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

// The stored recording_url is an UNAUTHENTICATED public CloudFront link to the
// complete call audio (#173). It must never reach the browser: rendered into
// the DOM it leaks via page source, history, extensions and referrers, and
// anyone holding it can replay a customer's phone call forever. The API returns
// has_recording instead, and playback goes through the authenticated,
// tenant-scoped proxy below.
function withoutRecordingUrl<T extends { recording_url: string | null }>(
  row: T
): Omit<T, "recording_url"> & { has_recording: boolean } {
  const { recording_url, ...rest } = row;
  return { ...rest, has_recording: Boolean(recording_url) };
}

dashboardRouter.get(
  "/api/call-logs",
  asyncHandler(async (request, response) => {
    const query = listCallLogsQuery.parse(request.query);
    const rows = await listCallLogs({
      restaurantId: tenantId(request),
      limit: query.limit
    });
    response.json({ call_logs: rows.map(withoutRecordingUrl) });
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

    response.json({ call_log: withoutRecordingUrl(row) });
  })
);

// Authenticated playback proxy: same auth + tenant gates as the call-log
// itself, then the audio is streamed server-side from the vendor URL. The
// public link stays inside the backend.
dashboardRouter.get(
  "/api/call-logs/:id/recording",
  asyncHandler(async (request, response) => {
    const id = callLogIdParam.parse(request.params.id);
    const row = await getCallLogById(id);

    if (!row || row.restaurant_id !== tenantId(request)) {
      throw new AppError(404, "CALL_LOG_NOT_FOUND", "Call log not found.");
    }
    if (!row.recording_url) {
      throw new AppError(404, "RECORDING_NOT_FOUND", "This call has no recording.");
    }

    const upstream = await fetch(row.recording_url, {
      signal: AbortSignal.timeout(20_000)
    });
    if (!upstream.ok || !upstream.body) {
      // A vendor-expired recording (retention finally enforced, or signed URLs
      // turned on) surfaces as a clean 404 here rather than a broken player.
      throw new AppError(404, "RECORDING_UNAVAILABLE", "The recording is no longer available.");
    }

    response.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") ?? "audio/wav"
    );
    const length = upstream.headers.get("content-length");
    if (length) response.setHeader("Content-Length", length);
    response.setHeader("Cache-Control", "private, no-store");

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
    response.end();
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
    const [outbox, costRow] = await Promise.all([
      // Scoped to THIS restaurant. It used to call the platform-wide
      // getOutboxStats/getInboxStats on a route any venue's manager can reach,
      // so one venue read another's pending depth, dead-letter count and
      // oldest-pending timestamp — a direct signal of someone else's booking
      // volume and reliability. Dormant only because sync had never been on.
      // The unscoped numbers still exist, behind requireAdminRole, at
      // /api/admin/ops-summary.
      getOutboxStatsForRestaurant(restaurantId),
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
    // The breaker and quota are DRIVEN in the worker process; this endpoint
    // used to read the API process's own module instances, which are
    // permanently "closed" / zero — the rollback runbook told the on-call to
    // trust numbers that could not move. Both now come from the ops_state
    // mirror the worker maintains.
    const breakerRow = await getOpsState("calcom-breaker");
    const breaker = {
      state: String(breakerRow?.state ?? "closed"),
      consecutiveFailures: Number(breakerRow?.consecutiveFailures ?? 0),
      openedAt: typeof breakerRow?.openedAt === "number" ? (breakerRow.openedAt as number) : null
    };
    const callsToday = Number(costRow.rows[0]?.calls_today ?? "0");
    const bookingsToday = Number(costRow.rows[0]?.bookings_today ?? "0");
    const durationSecToday = Number(costRow.rows[0]?.duration_seconds_today ?? "0");
    // Retell billing is roughly per-minute of LLM+TTS+STT; the published rate
    // varies. Surface duration and let ops do the math against whatever
    // rate card is current. ALSO surface a "minutes today" view because
    // that's the unit Retell's dashboard shows.
    // Everything a venue actually needs from the platform-wide picture is
    // "are my online bookings flowing right now". The breaker's consecutive
    // failure count, the inbox depth and the quota are operator numbers with
    // no per-tenant meaning, and inbox/quota cannot be scoped at all — the
    // inbox is keyed by Cal.com event id and the quota is one shared account.
    // So they collapse to a single word here rather than being exposed.
    // Only inputs that are about THIS venue, plus the breaker.
    //
    // The inbox dead-letter count and the Cal.com quota are both platform-wide
    // and cannot be scoped here — the inbox is keyed by Cal.com event id with no
    // restaurant column, and the quota counts one shared account. Folding them in
    // meant venue A read "degraded" because venue B lost a booking: a
    // cross-tenant signal (small, but pollable) and an alarm the venue could do
    // nothing about. They belong to the operator view, which already has them at
    // /api/admin/ops-summary.
    //
    // The breaker stays: it is platform-wide as a cause but venue-specific as an
    // effect — when it is open, THIS venue's bookings genuinely are not syncing.
    const degraded = breaker.state !== "closed" || outbox.failedLast24h > 0;

    response.json({
      enabled: env.CALCOM_SYNC_ENABLED,
      integration_status: degraded ? "degraded" : "ok",
      outbox,
      voice_today: {
        calls: callsToday,
        bookings_confirmed: bookingsToday,
        duration_seconds: durationSecToday,
        minutes_rounded_up: Math.ceil(durationSecToday / 60)
      }
      // calcom_quota is deliberately absent. It counts Cal.com API calls across
      // the whole platform against one shared account allowance, so it has no
      // per-tenant meaning and reading it tells a venue how busy every other
      // venue is. It feeds integration_status above, and the raw number stays
      // on /api/admin/ops-summary behind requireAdminRole.
    });
  })
);
