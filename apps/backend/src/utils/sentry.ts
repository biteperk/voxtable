/**
 * Sentry initialisation for the backend.
 *
 * No-op when SENTRY_DSN is unset (dev default), so the scaffolding can ship
 * without a Sentry project provisioned. Once env.SENTRY_DSN is set the
 * init runs, and `captureException` in errorHandler starts forwarding 5xx
 * payloads.
 *
 * Why this lives in utils, not config: it imports the heavyweight @sentry/node
 * module which we'd rather not pull in just for env validation.
 */

import * as Sentry from "@sentry/node";

import { env } from "../config/env";
import { logger } from "./logger";

let initialised = false;

export function initSentry(): void {
  if (initialised) return;
  if (!env.SENTRY_DSN) {
    logger.info({ evt: "sentry_disabled", reason: "no_dsn" });
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV,
    release: env.APP_VERSION,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // Don't ship logs/PII to Sentry. The logger already redacts; Sentry's
    // breadcrumbs/scope data is the next-leakage-surface to clamp down.
    sendDefaultPii: false
  });
  initialised = true;
  logger.info({ evt: "sentry_initialised", environment: env.APP_ENV, release: env.APP_VERSION });
}

/**
 * Forward an error to Sentry. No-op when init didn't run. Safe to call from
 * the global errorHandler without checking the DSN — Sentry buffers calls
 * before init returns silently.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialised) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
