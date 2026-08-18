import crypto from "node:crypto";

import { AppError } from "../domain/errors";
import { withTransaction } from "../db/pool";
import {
  findOrderByIdempotencyKey,
  getKdsHealth,
  getOrderById,
  insertOrder,
  insertOrderEvent,
  insertOrderItem,
  insertOrderItemModifier,
  KdsHealthSnapshot,
  listActiveOrders,
  nextOrderNumber,
  OrderItemStatus,
  OrderStatus,
  OrderWithItems,
  PaymentStatus,
  updateOrderItemStatusAtVersion,
  updateOrderStatusAtVersion,
  updatePaymentStatusAtVersion
} from "../repositories/orders";
import {
  loadMenuItemsForOrder,
  loadModifiersForItems,
  loadVariantsForItems
} from "../repositories/menu";
import { logger } from "../utils/logger";
import { cancelActivePaymentForOrder } from "./orderPaymentService";

// Guard against an LLM (or a buggy client) submitting an unbounded order.
const MAX_ORDER_ITEMS = 50;

export interface CreateOrderItemInput {
  menuItemId: string;
  variantId?: string;
  quantity: number;
  modifierIds?: string[];
  specialRequests?: string;
}

export interface CreateOrderInput {
  restaurantId: string;
  reservationId?: string;
  tableId?: string;
  source: "voice" | "waiter" | "qr" | "dashboard";
  items: CreateOrderItemInput[];
  specialInstructions?: string;
  idempotencyKey?: string;
  createdBy?: string;
  createdFromCallLogId?: string;
}

export interface CreateOrderResult {
  order: OrderWithItems;
  isReplay: boolean;
  confirmationMessage: string;
}

/**
 * Stable fingerprint of an order's CONTENT, for building idempotency keys
 * that distinguish "the same tool call retried" from "a second order in the
 * same call". The voice path used to key on the bare Retell call_id, so one
 * call could only ever place one order — the guest added a Coke, heard it
 * confirmed, and it was never made or billed (audit B8).
 *
 * Normalised so equivalent orders collide on purpose: item order and
 * modifier order don't change the fingerprint; quantity, variant, and
 * special requests do.
 */
