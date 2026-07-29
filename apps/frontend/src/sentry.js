/**
 * Sentry init for the dashboard SPA.
 *
 * No-op when VITE_SENTRY_DSN is unset. Keep the Sentry package behind a
 * dynamic import so local dev can still render even if Vite's optimized
 * dependency cache is stale or missing.
 *
 * Imported as a side-effect from main.jsx — must run before the React tree
 * mounts so it can intercept early render errors.
 */

const dsn = import.meta.env.VITE_SENTRY_DSN;
let sentryPromise = null;

if (dsn) {
  sentryPromise = import("@sentry/react").then((Sentry) => {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      release: import.meta.env.VITE_APP_VERSION ?? "0.1.0",
      tracesSampleRate: 0.1,
      sendDefaultPii: false
    });
    return Sentry;
  });
}

export function captureException(error, context) {
  if (!dsn) return;
  void sentryPromise?.then((Sentry) => {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  });
}
