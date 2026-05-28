import { Router } from "express";

import {
  actorFor,
  AuthenticatedRequest,
  requireFirebaseAuth,
  requireManagerRole
} from "../auth/firebaseAuth";
import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  createOrderRequestSchema,
  updateOrderItemStatusRequestSchema,
  updateOrderStatusRequestSchema,
  updatePaymentStatusRequestSchema
} from "../http/schemas";
import {
  createOrder,
  getActiveOrders,
  getOrderDetail,
  kdsHealthSnapshot,
  updateOrderItemStatus,
  updateOrderStatus,
  updatePaymentStatus
} from "../services/orderService";

export const ordersRouter = Router();

// Read endpoints — authed, but kitchen kiosk account is in the allowlist.
ordersRouter.get(
  "/api/orders/active",
  requireFirebaseAuth,
  asyncHandler(async (_request, response) => {
    const orders = await getActiveOrders(env.DEFAULT_RESTAURANT_ID);
    // Provide server-now so clients can compute "time since ordered" without
    // trusting their local clock (kitchen tablet drift mitigation).
    response.json({
      server_now: new Date().toISOString(),
      orders
    });
  })
);

ordersRouter.get(
  "/api/orders/:id",
  requireFirebaseAuth,
  asyncHandler(async (request, response) => {
    const order = await getOrderDetail(request.params.id!, env.DEFAULT_RESTAURANT_ID);
    response.json(order);
  })
);

// Manager-only create (the Retell tool path lives in routes/retell.ts).
ordersRouter.post(
  "/api/orders",
  requireFirebaseAuth,
  requireManagerRole,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = createOrderRequestSchema.parse(request.body);
    const idempotencyKey = request.header("idempotency-key") ?? undefined;
    const result = await createOrder({
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      reservationId: body.reservation_id ?? body.reservationId,
      tableId: body.table_id ?? body.tableId,
      source: body.source,
      items: body.items.map((i) => ({
        menuItemId: (i.menu_item_id ?? i.menuItemId)!,
        variantId: i.variant_id ?? i.variantId,
        quantity: i.quantity,
        modifierIds: i.modifier_ids ?? i.modifierIds,
        specialRequests: i.special_requests ?? i.specialRequests
      })),
      specialInstructions: body.special_instructions ?? body.specialInstructions,
      idempotencyKey,
      createdBy: actorFor(request)
    });
    response.status(result.isReplay ? 200 : 201).json({
      order: result.order,
      confirmation_message: result.confirmationMessage,
      is_replay: result.isReplay
    });
  })
);

function parseExpectedVersion(header: string | undefined): number {
  if (!header) {
    throw new AppError(
      428,
      "IF_MATCH_REQUIRED",
      "If-Match header with the order version is required."
    );
  }
  const trimmed = header.replace(/^"|"$/g, "").trim();
  const version = Number(trimmed);
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError(400, "INVALID_IF_MATCH", "If-Match must be a positive integer.");
  }
  return version;
}

ordersRouter.patch(
  "/api/orders/:id/status",
  requireFirebaseAuth,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = updateOrderStatusRequestSchema.parse(request.body);
    const expectedVersion = parseExpectedVersion(request.header("if-match"));
    // Cancellation requires manager — guard inline rather than splitting the
    // route, so kitchen staff can still mark preparing/ready/served.
    if (body.status === "cancelled") {
      await new Promise<void>((resolve, reject) =>
        requireManagerRole(request, response, (err?: unknown) => (err ? reject(err) : resolve()))
      );
    }
    const updated = await updateOrderStatus({
      id: request.params.id!,
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      expectedVersion,
      nextStatus: body.status,
      actor: actorFor(request),
      cancellationReason: body.cancellation_reason ?? body.cancellationReason
    });
    response.json(updated);
  })
);

ordersRouter.patch(
  "/api/orders/:id/items/:itemId/status",
  requireFirebaseAuth,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = updateOrderItemStatusRequestSchema.parse(request.body);
    const expectedVersion = parseExpectedVersion(request.header("if-match"));
    const updated = await updateOrderItemStatus({
      orderId: request.params.id!,
      itemId: request.params.itemId!,
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      expectedOrderVersion: expectedVersion,
      nextStatus: body.status,
      actor: actorFor(request)
    });
    response.json(updated);
  })
);

ordersRouter.patch(
  "/api/orders/:id/payment",
  requireFirebaseAuth,
  requireManagerRole,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = updatePaymentStatusRequestSchema.parse(request.body);
    const expectedVersion = parseExpectedVersion(request.header("if-match"));
    const paymentStatus = (body.payment_status ?? body.paymentStatus)!;
    const updated = await updatePaymentStatus({
      id: request.params.id!,
      restaurantId: env.DEFAULT_RESTAURANT_ID,
      expectedVersion,
      paymentStatus,
      actor: actorFor(request)
    });
    response.json(updated);
  })
);

// Ops health endpoint — public for the alerter; no PII inside.
ordersRouter.get(
  "/api/ops/kds-health",
  asyncHandler(async (_request, response) => {
    const snapshot = await kdsHealthSnapshot(env.DEFAULT_RESTAURANT_ID);
    response.json(snapshot);
  })
);

// In-memory heartbeat ring buffer so the alerter can warn if no tablet has
// pinged recently. Tiny, restart-tolerant; not worth a DB table for v1.
const HEARTBEATS = new Map<string, number>();
export function getKdsHeartbeats(): Array<{ tablet_id: string; last_seen_ms_ago: number }> {
  const now = Date.now();
  return Array.from(HEARTBEATS.entries()).map(([tablet_id, ts]) => ({
    tablet_id,
    last_seen_ms_ago: now - ts
  }));
}

ordersRouter.post(
  "/api/ops/kds-heartbeat",
  requireFirebaseAuth,
  asyncHandler(async (request, response) => {
    const tabletId = String(request.query.tablet_id ?? request.body?.tablet_id ?? "").slice(0, 64);
    if (!tabletId) throw new AppError(400, "TABLET_ID_REQUIRED", "tablet_id is required.");
    HEARTBEATS.set(tabletId, Date.now());
    response.json({ ok: true });
  })
);
