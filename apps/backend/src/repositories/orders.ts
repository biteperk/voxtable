import { DbClient, pool, readPool } from "../db/pool";

export type OrderSource = "voice" | "waiter" | "qr" | "dashboard";
export type OrderStatus = "pending" | "preparing" | "ready" | "served" | "cancelled";
export type OrderItemStatus = "queued" | "preparing" | "ready" | "served";
export type PaymentStatus = "unpaid" | "paid" | "refunded";
export type OrderEventType =
  | "created"
  | "status_changed"
  | "item_status_changed"
  | "payment_changed"
  | "cancelled"
  | "modified";

export interface OrderRow {
  id: string;
  restaurant_id: string;
  reservation_id: string | null;
  table_id: string | null;
  source: OrderSource;
  status: OrderStatus;
  payment_status: PaymentStatus;
  subtotal_cents: number;
  total_cents: number;
  special_instructions: string | null;
  version: number;
  idempotency_key: string | null;
  order_number: number | null;
  ordered_at: string;
  confirmed_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_by: string | null;
  created_from_call_log_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  menu_item_id: string;
  variant_id: string | null;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  name_snapshot: string;
  variant_name_snapshot: string | null;
  special_requests: string | null;
  status: OrderItemStatus;
  started_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItemModifierRow {
  id: string;
  order_item_id: string;
  modifier_id: string;
  name_snapshot: string;
  group_name_snapshot: string;
  price_delta_cents_snapshot: number;
  created_at: string;
}

export interface OrderEventRow {
  id: string;
  order_id: string;
  event_type: OrderEventType;
  from_value: string | null;
  to_value: string | null;
  actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function findOrderByIdempotencyKey(
  restaurantId: string,
  idempotencyKey: string,
  db: DbClient
): Promise<OrderRow | null> {
  const result = await db.query<OrderRow>(
    `SELECT * FROM orders
      WHERE restaurant_id = $1 AND idempotency_key = $2
      FOR UPDATE`,
    [restaurantId, idempotencyKey]
  );
  return result.rows[0] ?? null;
}

export async function nextOrderNumber(
  restaurantId: string,
  db: DbClient
): Promise<number> {
  // Per-day per-restaurant sequence. Uses an advisory lock keyed on date so
  // two voice + dashboard create-order calls on the same day get different
  // numbers without a sequence table.
  const today = new Date().toISOString().slice(0, 10);
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `order_number:${restaurantId}:${today}`
  ]);
  const result = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(order_number), 0) + 1 AS next
       FROM orders
      WHERE restaurant_id = $1 AND ordered_at::date = CURRENT_DATE`,
    [restaurantId]
  );
  return Number(result.rows[0]?.next ?? 1);
}

export async function insertOrder(input: {
  restaurantId: string;
  reservationId?: string | null;
  tableId?: string | null;
  source: OrderSource;
  subtotalCents: number;
  totalCents: number;
  specialInstructions?: string | null;
  idempotencyKey?: string | null;
  orderNumber: number;
  createdBy?: string | null;
  createdFromCallLogId?: string | null;
}, db: DbClient): Promise<OrderRow> {
  const result = await db.query<OrderRow>(
    `
    INSERT INTO orders (
      restaurant_id, reservation_id, table_id, source,
      subtotal_cents, total_cents, special_instructions,
      idempotency_key, order_number, created_by, created_from_call_log_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
    `,
    [
      input.restaurantId,
      input.reservationId ?? null,
      input.tableId ?? null,
      input.source,
      input.subtotalCents,
      input.totalCents,
      input.specialInstructions ?? null,
      input.idempotencyKey ?? null,
      input.orderNumber,
      input.createdBy ?? null,
      input.createdFromCallLogId ?? null
    ]
  );
  return result.rows[0]!;
}

export async function insertOrderItem(input: {
  orderId: string;
  menuItemId: string;
  variantId?: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  nameSnapshot: string;
  variantNameSnapshot?: string | null;
  specialRequests?: string | null;
}, db: DbClient): Promise<OrderItemRow> {
  const result = await db.query<OrderItemRow>(
    `
    INSERT INTO order_items (
      order_id, menu_item_id, variant_id, quantity,
      unit_price_cents, line_total_cents,
      name_snapshot, variant_name_snapshot, special_requests
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [
      input.orderId,
      input.menuItemId,
      input.variantId ?? null,
      input.quantity,
      input.unitPriceCents,
      input.lineTotalCents,
      input.nameSnapshot,
      input.variantNameSnapshot ?? null,
      input.specialRequests ?? null
    ]
  );
  return result.rows[0]!;
}

