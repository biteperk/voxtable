/**
 * Firebase web configuration, assembled from build-time environment variables.
 *
 * This used to be a literal object in `firebase.js`. Two reasons it moved:
 *
 * 1. A hardcoded project makes a separate test environment impossible. Staging
 *    needs its own Firebase project — its own auth users and storage bucket —
 *    so testing a signup doesn't create a real account next to real customers.
 *    You cannot do that when the project id is baked into the bundle.
 *
 * 2. It was the only thing in 33k lines that SonarCloud rated a vulnerability
 *    (hard-coded secret, S6418). That rating is arguable — a Firebase web
 *    config is public by design and ships in the browser either way — but the
 *    change is right regardless, for reason 1.
 *
 * NONE OF THIS IS SECRET. Every value below is visible to anyone who opens the
 * JavaScript bundle. Firebase is designed that way: access is controlled by
 * security rules and Auth, not by hiding the config. They are environment
 * variables so the app can point at a different project, not to conceal them.
 *
 * Kept as a pure function taking `env` so it can be unit-tested without a
 * browser or the Firebase SDK.
 */

/** Without any one of these, Firebase cannot initialise at all. */
export const REQUIRED_FIREBASE_KEYS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID"
];

/** Analytics only — the app works without it. */
export const OPTIONAL_FIREBASE_KEYS = ["VITE_FIREBASE_MEASUREMENT_ID"];

/**
 * Which variables are missing from `env`. Empty array means good to go.
 * Treats blank strings as missing — CI passing an empty value is the same
 * problem as not passing one, and is the more likely mistake.
 */
export function missingFirebaseKeys(env = {}) {
  return REQUIRED_FIREBASE_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.trim() === "";
  });
}

/**
 * Build the config object, or throw naming exactly what's missing and where to
 * set it.
 *
 * Throwing matters. Vite inlines `undefined` for an absent variable without any
 * complaint, so the alternative is a build that succeeds and a deployed app
 * where sign-in is silently broken for everyone. Loud beats subtle.
 */
/**
 * Pick the auth domain for the host the app is actually being served from.
 *
 * Why: sign-in runs through an iframe and popup on `authDomain`. When that is
 * a different origin from the page (app on vocotable.biteperk.com.au, auth on
 * vocotable.firebaseapp.com), Chrome's third-party storage partitioning breaks
 * the flow — the visible symptom is a raw "Database is closing/hidden" banner
 * on the login screen. Firebase's documented fix is a first-party authDomain.
 *
 * Every Firebase Hosting host serves its own copy of the auth helper at
 * /__/auth/*, so whenever the page is on a *.web.app / *.firebaseapp.com host,
 * or on the exact host the build was configured with (our Hosting custom
 * domain), the page's own host is a valid — and same-origin — auth domain.
 * Anything else (localhost dev, a host not yet cut over) keeps the configured
 * value. No environment-specific hostname appears here; the suffixes are
 * generic to Firebase Hosting, so the CI bundle-bleed guards are unaffected.
 */
export function resolveAuthDomain(configuredAuthDomain, locationHost) {
  const host = typeof locationHost === "string" ? locationHost.trim() : "";
  if (!host) return configuredAuthDomain;
  if (
    host === configuredAuthDomain ||
    host.endsWith(".web.app") ||
    host.endsWith(".firebaseapp.com")
  ) {
    return host;
  }
  return configuredAuthDomain;
}

export function buildFirebaseConfig(env = {}) {
  const missing = missingFirebaseKeys(env);
  if (missing.length > 0) {
    throw new Error(
      `Firebase is not configured — missing ${missing.join(", ")}. ` +
        `Set these as repo variables in GitHub and in the CI build job ` +
        `(.github/workflows/ci.yml), or in apps/frontend/.env.local for local dev. ` +
        `See apps/frontend/.env.example.`
    );
  }
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    ...(env.VITE_FIREBASE_MEASUREMENT_ID
      ? { measurementId: env.VITE_FIREBASE_MEASUREMENT_ID }
      : {})
  };
}
