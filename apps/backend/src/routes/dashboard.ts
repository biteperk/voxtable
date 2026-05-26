import { Router } from "express";
import { z } from "zod";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
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
import { getInboxStats } from "../repositories/inbox";
import { getOutboxStats } from "../repositories/outbox";
import { getBreakerState } from "../services/calcomClient";

export const dashboardRouter = Router();

dashboardRouter.use(requireFirebaseAuth);

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
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      date: query.date,
      limit: query.limit
    });
    response.json({ reservations: rows });
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
      restaurantId: env.DEFAULT_RESTAURANT_ID,
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

    if (!row || row.restaurant_id !== env.DEFAULT_RESTAURANT_ID) {
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
      restaurantId: env.DEFAULT_RESTAURANT_ID,
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
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      days
    });
    response.json({ series, period_days: days });
  })
);

// Operations: surface Cal.com integration health for the dashboard ops tile.
// Returns plausible values whether the flag is on (real numbers) or off
// (zeros + "disabled" state). Firebase auth + email allowlist already gated.
dashboardRouter.get(
  "/api/ops/calcom-health",
  asyncHandler(async (_request, response) => {
    const [outbox, inbox] = await Promise.all([getOutboxStats(), getInboxStats()]);
    const breaker = getBreakerState();
    response.json({
      enabled: env.CALCOM_SYNC_ENABLED,
      outbox,
      inbox,
      circuit_breaker: {
        state: breaker.state,
        consecutive_failures: breaker.consecutiveFailures,
        opened_at: breaker.openedAt ? new Date(breaker.openedAt).toISOString() : null
      }
    });
  })
);
