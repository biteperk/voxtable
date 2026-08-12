/**
 * Voice-order payments — Stripe Checkout links texted to the caller.
 *
 * The order already exists (created by Bella or a waiter); this service mints
 * a single-use Checkout Session (Connect destination charge to the venue's
 * account, BitePerk keeps an application fee), records it in order_payments,
 * and enqueues the SMS — the row insert, SMS enqueue and audit event share
 * one transaction. The Stripe call happens OUTSIDE the transaction: a network
 * call must never hold a pool connection, and a crash between the two leaves
 * only an orphan session that expires unsent.
 *
 * Concurrency: the partial unique index idx_order_payments_active is the
 * guarantee (one live attempt per order); the advisory lock is politeness.
 * A Retell double-fire returns the FIRST link as a replay, never a second
 * charge path.
 *
 * Kill switch: ORDER_PAYMENTS_ENABLED gates link CREATION only. The webhook
 * handler and the reaper deliberately ignore it — links already in guests'
 * hands must keep settling after a flag-off.
 *
 * Deliberately NO outbox for the Stripe call itself (unlike Cal.com): link
 * creation is synchronous inside a live phone call. If Stripe is down, Bella
 * says so and the guest pays at the venue — a durable retry would mint a link
 * for a call that ended twenty minutes ago.
 */

import type Stripe from "stripe";

import { env } from "../config/env";
import { AppError } from "../domain/errors";
import { DbClient, withTransaction } from "../db/pool";
import { logger } from "../utils/logger";
import { normalizePhone } from "../utils/phone";
import { getStripe, withStripeErrors } from "./stripeClient";
import {
  ACTIVE_PAYMENT_STATUSES,
  countRecentPaymentAttempts,
  getActiveOrderPayment,
  getOrderPaymentByIntentId,
  getOrderPaymentBySessionId,
  insertOrderPayment,
  listStaleActivePayments,
  OrderPaymentRow,
  transitionOrderPayment
} from "../repositories/orderPayments";
import {
  getOrderById,
  getOrderCoreForUpdate,
  insertOrderEvent,
  markOrderPaidIfUnpaid,
  markOrderRefundedIfPaid,
  OrderWithItems
} from "../repositories/orders";
import { getCallerPhoneByCallLogId } from "../repositories/callLogs";
import { getConnectAccountState, getRestaurantName } from "../repositories/restaurants";
import { enqueueNotification } from "../repositories/notifications";

// ---------------------------------------------------------------------------
// Fee + SMS body (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * BitePerk's application fee. Clamped BELOW the total: Stripe rejects a fee
 * above the transaction amount, and a fee equal to it transfers $0 to the
 * venue — on a $6 side of chips a bps+flat fee can reach both.
 */
export function platformFeeCents(
  totalCents: number,
  feeBps: number = env.ORDER_PAYMENT_FEE_BPS,
  feeFlatCents: number = env.ORDER_PAYMENT_FEE_FLAT_CENTS
): number {
  const fee = Math.round(totalCents * (feeBps / 10_000)) + feeFlatCents;
  return Math.max(0, Math.min(totalCents - 1, fee));
}

/**
 * Stripe line items from the order's snapshotted items. Per-item lines use
 * line_total_cents (variant + modifiers already priced in) with quantity
 * folded into the name, so the session's amount_total is Σ line_total_cents
 * by construction. If that sum ever disagrees with orders.total_cents, fall
 * back to one order-level line — the webhook reconciles on exact amount, so
 * the session total matching the order total is non-negotiable.
 */
export function buildLineItems(
  order: Pick<OrderWithItems, "items" | "total_cents" | "order_number">
): Array<{ quantity: number; price_data: { currency: string; unit_amount: number; product_data: { name: string } } }> {
  const perItem = order.items.map((item) => {
    const name = `${item.quantity} × ${item.name_snapshot}`.slice(0, 250);
    return {
      quantity: 1,
      price_data: {
        currency: "aud",
        unit_amount: item.line_total_cents,
        product_data: { name }
      }
    };
  });
  const sum = perItem.reduce((acc, line) => acc + line.price_data.unit_amount, 0);
  if (sum === order.total_cents && perItem.length > 0) return perItem;
  return [
    {
      quantity: 1,
      price_data: {
        currency: "aud",
        unit_amount: order.total_cents,
        product_data: { name: `Order #${order.order_number ?? "—"}` }
      }
    }
  ];
}