export function orderContentFingerprint(
  items: CreateOrderItemInput[],
  specialInstructions?: string
): string {
  // Code-point comparison, NOT localeCompare and NOT the default sort — a
  // fingerprint must order identically on every machine, and locale-aware
  // collation does not promise that.
  const byCodePoint = (x: string, y: string): number => {
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  };
  const normalised = items
    .map((item) => ({
      m: item.menuItemId,
      v: item.variantId ?? "",
      q: item.quantity,
      mods: [...(item.modifierIds ?? [])].sort(byCodePoint),
      s: item.specialRequests ?? ""
    }))
    .sort((a, b) => byCodePoint(`${a.m}|${a.v}|${a.s}`, `${b.m}|${b.v}|${b.s}`));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ items: normalised, si: specialInstructions ?? "" }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Create an order with full concurrency hardening:
 *   1. Idempotency: same key returns the existing order, never inserts twice.
 *   2. Advisory lock per reservation (or per table+minute for walk-ins) so
 *      voice + waiter races on the same booking can't dupe.
 *   3. Re-reads menu prices INSIDE the txn and FOR SHARE-locks the rows so
 *      a concurrent menu UPDATE can't change what we're charging.
 *   4. Validates modifier-group selection counts (group_min_select /
 *      group_max_select).
 *   5. Snapshots prices and names — order history is immutable when the menu
 *      changes later.
 *   6. Writes order_events audit row in the same txn.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (input.items.length === 0) {
    throw new AppError(400, "ORDER_EMPTY", "An order needs at least one item.");
  }
  if (input.items.length > MAX_ORDER_ITEMS) {
    throw new AppError(400, "ORDER_TOO_LARGE", `Orders can have at most ${MAX_ORDER_ITEMS} items.`);
  }

  // Hydrate via the read pool happens AFTER the txn commits — the read pool
  // can't see uncommitted writes from the write pool's txn.
  const result = await withTransaction(async (db): Promise<{ orderId: string; isReplay: boolean }> => {
    // 1) Advisory lock keyed on reservation (or walk-in slot) to serialise
    //    concurrent create-order attempts for the same booking.
    const lockKey = input.reservationId
      ? `order:reservation:${input.reservationId}`
      : input.tableId
        ? `order:walkin:${input.tableId}:${Math.floor(Date.now() / 60_000)}`
        : `order:misc:${input.idempotencyKey ?? Math.floor(Date.now() / 60_000)}`;
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [lockKey]
    );

    // 2) Idempotency: return existing order if this key was already used.
    //    AFTER the lock, not before — two concurrent retries of the same tool
    //    call used to both pass this check and race the INSERT, surfacing the
    //    unique-index violation as a raw 500 on the phone. Behind the lock the
    //    loser blocks, then sees the winner's committed row here.
    if (input.idempotencyKey) {
      const existing = await findOrderByIdempotencyKey(input.restaurantId, input.idempotencyKey, db);
      if (existing) {
        return { orderId: existing.id, isReplay: true };
      }
    }

    // 3) Load + lock menu items, variants, modifiers inside the txn.
    const uniqueItemIds = Array.from(new Set(input.items.map((i) => i.menuItemId)));
    const [items, variants, modifiers] = await Promise.all([
      loadMenuItemsForOrder(uniqueItemIds, input.restaurantId, db),
      loadVariantsForItems(uniqueItemIds, db),
      loadModifiersForItems(uniqueItemIds, db)
    ]);

    const itemById = new Map(items.map((i) => [i.id, i]));
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const modifiersByItem = new Map<string, typeof modifiers>();
    for (const m of modifiers) {
      const list = modifiersByItem.get(m.menu_item_id) ?? [];
      list.push(m);
      modifiersByItem.set(m.menu_item_id, list);
    }

    // 4) Validate every line: item exists & available; variant matches item;
    //    modifier-group counts honour min/max bounds.
    let subtotalCents = 0;
    const planned: Array<{
      input: CreateOrderItemInput;
      itemRow: (typeof items)[number];
      variantRow: (typeof variants)[number] | null;
      modifierRows: typeof modifiers;
      unitPriceCents: number;
      lineTotalCents: number;
    }> = [];

    for (const lineInput of input.items) {
      const itemRow = itemById.get(lineInput.menuItemId);
      if (!itemRow) {
        throw new AppError(
          404,
          "MENU_ITEM_NOT_FOUND",
          `Menu item ${lineInput.menuItemId} doesn't exist.`,
          { menu_item_id: lineInput.menuItemId }
        );
      }
      if (!itemRow.is_available) {
        throw new AppError(
          400,
          "MENU_ITEM_UNAVAILABLE",
          `${itemRow.name} isn't available right now.`,
          { menu_item_id: lineInput.menuItemId, name: itemRow.name }
        );
      }
      if (!Number.isInteger(lineInput.quantity) || lineInput.quantity < 1) {
        throw new AppError(400, "INVALID_QUANTITY", "Quantity must be a positive integer.");
      }

      let variantRow: (typeof variants)[number] | null = null;
      if (lineInput.variantId) {
        const candidate = variantById.get(lineInput.variantId);
        if (!candidate || candidate.menu_item_id !== itemRow.id) {
          throw new AppError(
            400,
            "INVALID_VARIANT",
            `Variant ${lineInput.variantId} doesn't belong to ${itemRow.name}.`
          );
        }
        variantRow = candidate;
      }

      const itemModifiers = modifiersByItem.get(itemRow.id) ?? [];
      const chosenIds = new Set(lineInput.modifierIds ?? []);
      const chosenRows = itemModifiers.filter((m) => chosenIds.has(m.id));
      if (chosenRows.length !== chosenIds.size) {
        throw new AppError(
          400,
          "INVALID_MODIFIER",
          `One or more modifiers don't belong to ${itemRow.name}.`
        );
      }

      // Per-group min/max validation. Group every defined modifier of this
      // item, then check against the chosen count.
      const groupsForItem = new Map<string, { min: number; max: number; chosen: number }>();
      for (const m of itemModifiers) {
        const entry = groupsForItem.get(m.group_name) ?? {
          min: m.group_min_select,
          max: m.group_max_select,
          chosen: 0
        };
        groupsForItem.set(m.group_name, entry);
      }
      for (const c of chosenRows) {
        const entry = groupsForItem.get(c.group_name)!;
        entry.chosen += 1;
      }
      for (const [groupName, entry] of groupsForItem) {
        if (entry.chosen < entry.min) {
          throw new AppError(
            400,
            "MODIFIER_REQUIRED",
            `Please choose ${entry.min === 1 ? "a" : entry.min} ${groupName.toLowerCase()} for ${itemRow.name}.`,
            { item_name: itemRow.name, group_name: groupName, min: entry.min, max: entry.max }
          );
        }
        if (entry.chosen > entry.max) {
          throw new AppError(
            400,
            "MODIFIER_TOO_MANY",
            `Only ${entry.max} ${groupName.toLowerCase()} allowed for ${itemRow.name}.`,
            { item_name: itemRow.name, group_name: groupName, max: entry.max }
          );
        }
      }

      const unitPriceCents =
        itemRow.base_price_cents +
        (variantRow?.price_delta_cents ?? 0) +
        chosenRows.reduce((sum, r) => sum + r.price_delta_cents, 0);
      const lineTotal = unitPriceCents * lineInput.quantity;
      subtotalCents += lineTotal;

      planned.push({
        input: lineInput,
        itemRow,
        variantRow,
        modifierRows: chosenRows,
        unitPriceCents,
        lineTotalCents: lineTotal
      });
    }

    // 5) Allocate a display number and insert the order.
    const orderNumber = await nextOrderNumber(input.restaurantId, db);

    const order = await insertOrder({
      restaurantId: input.restaurantId,
      reservationId: input.reservationId,
      tableId: input.tableId,
      source: input.source,
      subtotalCents,
      totalCents: subtotalCents, // No tax/tip in v1.
      specialInstructions: input.specialInstructions,
      idempotencyKey: input.idempotencyKey,
      orderNumber,
      createdBy: input.createdBy,
      createdFromCallLogId: input.createdFromCallLogId
    }, db);

    for (const line of planned) {
      const orderItem = await insertOrderItem({
        orderId: order.id,
        menuItemId: line.itemRow.id,
        variantId: line.variantRow?.id ?? null,
        quantity: line.input.quantity,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: line.lineTotalCents,
        nameSnapshot: line.itemRow.name,
        variantNameSnapshot: line.variantRow?.name ?? null,
        specialRequests: line.input.specialRequests
      }, db);
      for (const mod of line.modifierRows) {
        await insertOrderItemModifier({
          orderItemId: orderItem.id,
          modifierId: mod.id,
          nameSnapshot: mod.name,
          groupNameSnapshot: mod.group_name,
          priceDeltaCentsSnapshot: mod.price_delta_cents
        }, db);
      }
    }

    await insertOrderEvent({
      orderId: order.id,
      eventType: "created",
      actor: input.createdBy ?? (input.source === "voice" ? "voice:retell" : "system"),
      metadata: {
        source: input.source,
        reservation_id: input.reservationId,
        total_cents: subtotalCents,
        items: planned.length
      }
    }, db);

    logger.info({
      evt: "order_created",
      order_id: order.id,
      order_number: orderNumber,
      source: input.source,
      items: planned.length,
      subtotal_cents: subtotalCents
    });

    return { orderId: order.id, isReplay: false };
  });

  // Now that the txn committed, the read pool can see the new rows.
  const hydrated = await getOrderById(result.orderId, input.restaurantId);
  if (!hydrated) {
    throw new AppError(500, "ORDER_HYDRATION_FAILED", "Order created but couldn't be read back.");
  }
  return {
    order: hydrated,
    isReplay: result.isReplay,
    confirmationMessage: buildConfirmationMessage(hydrated)
  };
}

