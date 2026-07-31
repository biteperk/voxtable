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

/**
 * Replace identifiers in a URL path with placeholders.
 *
 * `sendDefaultPii: false` does NOT cover this: transaction names and breadcrumbs
 * carry the URL, and our routes embed real data — `/live-tables/<table label>`
 * is operator-chosen text and `/live-feed/<uuid>` identifies a specific caller's
 * call record. Both would otherwise land in Sentry verbatim.
 */
function scrubPath(pathname) {
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "/:id")
    .replace(/^\/live-tables\/.+$/, "/live-tables/:label")
    .replace(/^\/invite\/?$/, "/invite");
}

function scrubUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value, window.location.origin);
    // Query strings carry invite tokens and email addresses — drop them whole
    // rather than trying to enumerate the safe keys.
    return `${url.origin}${scrubPath(url.pathname)}`;
  } catch {
    return value;
  }
}

if (dsn) {
  sentryPromise = import("@sentry/react")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: import.meta.env.MODE,
        release: import.meta.env.VITE_APP_VERSION ?? "0.1.0",
        tracesSampleRate: 0.1,
        sendDefaultPii: false,
        beforeSend(event) {
          if (event.request?.url) event.request.url = scrubUrl(event.request.url);
          if (event.transaction) event.transaction = scrubPath(event.transaction);
          if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map((crumb) =>
              crumb?.data?.url ? { ...crumb, data: { ...crumb.data, url: scrubUrl(crumb.data.url) } } : crumb
            );
          }
          return event;
        },
        beforeBreadcrumb(crumb) {
          // Never ship what the user typed — restaurant names, phone numbers,
          // addresses and card details all pass through onboarding inputs.
          if (crumb.category === "ui.input") return null;
          return crumb;
        }
      });
      return Sentry;
    })
    // A failed chunk load must not become an unhandled rejection — reporting is
    // best-effort and must never be the thing that breaks the page.
    .catch(() => null);
}

export function captureException(error, context) {
  if (!dsn) return;
  void sentryPromise
    ?.then((Sentry) => {
      Sentry?.captureException(error, context ? { extra: context } : undefined);
    })
    .catch(() => {});
}