/**
 * SMS copy. Venue first — the guest called the restaurant, not us. Written as
 * if replies are impossible (they will be once the ACMA alphanumeric sender
 * ID lands), so nothing invites one.
 */
export function buildPaymentSms(input: {
  venueName: string;
  orderNumber: number | null;
  totalCents: number;
  url: string;
  expiryMinutes: number;
}): string {
  const total = `$${(input.totalCents / 100).toFixed(2)}`;
  return (
    `${input.venueName} — order #${input.orderNumber ?? "—"}, ${total}.\n` +
    `Pay here: ${input.url}\n` +
    `Link expires in ${input.expiryMinutes} minutes. Do not reply to this message.`
  );
}

// ---------------------------------------------------------------------------
// Checkout gateway — injectable seam. CI has no Stripe credentials; the smoke
// script swaps in a fixture gateway so the transaction/replay/webhook logic is
// provable offline while staging exercises the real one.
// ---------------------------------------------------------------------------

export interface CreatedCheckoutSession {
  id: string;
  url: string;
}

export interface RetrievedCheckoutSession {
  payment_status: string;
  amount_total: number | null;
  payment_intent: string | null;
}

export interface CheckoutGateway {
  createSession(args: {
    order: OrderWithItems;
    restaurantId: string;
    connectAccountId: string;
    applicationFeeCents: number;
    expiresAt: Date;
    source: string;
  }): Promise<CreatedCheckoutSession>;
  expireSession(sessionId: string): Promise<void>;
  retrieveSession(sessionId: string): Promise<RetrievedCheckoutSession>;
}

function returnBaseUrl(): string {
  const base = env.PUBLIC_ORDER_RETURN_BASE_URL;
  if (!base) {
    throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Order payments are not configured.");
  }
  return base.replace(/\/+$/, "");
}

const stripeGateway: CheckoutGateway = {
  async createSession({ order, restaurantId, connectAccountId, applicationFeeCents, expiresAt, source }) {
    const stripe = getStripe();
    // Everything the charge-level events need rides payment_intent_data.metadata
    // too: session metadata does NOT propagate to the PaymentIntent, and
    // charge.refunded / charge.dispute.created arrive with only the PI in hand.
    const metadata = {
      biteperk_kind: "order_payment",
      order_id: order.id,
      restaurant_id: restaurantId,
      source
    };
    const session = await withStripeErrors("create_order_checkout_session", () =>
      stripe.checkout.sessions.create(
        {
          mode: "payment",
          // Cards + wallets only for v1. Async methods (BECS) confirm days
          // later; the kitchen must not cook on a promise.
          payment_method_types: ["card"],
          // client_reference_id already means restaurant_id in the billing
          // flow (restaurantIdForEvent reads it as one) — keep that meaning;
          // the order id travels in metadata only.
          client_reference_id: restaurantId,
          metadata,
          expires_at: Math.floor(expiresAt.getTime() / 1000),
          line_items: buildLineItems(order),
          payment_intent_data: {
            transfer_data: { destination: connectAccountId },
            on_behalf_of: connectAccountId,
            application_fee_amount: applicationFeeCents,
            metadata
          },
          success_url: `${returnBaseUrl()}/order/paid?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${returnBaseUrl()}/order/cancelled`
        },
        // Keyed on amount, not order version: kitchen taps bump the version
        // without changing what's owed, and those retries must replay; an
        // amount change must mint a fresh session.
        { idempotencyKey: `order-checkout:${order.id}:${order.total_cents}` }
      )
    );
    if (!session.url) {
      throw new AppError(502, "BILLING_UPSTREAM_ERROR", "Stripe returned no checkout URL.");
    }
    return { id: session.id, url: session.url };
  },

  async expireSession(sessionId) {
    const stripe = getStripe();
    await stripe.checkout.sessions.expire(sessionId);
  },

  async retrieveSession(sessionId) {
    const stripe = getStripe();
    const session = await withStripeErrors("retrieve_order_checkout_session", () =>
      stripe.checkout.sessions.retrieve(sessionId)
    );
    return {
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null)
    };
  }
};

let gateway: CheckoutGateway = stripeGateway;

/** Test seam — pass nothing to restore the real Stripe gateway. */
export function __setCheckoutGatewayForTesting(override?: CheckoutGateway): void {
  gateway = override ?? stripeGateway;
}

/** Best-effort: an unexpirable session (already expired/completed) is fine. */
async function expireSessionBestEffort(sessionId: string): Promise<void> {
  try {
    await gateway.expireSession(sessionId);
  } catch (error) {
    logger.info({ evt: "order_payment_session_expire_skipped", session_id: sessionId, error });
  }
}

