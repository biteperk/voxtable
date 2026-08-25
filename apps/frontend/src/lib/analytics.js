/**
 * Fire-and-forget event tracking seam, backed by Plausible.
 *
 * This file stays the single call-site the rest of the app uses. The provider
 * only activates when VITE_PLAUSIBLE_DOMAIN is set for the build — unset
 * (dev, staging) means no script, no network calls, and track() is a no-op
 * beyond the dev console echo.
 *
 * initAnalytics() installs Plausible's queue stub BEFORE injecting the
 * script tag — that ordering is what lets events fired during page load
 * queue up instead of vanishing.
 */

const PLAUSIBLE_DOMAIN = import.meta.env.VITE_PLAUSIBLE_DOMAIN;

/** Call once from the app bootstrap. Safe to call when the domain is unset. */
export function initAnalytics() {
  if (!PLAUSIBLE_DOMAIN || window.plausible) return;
  window.plausible = function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };
  const script = document.createElement("script");
  script.defer = true;
  script.src = "https://plausible.io/js/script.js";
  script.dataset.domain = PLAUSIBLE_DOMAIN;
  document.head.appendChild(script);
}

/**
 * @param {string} event  Snake-case event name, e.g. "pricing_cta_click".
 * @param {Record<string, unknown>} [props]  Arbitrary properties.
 */
export function track(event, props = {}) {
  if (import.meta.env.DEV) {
    // Visible during local dev so we can confirm wiring without a provider.
    // eslint-disable-next-line no-console
    console.debug("[analytics]", event, props);
  }
  if (PLAUSIBLE_DOMAIN) {
    window.plausible?.(event, { props });
  }
}
