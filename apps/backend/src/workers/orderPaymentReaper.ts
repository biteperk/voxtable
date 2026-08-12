/**
 * Order-payment reaper — the missed-webhook backstop for voice-order payment
 * links. Every 5 minutes it sweeps order_payments rows still active past
 * their expiry (+grace) and asks STRIPE what actually happened: a session
 * that turns out paid runs the normal mark-paid path (the missed-`completed`
 * reconciler); anything else is marked expired, freeing the one-live-link
 * index so staff can resend.
 *
 * Deliberately NOT gated on ORDER_PAYMENTS_ENABLED: the kill switch stops
 * link creation, but links already in guests' hands must keep settling. The
 * tick is a quiet no-op when the table is empty, doesn't exist yet (pre-030
 * VM window), or Stripe isn't configured at all.
 */

import { logger, withTickLogContext } from "../utils/logger";
import { reapStaleOrderPayments } from "../services/orderPaymentService";

const TICK_INTERVAL_MS = 5 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let currentTick: Promise<void> | null = null;

async function tick(): Promise<void> {
  try {
    const resolved = await reapStaleOrderPayments();
    if (resolved > 0) {
      logger.info({ evt: "order_payment_reaper_resolved", count: resolved });
    }
  } catch (error) {
    logger.error({ evt: "order_payment_reaper_failed", error });
  }
}

export function startOrderPaymentReaper(): void {
  if (intervalHandle !== null) return;
  logger.info({ evt: "order_payment_reaper_started" });
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    // See provisioningWorker: an unhandled rejection here kills the process.
    currentTick = withTickLogContext("order-payment-reaper", () => tick())
      .catch((error) => logger.error({ evt: "order_payment_reaper_tick_failed", error }))
      .finally(() => {
        tickInFlight = false;
        currentTick = null;
      });
  }, TICK_INTERVAL_MS);
  intervalHandle.unref();
}

export async function stopOrderPaymentReaper(): Promise<void> {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentTick) await currentTick.catch(() => {});
}