// ---------------------------------------------------------------------------
// Link creation
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS_PER_HOUR = 3;

export interface CreatePaymentLinkInput {
  restaurantId: string;
  orderId: string;
  recipientPhone?: string | null;
  actor: string;
  source?: string;
}

export type CreatePaymentLinkOutcome =
  | {
      sent: true;
      isReplay: boolean;
      paymentId: string;
      expiresInMinutes: number;
      confirmationMessage: string;
    }
  | {
      sent: false;
      code:
        | "PAYMENTS_DISABLED"
        | "ORDER_CANCELLED"
        | "ALREADY_PAID"
        | "NOTHING_TO_PAY"
        | "PAYMENTS_NOT_CONFIGURED"
        | "NO_TEXTABLE_NUMBER"
        | "TOO_MANY_ATTEMPTS";
      confirmationMessage: string;
    };

const PAY_AT_VENUE = "you can pay when you arrive.";

export async function createOrderPaymentLink(
  input: CreatePaymentLinkInput
): Promise<CreatePaymentLinkOutcome> {
  if (!env.ORDER_PAYMENTS_ENABLED) {
    return {
      sent: false,
      code: "PAYMENTS_DISABLED",
      confirmationMessage: `I can't take payment over the phone just yet — ${PAY_AT_VENUE}`
    };
  }

  // Tenant-scoped load; a cross-tenant id is indistinguishable from missing.
  const order = await getOrderById(input.orderId, input.restaurantId);
  if (!order) {
    throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");
  }
  if (order.status === "cancelled") {
    return {
      sent: false,
      code: "ORDER_CANCELLED",
      confirmationMessage: "That order has been cancelled, so there's nothing to pay."
    };
  }
  if (order.payment_status !== "unpaid") {
    return {
      sent: false,
      code: "ALREADY_PAID",
      confirmationMessage: "That order is already paid — nothing more to do."
    };
  }
  if (order.total_cents <= 0) {
    return {
      sent: false,
      code: "NOTHING_TO_PAY",
      confirmationMessage: "There's no balance on that order, so no payment is needed."
    };
  }

  const connect = await getConnectAccountState(input.restaurantId);
  if (
    !env.STRIPE_CONNECT_ENABLED ||
    !connect?.stripe_connect_account_id ||
    !connect.stripe_connect_charges_enabled
  ) {
    return {
      sent: false,
      code: "PAYMENTS_NOT_CONFIGURED",
      confirmationMessage: `This venue isn't set up for phone payments yet — ${PAY_AT_VENUE}`
    };
  }

  const rawPhone =
    input.recipientPhone ??
    (order.created_from_call_log_id
      ? await getCallerPhoneByCallLogId(order.created_from_call_log_id, input.restaurantId)
      : null);
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (!phone) {
    return {
      sent: false,
      code: "NO_TEXTABLE_NUMBER",
      confirmationMessage: `I can't text a private or missing number, but ${PAY_AT_VENUE}`
    };
  }

  // Cheap replay pre-check BEFORE any Stripe traffic: a same-amount retry
  // (Retell double-fire, staff double-click) returns the live link and mints
  // nothing.
  const existing = await getActiveOrderPayment(input.orderId, input.restaurantId);
  if (existing && existing.amount_cents === order.total_cents) {
    return replayOutcome(existing);
  }

  // Abuse cap on the resend path: SMS costs money.
  const attempts = await countRecentPaymentAttempts(input.orderId);
  if (attempts >= MAX_ATTEMPTS_PER_HOUR) {
    return {
      sent: false,
      code: "TOO_MANY_ATTEMPTS",
      confirmationMessage: `I've already sent a few links for this order — please use the latest one, or ${PAY_AT_VENUE}`
    };
  }

  const expiryMinutes = env.ORDER_PAYMENT_EXPIRY_MINUTES;
  const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);
  const feeCents = platformFeeCents(order.total_cents);

  // Stripe call OUTSIDE the transaction. A crash after this and before commit
  // leaves an orphan session nobody was ever texted; it expires on its own.
  const session = await gateway.createSession({
    order,
    restaurantId: input.restaurantId,
    connectAccountId: connect.stripe_connect_account_id,
    applicationFeeCents: feeCents,
    expiresAt,
    source: input.source ?? "voice"
  });

  const venueName = await getRestaurantName(input.restaurantId);
  const smsBody = buildPaymentSms({
    venueName,
    orderNumber: order.order_number,
    totalCents: order.total_cents,
    url: session.url,
    expiryMinutes
  });

  // Sessions to expire best-effort AFTER commit — never inside the txn.
  const toExpire: string[] = [];

  const result = await withTransaction(async (db): Promise<CreatePaymentLinkOutcome> => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
      `order_payment:${input.orderId}`
    ]);

    // Re-check behind the lock: a concurrent creator may have won.
    const active = await getActiveOrderPayment(input.orderId, input.restaurantId, db);
    if (active) {
      if (active.amount_cents === order.total_cents) {
        toExpire.push(session.id); // our just-minted orphan
        return replayOutcome(active);
      }
      // Amount went stale (order edited since that link was sent): retire it.
      await transitionOrderPayment(active.id, [...ACTIVE_PAYMENT_STATUSES], "cancelled", {
        lastError: `superseded: order total changed ${active.amount_cents} -> ${order.total_cents}`
      }, db);
      if (active.stripe_checkout_session_id) toExpire.push(active.stripe_checkout_session_id);
    }

    const notificationId = await enqueueNotification(
      {
        restaurantId: input.restaurantId,
        channel: "sms",
        recipient: phone,
        kind: "order_payment_link",
        body: smsBody
      },
      db
    );

    let row: OrderPaymentRow;
    try {
      row = await insertOrderPayment(
        {
          orderId: input.orderId,
          restaurantId: input.restaurantId,
          stripeCheckoutSessionId: session.id,
          stripeConnectAccountId: connect.stripe_connect_account_id as string,
          amountCents: order.total_cents,
          applicationFeeCents: feeCents,
          checkoutUrl: session.url,
          recipientPhone: phone,
          notificationId,
          expiresAt
        },
        db
      );
    } catch (error) {
      // Unique-violation on idx_order_payments_active = a racer that bypassed
      // the lock ordering won. Treat as replay, never as a 500 on the phone —
      // the same lesson createOrder learned (see orderService).
      if ((error as { code?: string }).code === "23505") {
        const winner = await getActiveOrderPayment(input.orderId, input.restaurantId, db);
        if (winner) {
          toExpire.push(session.id);
          // The SMS we enqueued above belongs to our losing session; the txn
          // is still open, so remove it rather than texting a dead link.
          await db.query(`DELETE FROM notifications_outbox WHERE id = $1`, [notificationId]);
          return replayOutcome(winner);
        }
      }
      throw error;
    }

    await insertOrderEvent(
      {
        orderId: input.orderId,
        eventType: "payment_changed",
        fromValue: "unpaid",
        toValue: "link_sent",
        actor: input.actor,
        metadata: { payment_id: row.id, amount_cents: order.total_cents, fee_cents: feeCents }
      },
      db
    );

    return {
      sent: true,
      isReplay: false,
      paymentId: row.id,
      expiresInMinutes: expiryMinutes,
      confirmationMessage:
        `Sent — the payment link should reach the guest's phone in a few seconds ` +
        `and it's valid for ${expiryMinutes} minutes.`
    };
  });

  for (const sessionId of toExpire) {
    await expireSessionBestEffort(sessionId);
  }

  logger.info({
    evt: "order_payment_link_created",
    order_id: input.orderId,
    restaurant_id: input.restaurantId,
    is_replay: !result.sent ? null : result.isReplay,
    actor: input.actor
  });
  return result;
}