export async function insertOrderItemModifier(input: {
  orderItemId: string;
  modifierId: string;
  nameSnapshot: string;
  groupNameSnapshot: string;
  priceDeltaCentsSnapshot: number;
}, db: DbClient): Promise<void> {
  await db.query(
    `
    INSERT INTO order_item_modifiers (
      order_item_id, modifier_id, name_snapshot, group_name_snapshot, price_delta_cents_snapshot
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [
      input.orderItemId,
      input.modifierId,
      input.nameSnapshot,
      input.groupNameSnapshot,
      input.priceDeltaCentsSnapshot
    ]
  );
}

export async function insertOrderEvent(input: {
  orderId: string;
  eventType: OrderEventType;
  fromValue?: string | null;
  toValue?: string | null;
  actor: string;
  metadata?: Record<string, unknown>;
}, db: DbClient): Promise<void> {
  await db.query(
    `
    INSERT INTO order_events (
      order_id, event_type, from_value, to_value, actor, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      input.orderId,
      input.eventType,
      input.fromValue ?? null,
      input.toValue ?? null,
      input.actor,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

/**
 * Optimistic-locking status transition. Returns the updated row, or null if
 * the version didn't match — caller treats null as 409 Conflict.
 */
export async function updateOrderStatusAtVersion(input: {
  id: string;
  restaurantId: string;
  expectedVersion: number;
  nextStatus: OrderStatus;
}, db: DbClient): Promise<OrderRow | null> {
  // Set the matching lifecycle timestamp atomically with the status change so
  // ageing logic in the KDS and reports can rely on it.
  const now = new Date().toISOString();
  const setTimestamp = input.nextStatus === "preparing"
    ? `confirmed_at = COALESCE(confirmed_at, $5::timestamptz)`
    : input.nextStatus === "ready"
      ? `ready_at = COALESCE(ready_at, $5::timestamptz)`
      : input.nextStatus === "served"
        ? `served_at = COALESCE(served_at, $5::timestamptz)`
        : input.nextStatus === "cancelled"
          ? `cancelled_at = COALESCE(cancelled_at, $5::timestamptz)`
          : null;

  const sql = setTimestamp
    ? `UPDATE orders
          SET status = $4, version = version + 1, ${setTimestamp}
        WHERE id = $1 AND restaurant_id = $2 AND version = $3
        RETURNING *`
    : `UPDATE orders
          SET status = $4, version = version + 1
        WHERE id = $1 AND restaurant_id = $2 AND version = $3
        RETURNING *`;

  const params = setTimestamp
    ? [input.id, input.restaurantId, input.expectedVersion, input.nextStatus, now]
    : [input.id, input.restaurantId, input.expectedVersion, input.nextStatus];

  const result = await db.query<OrderRow>(sql, params);
  return result.rows[0] ?? null;
}

export async function updateOrderItemStatusAtVersion(input: {
  itemId: string;
  orderId: string;
  expectedOrderVersion: number;
  nextStatus: OrderItemStatus;
}, db: DbClient): Promise<{ item: OrderItemRow; order: OrderRow } | null> {
  // Bump the order's version so concurrent order-level status changes detect
  // the line-item edit. RETURNING both rows lets the service emit a single
  // audit event with both.
  const result = await db.query<OrderItemRow>(
    `
    UPDATE order_items
       SET status = $3,
           started_at = CASE WHEN $3 = 'preparing' THEN COALESCE(started_at, now()) ELSE started_at END,
           ready_at   = CASE WHEN $3 = 'ready'     THEN COALESCE(ready_at, now())   ELSE ready_at END,
           served_at  = CASE WHEN $3 = 'served'    THEN COALESCE(served_at, now())  ELSE served_at END
     WHERE id = $1 AND order_id = $2
     RETURNING *
    `,
    [input.itemId, input.orderId, input.nextStatus]
  );
  if (!result.rows[0]) return null;

  const orderResult = await db.query<OrderRow>(
    `UPDATE orders SET version = version + 1
      WHERE id = $1 AND version = $2
      RETURNING *`,
    [input.orderId, input.expectedOrderVersion]
  );
  if (!orderResult.rows[0]) return null;

  return { item: result.rows[0], order: orderResult.rows[0] };
}

export async function updatePaymentStatusAtVersion(input: {
  id: string;
  restaurantId: string;
  expectedVersion: number;
  paymentStatus: PaymentStatus;
}, db: DbClient): Promise<OrderRow | null> {
  const result = await db.query<OrderRow>(
    `UPDATE orders
        SET payment_status = $4, version = version + 1
      WHERE id = $1 AND restaurant_id = $2 AND version = $3
      RETURNING *`,
    [input.id, input.restaurantId, input.expectedVersion, input.paymentStatus]
  );
  return result.rows[0] ?? null;
}

export interface OrderWithItems extends OrderRow {
  items: Array<OrderItemRow & { modifiers: OrderItemModifierRow[] }>;
}

export async function getOrderById(
  id: string,
  restaurantId: string
): Promise<OrderWithItems | null> {
  const orderResult = await readPool.query<OrderRow>(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2`,
    [id, restaurantId]
  );
  const order = orderResult.rows[0];
  if (!order) return null;

  const [itemsResult, modifiersResult] = await Promise.all([
    readPool.query<OrderItemRow>(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at`,
      [id]
    ),
    readPool.query<OrderItemModifierRow>(
      `SELECT m.* FROM order_item_modifiers m
         JOIN order_items i ON i.id = m.order_item_id
        WHERE i.order_id = $1`,
      [id]
    )
  ]);

  const modifiersByItem = new Map<string, OrderItemModifierRow[]>();
  for (const m of modifiersResult.rows) {
    const list = modifiersByItem.get(m.order_item_id) ?? [];
    list.push(m);
    modifiersByItem.set(m.order_item_id, list);
  }

  return {
    ...order,
    items: itemsResult.rows.map((item) => ({
      ...item,
      modifiers: modifiersByItem.get(item.id) ?? []
    }))
  };
}

export async function listActiveOrders(
  restaurantId: string,
  limit = 50
): Promise<OrderWithItems[]> {
  const orderResult = await readPool.query<OrderRow>(
    `SELECT * FROM orders
      WHERE restaurant_id = $1
        AND status NOT IN ('served', 'cancelled')
      ORDER BY created_at ASC
      LIMIT $2`,
    [restaurantId, limit]
  );
  const orders = orderResult.rows;
  if (orders.length === 0) return [];

  const orderIds = orders.map((o) => o.id);
  const [itemsResult, modifiersResult] = await Promise.all([
    readPool.query<OrderItemRow>(
      `SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])`,
      [orderIds]
    ),
    readPool.query<OrderItemModifierRow>(
      `SELECT m.* FROM order_item_modifiers m
         JOIN order_items i ON i.id = m.order_item_id
        WHERE i.order_id = ANY($1::uuid[])`,
      [orderIds]
    )
  ]);

  const modifiersByItem = new Map<string, OrderItemModifierRow[]>();
  for (const m of modifiersResult.rows) {
    const list = modifiersByItem.get(m.order_item_id) ?? [];
    list.push(m);
    modifiersByItem.set(m.order_item_id, list);
  }
  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const item of itemsResult.rows) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  return orders.map((order) => ({
    ...order,
    items: (itemsByOrder.get(order.id) ?? []).map((item) => ({
      ...item,
      modifiers: modifiersByItem.get(item.id) ?? []
    }))
  }));
}

