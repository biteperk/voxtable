/**
 * Sentry init for the dashboard SPA.
 *
 * No-op when VITE_SENTRY_DSN is unset, so the bundle still builds without a
 * Sentry project provisioned. Once the DSN is set at build time, this
 * captures unhandled errors + unhandled promise rejections.
 *
 * Imported as a side-effect from main.jsx — must run before the React tree
 * mounts so it can intercept early render errors.
 */

import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION ?? "0.1.0",
    tracesSampleRate: 0.1,
    sendDefaultPii: false
  });
}

export function captureException(error, context) {
  if (!dsn) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
