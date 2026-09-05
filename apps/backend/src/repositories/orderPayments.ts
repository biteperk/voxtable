import { DbClient, pool } from "../db/pool";

export type OrderPaymentStatus =
  | "created"
  | "sent"
  | "processing"
  | "paid"
  | "expired"
  | "failed"
  | "cancelled"
  | "refunded"
  | "disputed";

// Statuses under which a row holds idx_order_payments_active (one live
// attempt per order).
export const ACTIVE_PAYMENT_STATUSES: OrderPaymentStatus[] = ["created", "sent", "processing"];

// Legal transitions. paid may still move to refunded/disputed (money events);
// everything else terminal stays put. A webhook replay arriving out of order
// (e.g. a late `completed` after `charge.refunded`) is a no-op because
// refunded allows no exit — never downgrade, never resurrect.
const VALID_PAYMENT_TRANSITIONS: Record<OrderPaymentStatus, OrderPaymentStatus[]> = {
  created: ["sent", "processing", "paid", "expired", "failed", "cancelled"],
  sent: ["processing", "paid", "expired", "failed", "cancelled"],
  processing: ["paid", "expired", "failed", "cancelled"],
  paid: ["refunded", "disputed"],
  expired: [],
  failed: [],
  cancelled: [],
  refunded: [],
  disputed: []
};

export function isValidPaymentTransition(from: OrderPaymentStatus, to: OrderPaymentStatus): boolean {
  return VALID_PAYMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface OrderPaymentRow {
  id: string;
  order_id: string;
  restaurant_id: string;
  provider: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_connect_account_id: string | null;
  status: OrderPaymentStatus;
  currency: string;
  amount_cents: number;
  amount_received_cents: number | null;
  application_fee_cents: number;
  checkout_url: string | null;
  recipient_phone: string | null;
  notification_id: string | null;
  receipt_notification_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  paid_at: string | null;
  last_error: string | null;
}

export async function insertOrderPayment(
  input: {
    orderId: string;
    restaurantId: string;
    stripeCheckoutSessionId: string;
    stripeConnectAccountId: string;
    amountCents: number;
    applicationFeeCents: number;
    checkoutUrl: string;
    recipientPhone: string;
    notificationId?: string | null;
    expiresAt: Date;
    status?: OrderPaymentStatus;
  },
  db: DbClient = pool
): Promise<OrderPaymentRow> {
  const result = await db.query<OrderPaymentRow>(
    `INSERT INTO order_payments
       (order_id, restaurant_id, stripe_checkout_session_id, stripe_connect_account_id,
        status, amount_cents, application_fee_cents, checkout_url, recipient_phone,
        notification_id, expires_at, sent_at)
     VALUES ($1, $2, $3, $4, $5::order_payment_status, $6, $7, $8, $9, $10, $11,
             CASE WHEN $5::text = 'sent' THEN now() ELSE NULL END)
     RETURNING *`,
    [
      input.orderId,
      input.restaurantId,
      input.stripeCheckoutSessionId,
      input.stripeConnectAccountId,
      input.status ?? "sent",
      input.amountCents,
      input.applicationFeeCents,
      input.checkoutUrl,
      input.recipientPhone,
      input.notificationId ?? null,
      input.expiresAt.toISOString()
    ]
  );
  return result.rows[0]!;
}

export async function getActiveOrderPayment(
  orderId: string,
  restaurantId: string,
  db: DbClient = pool
): Promise<OrderPaymentRow | null> {
  const result = await db.query<OrderPaymentRow>(
    `SELECT * FROM order_payments
     WHERE order_id = $1 AND restaurant_id = $2 AND status = ANY($3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId, restaurantId, ACTIVE_PAYMENT_STATUSES]
  );
  return result.rows[0] ?? null;
}

export async function getOrderPaymentBySessionId(
  sessionId: string,
  db: DbClient = pool
): Promise<OrderPaymentRow | null> {
  const result = await db.query<OrderPaymentRow>(
    `SELECT * FROM order_payments WHERE stripe_checkout_session_id = $1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export async function getOrderPaymentByIntentId(
  paymentIntentId: string,
  db: DbClient = pool
): Promise<OrderPaymentRow | null> {
  const result = await db.query<OrderPaymentRow>(
    `SELECT * FROM order_payments
     WHERE stripe_payment_intent_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [paymentIntentId]
  );
  return result.rows[0] ?? null;
}

/**
 * Guarded status move: the WHERE clause re-checks the from-status so a
 * concurrent writer (webhook vs reaper vs staff) can never double-apply or
 * resurrect a terminal row. Returns the updated row, or null when the row was
 * not in any of the expected from-statuses (caller treats that as "someone
 * else got here first" and moves on).
 */
export async function transitionOrderPayment(
  id: string,
  from: OrderPaymentStatus[],
  to: OrderPaymentStatus,
  patch: {
    stripePaymentIntentId?: string | null;
    amountReceivedCents?: number | null;
    lastError?: string | null;
    paidAt?: Date | null;
    /** Set once, in the same txn as the receipt SMS enqueue (migration 043). */
    receiptNotificationId?: string | null;
  } = {},
  db: DbClient = pool
): Promise<OrderPaymentRow | null> {
  const result = await db.query<OrderPaymentRow>(
    `UPDATE order_payments
     SET status = $3,
         stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id),
         amount_received_cents = COALESCE($5, amount_received_cents),
         last_error = COALESCE($6, last_error),
         paid_at = COALESCE($7, paid_at),
         receipt_notification_id = COALESCE($8, receipt_notification_id)
     WHERE id = $1 AND status = ANY($2)
     RETURNING *`,
    [
      id,
      from,
      to,
      patch.stripePaymentIntentId ?? null,
      patch.amountReceivedCents ?? null,
      patch.lastError ?? null,
      patch.paidAt ? patch.paidAt.toISOString() : null,
      patch.receiptNotificationId ?? null
    ]
  );
  return result.rows[0] ?? null;
}

/** Reaper scan: active rows whose expiry (+ grace) has passed. */
export async function listStaleActivePayments(
  graceMinutes: number,
  limit: number,
  db: DbClient = pool
): Promise<OrderPaymentRow[]> {
  const result = await db.query<OrderPaymentRow>(
    `SELECT * FROM order_payments
     WHERE status = ANY($1)
       AND expires_at IS NOT NULL
       AND expires_at < now() - ($2 || ' minutes')::interval
     ORDER BY expires_at ASC
     LIMIT $3`,
    [ACTIVE_PAYMENT_STATUSES, String(graceMinutes), limit]
  );
  return result.rows;
}

/** Staff-resend abuse cap: attempts created for this order in the last hour. */
export async function countRecentPaymentAttempts(
  orderId: string,
  db: DbClient = pool
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM order_payments
     WHERE order_id = $1 AND created_at > now() - interval '1 hour'`,
    [orderId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Every payment attempt ever made for this order, not just the recent ones.
 *
 * Used as the per-attempt discriminator in the Stripe idempotency key. It has
 * to count ALL rows, unlike countRecentPaymentAttempts: that one resets every
 * hour, so it would hand the same key back to a later attempt inside Stripe's
 * 24-hour idempotency window — which is the bug this exists to prevent.
 */
export async function countPaymentAttempts(
  orderId: string,
  db: DbClient = pool
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM order_payments WHERE order_id = $1`,
    [orderId]
  );
  return Number(result.rows[0]?.count ?? 0);
}