function replayOutcome(row: OrderPaymentRow): CreatePaymentLinkOutcome {
  return {
    sent: true,
    isReplay: true,
    paymentId: row.id,
    expiresInMinutes: env.ORDER_PAYMENT_EXPIRY_MINUTES,
    confirmationMessage:
      "A payment link is already on its way to the guest's phone — it's valid for a little while yet."
  };
}

/**
 * Order-cancellation hook (called by orderService after a cancel commits):
 * retire the live link so the guest can't pay for food that won't be made.
 * Best-effort — the checkout.session.expired webhook is the backstop, and the
 * completed handler refuses to mark a cancelled order paid regardless.
 */
export async function cancelActivePaymentForOrder(orderId: string, restaurantId: string): Promise<void> {
  try {
    const active = await getActiveOrderPayment(orderId, restaurantId);
    if (!active) return;
    await transitionOrderPayment(active.id, [...ACTIVE_PAYMENT_STATUSES], "cancelled", {
      lastError: "order cancelled"
    });
    if (active.stripe_checkout_session_id) {
      await expireSessionBestEffort(active.stripe_checkout_session_id);
    }
    logger.info({ evt: "order_payment_cancelled_with_order", order_id: orderId, payment_id: active.id });
  } catch (error) {
    logger.error({ evt: "order_payment_cancel_hook_failed", order_id: orderId, error });
  }
}

