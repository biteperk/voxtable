/**
 * Notification worker — drains `notifications_outbox` to SendGrid (email) and
 * Twilio (SMS). NO-OP when NOTIFICATIONS_ENABLED=false. Claims with FOR UPDATE
 * SKIP LOCKED; transient send errors retry with backoff, permanent ones fail.
 * A provider outage never blocks onboarding — sends are async via this queue.
 */

import twilio from "twilio";

import { env } from "../config/env";
import { logger } from "../utils/logger";
import {
  claimReadyNotifications,
  markNotificationFailed,
  markNotificationRetry,
  markNotificationSent,
  type NotificationRow
} from "../repositories/notifications";
import { isNotificationsEnabled } from "../services/notificationService";

const TICK_INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;
let currentTick: Promise<void> | null = null;

function backoffMsForAttempt(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, 60 * 60 * 1000);
}

async function sendViaSendGrid(row: NotificationRow): Promise<void> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    signal: AbortSignal.timeout(env.NOTIFICATIONS_REQUEST_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: row.recipient }] }],
      from: { email: env.NOTIFICATIONS_FROM_EMAIL },
      subject: row.subject ?? "VoxTable",
      // SendGrid requires text/plain before text/html.
      content: [
        { type: "text/plain", value: row.body },
        ...(row.body_html ? [{ type: "text/html", value: row.body_html }] : [])
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text();
    const transient = res.status === 429 || res.status >= 500;
    const err = new Error(`SendGrid ${res.status}: ${body.slice(0, 200)}`);
    (err as Error & { transient?: boolean }).transient = transient;
    throw err;
  }
}

async function sendViaZeptoMail(row: NotificationRow): Promise<void> {
  const res = await fetch(`${env.ZEPTOMAIL_BASE_URL}/email`, {
    method: "POST",
    signal: AbortSignal.timeout(env.NOTIFICATIONS_REQUEST_TIMEOUT_MS),
    headers: {
      authorization: `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: { address: env.NOTIFICATIONS_FROM_EMAIL, name: "VoxTable" },
      to: [{ email_address: { address: row.recipient } }],
      subject: row.subject ?? "VoxTable",
      textbody: row.body,
      ...(row.body_html ? { htmlbody: row.body_html } : {})
    })
  });
  if (!res.ok) {
    const body = await res.text();
    const transient = res.status === 429 || res.status >= 500;
    const err = new Error(`ZeptoMail ${res.status}: ${body.slice(0, 200)}`);
    (err as Error & { transient?: boolean }).transient = transient;
    throw err;
  }
}

async function sendEmail(row: NotificationRow): Promise<void> {
  if (env.EMAIL_PROVIDER === "zeptomail") return sendViaZeptoMail(row);
  return sendViaSendGrid(row);
}

async function sendSms(row: NotificationRow): Promise<void> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.NOTIFICATIONS_SMS_FROM) {
    const err = new Error("SMS not configured");
    (err as Error & { transient?: boolean }).transient = false;
    throw err;
  }
  // Same reasoning as the email sends: this runs in the sequential drain loop,
  // so an unbounded request here stalls every queued notification behind it.
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
    timeout: env.NOTIFICATIONS_REQUEST_TIMEOUT_MS
  });
  try {
    await client.messages.create({
      to: row.recipient,
      from: env.NOTIFICATIONS_SMS_FROM,
      body: row.body
    });
  } catch (error) {
    // Mirror sendEmail: only rate limits / 5xx are worth retrying. Twilio SDK
    // errors carry the HTTP status; 400-class (invalid number, unsubscribed)
    // will fail identically on every attempt.
    const status = (error as { status?: number }).status;
    (error as Error & { transient?: boolean }).transient =
      status === undefined || status === 429 || status >= 500;
    throw error;
  }
}

async function processBatch(): Promise<void> {
  let rows: NotificationRow[];
  try {
    rows = await claimReadyNotifications(BATCH_SIZE);
  } catch (error) {
    logger.error({ evt: "notification_claim_failed", error });
    return;
  }
  for (const row of rows) {
    try {
      if (row.channel === "email") await sendEmail(row);
      else await sendSms(row);
      await markNotificationSent(row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "send failed";
      const transient = (error as { transient?: boolean }).transient ?? true;
      if (transient && row.attempts < MAX_ATTEMPTS) {
        await markNotificationRetry(row.id, message, new Date(Date.now() + backoffMsForAttempt(row.attempts)));
      } else {
        await markNotificationFailed(row.id, message);
        logger.error({ evt: "notification_failed", id: row.id, kind: row.kind, error: message });
      }
    }
  }
}

export function startNotificationWorker(): void {
  if (!isNotificationsEnabled()) {
    logger.info({ evt: "notification_worker_disabled" });
    return;
  }
  if (intervalHandle !== null) return;
  logger.info({ evt: "notification_worker_started" });
  intervalHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    // See provisioningWorker: an unhandled rejection here kills the process.
    currentTick = processBatch()
      .catch((error) => logger.error({ evt: "notification_tick_failed", error }))
      .finally(() => {
        tickInFlight = false;
        currentTick = null;
      });
  }, TICK_INTERVAL_MS);
  intervalHandle.unref();
}

export async function stopNotificationWorker(): Promise<void> {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentTick) await currentTick.catch(() => {});
}
