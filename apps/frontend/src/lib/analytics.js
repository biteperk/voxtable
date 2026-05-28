/**
 * Fire-and-forget event tracking seam.
 *
 * No analytics provider is wired in yet. This file is the single call-site
 * the rest of the app uses — when Sam picks a provider later (Plausible,
 * PostHog, GA4, custom), the change happens here and the rest of the codebase
 * is already instrumented.
 *
 * @param {string} event  Snake-case event name, e.g. "pricing_cta_click".
 * @param {Record<string, unknown>} [props]  Arbitrary properties.
 */
export function track(event, props = {}) {
  if (import.meta.env.DEV) {
    // Visible during local dev so we can confirm wiring without a provider.
    // eslint-disable-next-line no-console
    console.debug("[analytics]", event, props);
  }
  // Future:
  //   window.plausible?.(event, { props });
  //   posthog.capture(event, props);
  //   window.gtag?.("event", event, props);
}