export interface KdsHealthSnapshot {
  active_orders: number;
  payment_pending_count: number;
  oldest_pending_order_age_seconds: number | null;
  average_prep_seconds_p50: number | null;
  average_prep_seconds_p95: number | null;
}

export async function getKdsHealth(restaurantId: string): Promise<KdsHealthSnapshot> {
  const [counts, prep] = await Promise.all([
    readPool.query<{
      active_orders: string;
      payment_pending_count: string;
      oldest_pending_age: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('served', 'cancelled')) AS active_orders,
         COUNT(*) FILTER (WHERE status NOT IN ('served', 'cancelled') AND payment_status = 'unpaid') AS payment_pending_count,
         EXTRACT(EPOCH FROM (now() - MIN(ordered_at) FILTER (WHERE status = 'pending')))::text AS oldest_pending_age
       FROM orders
       WHERE restaurant_id = $1
         AND ordered_at > now() - interval '24 hours'`,
      [restaurantId]
    ),
    readPool.query<{ p50: string | null; p95: string | null }>(
      `SELECT
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ready_at - ordered_at)))::text AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ready_at - ordered_at)))::text AS p95
       FROM orders
       WHERE restaurant_id = $1
         AND ready_at IS NOT NULL
         AND ordered_at > now() - interval '24 hours'`,
      [restaurantId]
    )
  ]);

  const row = counts.rows[0]!;
  return {
    active_orders: Number(row.active_orders),
    payment_pending_count: Number(row.payment_pending_count),
    oldest_pending_order_age_seconds: row.oldest_pending_age ? Math.round(Number(row.oldest_pending_age)) : null,
    average_prep_seconds_p50: prep.rows[0]?.p50 ? Math.round(Number(prep.rows[0].p50)) : null,
    average_prep_seconds_p95: prep.rows[0]?.p95 ? Math.round(Number(prep.rows[0].p95)) : null
  };
}