// ---------------------------------------------------------------------------
// Webhook reconciliation. Called from stripeService's webhook branch — which
// routes here ONLY for events carrying our biteperk_kind marker. A throw
// propagates to the route's catch (markWebhookFailed + 500) and Stripe
// retries for up to 72h; that retry loop is the tool for "ours but the row
// isn't committed yet". Never 200 an event we couldn't apply.
// ---------------------------------------------------------------------------

export async function handleOrderPaymentWebhook(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      await applySessionOutcome(session);
      return;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const row = await requireRowForSession(session);
      await transitionOrderPayment(row.id, [...ACTIVE_PAYMENT_STATUSES], "failed", {
        lastError: "async payment failed"
      });
      return;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      const row = await requireRowForSession(session);
      // Frees idx_order_payments_active so a resend can mint a fresh link.
      await transitionOrderPayment(row.id, [...ACTIVE_PAYMENT_STATUSES], "expired");
      return;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (!intentId) return;
      const row = await getOrderPaymentByIntentId(intentId);
      if (!row) {
        throw new Error(`order payment for refunded intent ${intentId} not found`);
      }
      await withTransaction(async (db) => {
        const refunded = await markOrderRefundedIfPaid(row.order_id, row.restaurant_id, db);
        await transitionOrderPayment(row.id, ["paid"], "refunded", {}, db);
        if (refunded) {
          await insertOrderEvent(
            {
              orderId: row.order_id,
              eventType: "payment_changed",
              fromValue: "paid",
              toValue: "refunded",
              actor: "stripe:webhook",
              metadata: { payment_id: row.id }
            },
            db
          );
        }
      });
      return;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const intentId =
        typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
      const row = intentId ? await getOrderPaymentByIntentId(intentId) : null;
      if (!row) {
        // A dispute we can't attribute still needs eyes — never throw it away.
        logger.error({ evt: "order_payment_dispute_unmatched", intent_id: intentId ?? null });
        return;
      }
      await transitionOrderPayment(row.id, ["paid"], "disputed", {
        lastError: "charge disputed"
      });
      // Disputes debit the PLATFORM account (destination charges). The
      // healthAlerter's payments check picks disputed rows up and Slacks the
      // ops channel from the worker process.
      logger.error({
        evt: "order_payment_disputed",
        order_id: row.order_id,
        restaurant_id: row.restaurant_id,
        payment_id: row.id
      });
      return;
    }
    default:
      logger.info({ evt: "order_payment_event_ignored", type: event.type });
  }
}

async function requireRowForSession(session: Stripe.Checkout.Session): Promise<OrderPaymentRow> {
  const row = await getOrderPaymentBySessionId(session.id);
  if (!row) {
    // Ours (the caller checked biteperk_kind) but the create-txn hasn't
    // committed yet — throw so Stripe redelivers. A 200 here would consume
    // the guest's payment event forever.
    throw new Error(`order payment for session ${session.id} not yet recorded`);
  }
  return row;
}

