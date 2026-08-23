import { Router } from "express";
import { z } from "zod";

import {
  actorFor,
  AuthenticatedRequest,
  requireFirebaseAuth
} from "../auth/firebaseAuth";
import { requireAnyMemberRole, requireMemberRole, resolveTenant, tenantId } from "../auth/tenantContext";
import { AppError } from "../domain/errors";
import { asyncHandler } from "../http/asyncHandler";
import {
  createOrderRequestSchema,
  updateOrderItemStatusRequestSchema,
  updateOrderStatusRequestSchema,
  updatePaymentStatusRequestSchema
} from "../http/schemas";
import { paymentLinkLimiter } from "../http/rateLimiters";
import { recordKdsHeartbeat } from "../services/kdsHeartbeats";
import { createOrderPaymentLink } from "../services/orderPaymentService";
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
const FRONT_OF_HOUSE_ROLES = ["staff", "server", "manager", "owner"] as const;
const KITCHEN_ROLES = ["kitchen", "manager", "owner"] as const;
const ORDER_READ_ROLES = ["staff", "server", "kitchen", "manager", "owner"] as const;
const activeOrdersQuerySchema = z.object({
  table_id: z.string().uuid().optional()
});

// Read endpoints — live tables and kitchen views both need current orders.
ordersRouter.get(
  "/api/orders/active",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(ORDER_READ_ROLES),
  asyncHandler(async (request, response) => {
    const query = activeOrdersQuerySchema.parse(request.query);
    const orders = await getActiveOrders(tenantId(request), { tableId: query.table_id });
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
  resolveTenant,
  requireAnyMemberRole(ORDER_READ_ROLES),
  asyncHandler(async (request, response) => {
    const order = await getOrderDetail(request.params.id!, tenantId(request));
    response.json(order);
  })
);

// Manager-only create (the Retell tool path lives in routes/retell.ts).
ordersRouter.post(
  "/api/orders",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(FRONT_OF_HOUSE_ROLES),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = createOrderRequestSchema.parse(request.body);
    const idempotencyKey = request.header("idempotency-key") ?? undefined;
    const result = await createOrder({
      restaurantId: tenantId(request),
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
  resolveTenant,
  requireAnyMemberRole(KITCHEN_ROLES),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = updateOrderStatusRequestSchema.parse(request.body);
    const expectedVersion = parseExpectedVersion(request.header("if-match"));
    // Cancellation requires manager — guard inline rather than splitting the
    // route, so kitchen staff can still mark preparing/ready/served.
    if (body.status === "cancelled") {
      await new Promise<void>((resolve, reject) =>
        requireMemberRole("manager")(request, response, (err?: unknown) => (err ? reject(err) : resolve()))
      );
    }
    const updated = await updateOrderStatus({
      id: request.params.id!,
      restaurantId: tenantId(request),
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
  resolveTenant,
  requireAnyMemberRole(KITCHEN_ROLES),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = updateOrderItemStatusRequestSchema.parse(request.body);
    const expectedVersion = parseExpectedVersion(request.header("if-match"));
    const updated = await updateOrderItemStatus({
      orderId: request.params.id!,
      itemId: request.params.itemId!,
      restaurantId: tenantId(request),
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
  resolveTenant,
  requireMemberRole("manager"),
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const body = updatePaymentStatusRequestSchema.parse(request.body);
    const expectedVersion = parseExpectedVersion(request.header("if-match"));
    const paymentStatus = (body.payment_status ?? body.paymentStatus)!;
    const updated = await updatePaymentStatus({
      id: request.params.id!,
      restaurantId: tenantId(request),
      expectedVersion,
      paymentStatus,
      actor: actorFor(request)
    });
    response.json(updated);
  })
);

// Text the guest a Stripe payment link for an order (send or resend). FOH can
// send to the number on the order's originating call only; overriding the
// recipient with an arbitrary number requires manager — a free-form recipient
// from any staff account is an SMS-abuse and harassment vector. Rate-limited
// per account on top of the service's per-order attempt cap.
ordersRouter.post(
  "/api/orders/:id/payment-link",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(FRONT_OF_HOUSE_ROLES),
  paymentLinkLimiter,
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const override = typeof request.body?.phone === "string" ? request.body.phone.slice(0, 32) : undefined;
    if (override) {
      await new Promise<void>((resolve, reject) =>
        requireMemberRole("manager")(request, response, (err?: unknown) => (err ? reject(err) : resolve()))
      );
    }
    const outcome = await createOrderPaymentLink({
      restaurantId: tenantId(request),
      orderId: request.params.id!,
      recipientPhone: override ?? null,
      actor: actorFor(request),
      source: "staff"
    });
    if (!outcome.sent) {
      throw new AppError(409, outcome.code, outcome.confirmationMessage);
    }
    // Deliberately no URL in the response — staff don't need it, and a link in
    // a dashboard response is a link in browser devtools and logs.
    response.status(outcome.isReplay ? 200 : 201).json({
      sent: true,
      is_replay: outcome.isReplay,
      payment_id: outcome.paymentId,
      expires_in_minutes: outcome.expiresInMinutes,
      message: outcome.confirmationMessage
    });
  })
);

// Ops health endpoint. Was unauthenticated and hard-wired to the default
// tenant: anyone on the internet could read a venue's live order counts and
// its oldest un-started ticket, and the moment there are two venues everyone
// would have been reading restaurant #1's numbers. The alerter calls
// kdsHealthSnapshot() in-process rather than over HTTP, so it is unaffected.
ordersRouter.get(
  "/api/ops/kds-health",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(KITCHEN_ROLES),
  asyncHandler(async (request, response) => {
    const snapshot = await kdsHealthSnapshot(tenantId(request));
    response.json(snapshot);
  })
);

// Heartbeats live in ops_state (services/kdsHeartbeats.ts) — this used to be
// a module-level Map here, which the health alerter imported from the WORKER
// process and got its own permanently empty copy, so the tablet-offline alert
// could never fire. The DB store keeps the map's hardening: tenant-scoped
// keys, a length-capped tablet id, and stale rows filtered on read + purged
// by the cleanup worker.
ordersRouter.post(
  "/api/ops/kds-heartbeat",
  requireFirebaseAuth,
  resolveTenant,
  requireAnyMemberRole(KITCHEN_ROLES),
  asyncHandler(async (request, response) => {
    const tabletId = String(request.query.tablet_id ?? request.body?.tablet_id ?? "").slice(0, 64);
    if (!tabletId) throw new AppError(400, "TABLET_ID_REQUIRED", "tablet_id is required.");
    await recordKdsHeartbeat(tenantId(request), tabletId);
    response.json({ ok: true });
  })
);
