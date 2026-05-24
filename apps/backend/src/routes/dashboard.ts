import { Router } from "express";
import { z } from "zod";

import { requireFirebaseAuth } from "../auth/firebaseAuth";
import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import { getCallLogById, getCallLogStats, listCallLogs } from "../repositories/callLogs";
import { listReservations } from "../repositories/reservations";

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