async function applySessionOutcome(session: Stripe.Checkout.Session): Promise<void> {
  const row = await requireRowForSession(session);
  const intentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

  // Submitted-but-not-settled (async methods): record and wait. The kitchen
  // does not cook on a promise.
  if (session.payment_status !== "paid") {
    await transitionOrderPayment(row.id, ["created", "sent"], "processing", {
      stripePaymentIntentId: intentId
    });
    return;
  }

  const amountReceived = session.amount_total ?? row.amount_cents;

  await withTransaction(async (db) => {
    // Row-lock the order first so this serialises against staff PATCHes.
    const order = await getOrderCoreForUpdate(row.order_id, row.restaurant_id, db);
    if (!order) {
      throw new Error(`order ${row.order_id} missing for paid session ${session.id}`);
    }

    const paidPatch = {
      stripePaymentIntentId: intentId,
      amountReceivedCents: amountReceived,
      paidAt: new Date()
    };

    if (order.status === "cancelled") {
      // The money is real; the order is not. Record, alert, never cook.
      await transitionOrderPayment(row.id, [...ACTIVE_PAYMENT_STATUSES], "paid", {
        ...paidPatch,
        lastError: "paid after order cancelled — manual refund required"
      }, db);
      await insertOrderEvent(
        {
          orderId: row.order_id,
          eventType: "payment_changed",
          fromValue: order.payment_status,
          toValue: order.payment_status,
          actor: "stripe:webhook",
          metadata: { payment_id: row.id, paid_after_cancel: true, received_cents: amountReceived }
        },
        db
      );
      logger.error({
        evt: "order_payment_paid_after_cancel",
        order_id: row.order_id,
        payment_id: row.id,
        received_cents: amountReceived
      });
      return;
    }

    if (amountReceived !== row.amount_cents) {
      // Order edited after the link went out and the guest paid the old total.
      // Money recorded on the payment row; the ORDER stays unpaid so the KDS
      // pending-payment count shows staff the truth. Never auto-resolve.
      await transitionOrderPayment(row.id, [...ACTIVE_PAYMENT_STATUSES], "paid", {
        ...paidPatch,
        lastError: `amount mismatch: expected ${row.amount_cents}, received ${amountReceived}`
      }, db);
      await insertOrderEvent(
        {
          orderId: row.order_id,
          eventType: "payment_changed",
          fromValue: "unpaid",
          toValue: "unpaid",
          actor: "stripe:webhook",
          metadata: {
            payment_id: row.id,
            amount_mismatch: true,
            expected_cents: row.amount_cents,
            received_cents: amountReceived
          }
        },
        db
      );
      logger.error({
        evt: "order_payment_amount_mismatch",
        order_id: row.order_id,
        payment_id: row.id,
        expected_cents: row.amount_cents,
        received_cents: amountReceived
      });
      return;
    }

    // The happy path. markOrderPaidIfUnpaid's WHERE payment_status='unpaid'
    // guard makes this monotonic: a replayed `completed` after a refund
    // matches zero rows and becomes a recorded no-op.
    const paidOrder = await markOrderPaidIfUnpaid(row.order_id, row.restaurant_id, db);
    await transitionOrderPayment(row.id, [...ACTIVE_PAYMENT_STATUSES], "paid", paidPatch, db);
    if (paidOrder) {
      await insertOrderEvent(
        {
          orderId: row.order_id,
          eventType: "payment_changed",
          fromValue: "unpaid",
          toValue: "paid",
          actor: "stripe:webhook",
          metadata: { payment_id: row.id, received_cents: amountReceived }
        },
        db
      );
      logger.info({ evt: "order_payment_paid", order_id: row.order_id, payment_id: row.id });
    } else {
      logger.info({
        evt: "order_payment_paid_noop",
        order_id: row.order_id,
        payment_id: row.id,
        order_payment_status: order.payment_status
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Reaper — the missed-webhook backstop. Stripe, not the clock, is the source
// of truth: an active row past its expiry is retrieved from Stripe first; a
// session that turns out PAID runs the normal paid path (this doubles as the
// missed-`completed` reconciler), anything else is marked expired, freeing
// the partial index for a resend.
// ---------------------------------------------------------------------------

const REAPER_GRACE_MINUTES = 10;
const REAPER_BATCH = 25;

export async function reapStaleOrderPayments(): Promise<number> {
  let rows: OrderPaymentRow[];
  try {
    rows = await listStaleActivePayments(REAPER_GRACE_MINUTES, REAPER_BATCH);
  } catch (error) {
    // Pre-030 database (VM window): the table may not exist yet. Quiet no-op.
    if ((error as { code?: string }).code === "42P01") return 0;
    throw error;
  }
  let resolved = 0;
  for (const row of rows) {
    try {
      if (!row.stripe_checkout_session_id) {
        await transitionOrderPayment(row.id, [...ACTIVE_PAYMENT_STATUSES], "expired");
        resolved += 1;
        continue;
      }
      const session = await gateway.retrieveSession(row.stripe_checkout_session_id);
      if (session.payment_status === "paid") {
        await applySessionOutcome({
          id: row.stripe_checkout_session_id,
          payment_status: "paid",
          amount_total: session.amount_total,
          payment_intent: session.payment_intent
        } as Stripe.Checkout.Session);
      } else {
        await transitionOrderPayment(row.id, [...ACTIVE_PAYMENT_STATUSES], "expired");
      }
      resolved += 1;
    } catch (error) {
      logger.error({ evt: "order_payment_reap_failed", payment_id: row.id, error });
    }
  }
  return resolved;
}