function buildConfirmationMessage(order: OrderWithItems): string {
  const lines = order.items.map((item) => {
    const variant = item.variant_name_snapshot ? ` ${item.variant_name_snapshot}` : "";
    const mods = item.modifiers.length
      ? ` (${item.modifiers.map((m) => m.name_snapshot).join(", ")})`
      : "";
    return `${item.quantity} × ${item.name_snapshot}${variant}${mods}`;
  });
  const total = `$${(order.total_cents / 100).toFixed(2)}`;
  return `Order #${order.order_number ?? "?"} confirmed: ${lines.join("; ")}. Total ${total}.`;
}

const VALID_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served", "cancelled"],
  served: [],
  cancelled: []
};

async function hydrateAfterCommit(orderId: string, restaurantId: string): Promise<OrderWithItems> {
  // Read pool can't see uncommitted writes from the write-pool txn, so every
  // status mutation hydrates the response AFTER withTransaction commits.
  // Same pattern as createOrder; see PR #35.
  const hydrated = await getOrderById(orderId, restaurantId);
  if (!hydrated) {
    throw new AppError(500, "ORDER_HYDRATION_FAILED", "Order updated but couldn't be read back.");
  }
  return hydrated;
}

export async function updateOrderStatus(input: {
  id: string;
  restaurantId: string;
  expectedVersion: number;
  nextStatus: OrderStatus;
  actor: string;
  cancellationReason?: string;
}): Promise<OrderWithItems> {
  await withTransaction(async (db) => {
    const current = await getOrderById(input.id, input.restaurantId);
    if (!current) {
      throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");
    }
    const allowed = VALID_ORDER_TRANSITIONS[current.status];
    if (!allowed.includes(input.nextStatus)) {
      throw new AppError(
        409,
        "ILLEGAL_STATUS_TRANSITION",
        `Can't move order from ${current.status} to ${input.nextStatus}.`
      );
    }
    if (current.version !== input.expectedVersion) {
      throw new AppError(
        409,
        "VERSION_CONFLICT",
        "This order was updated by someone else. Refreshing.",
        { current_version: current.version }
      );
    }
    const updated = await updateOrderStatusAtVersion({
      id: input.id,
      restaurantId: input.restaurantId,
      expectedVersion: input.expectedVersion,
      nextStatus: input.nextStatus
    }, db);
    if (!updated) {
      throw new AppError(409, "VERSION_CONFLICT", "This order was updated by someone else.");
    }
    if (input.nextStatus === "cancelled" && input.cancellationReason) {
      await db.query(
        `UPDATE orders SET cancellation_reason = $1 WHERE id = $2`,
        [input.cancellationReason, input.id]
      );
    }
    await insertOrderEvent({
      orderId: input.id,
      eventType: input.nextStatus === "cancelled" ? "cancelled" : "status_changed",
      fromValue: current.status,
      toValue: input.nextStatus,
      actor: input.actor,
      metadata: input.cancellationReason ? { reason: input.cancellationReason } : {}
    }, db);
    logger.info({
      evt: "order_status_changed",
      order_id: input.id,
      from: current.status,
      to: input.nextStatus,
      actor: input.actor
    });
  });
  if (input.nextStatus === "cancelled") {
    // Retire any live payment link so the guest can't pay for food that won't
    // be made. After the commit (needs the cancel to be visible), best-effort
    // (the webhook paths are the backstop) — never fails the cancel itself.
    await cancelActivePaymentForOrder(input.id, input.restaurantId);
  }
  return hydrateAfterCommit(input.id, input.restaurantId);
}

export async function updateOrderItemStatus(input: {
  orderId: string;
  itemId: string;
  restaurantId: string;
  expectedOrderVersion: number;
  nextStatus: OrderItemStatus;
  actor: string;
}): Promise<OrderWithItems> {
  await withTransaction(async (db) => {
    const current = await getOrderById(input.orderId, input.restaurantId);
    if (!current) {
      throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");
    }
    const item = current.items.find((i) => i.id === input.itemId);
    if (!item) {
      throw new AppError(404, "ORDER_ITEM_NOT_FOUND", "Line item not found on this order.");
    }
    if (current.version !== input.expectedOrderVersion) {
      throw new AppError(
        409,
        "VERSION_CONFLICT",
        "Order was updated by someone else.",
        { current_version: current.version }
      );
    }
    const result = await updateOrderItemStatusAtVersion({
      itemId: input.itemId,
      orderId: input.orderId,
      expectedOrderVersion: input.expectedOrderVersion,
      nextStatus: input.nextStatus
    }, db);
    if (!result) {
      throw new AppError(409, "VERSION_CONFLICT", "Order was updated by someone else.");
    }
    await insertOrderEvent({
      orderId: input.orderId,
      eventType: "item_status_changed",
      fromValue: `${item.id}:${item.status}`,
      toValue: `${item.id}:${input.nextStatus}`,
      actor: input.actor,
      metadata: { item_id: item.id, name: item.name_snapshot }
    }, db);
  });
  return hydrateAfterCommit(input.orderId, input.restaurantId);
}

export async function updatePaymentStatus(input: {
  id: string;
  restaurantId: string;
  expectedVersion: number;
  paymentStatus: PaymentStatus;
  actor: string;
}): Promise<OrderWithItems> {
  await withTransaction(async (db) => {
    const current = await getOrderById(input.id, input.restaurantId);
    if (!current) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");
    if (current.version !== input.expectedVersion) {
      throw new AppError(409, "VERSION_CONFLICT", "Order was updated by someone else.");
    }
    const updated = await updatePaymentStatusAtVersion({
      id: input.id,
      restaurantId: input.restaurantId,
      expectedVersion: input.expectedVersion,
      paymentStatus: input.paymentStatus
    }, db);
    if (!updated) {
      throw new AppError(409, "VERSION_CONFLICT", "Order was updated by someone else.");
    }
    await insertOrderEvent({
      orderId: input.id,
      eventType: "payment_changed",
      fromValue: current.payment_status,
      toValue: input.paymentStatus,
      actor: input.actor
    }, db);
  });
  return hydrateAfterCommit(input.id, input.restaurantId);
}

export async function getActiveOrders(restaurantId: string): Promise<OrderWithItems[]> {
  return listActiveOrders(restaurantId);
}

export async function getOrderDetail(id: string, restaurantId: string): Promise<OrderWithItems> {
  const order = await getOrderById(id, restaurantId);
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");
  return order;
}

export async function kdsHealthSnapshot(restaurantId: string): Promise<KdsHealthSnapshot> {
  return getKdsHealth(restaurantId);
}
