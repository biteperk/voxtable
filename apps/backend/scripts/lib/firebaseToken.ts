/**
 * Mint a real Firebase ID token for smoke scripts that hit token-gated
 * /api/* routes on a server running full production gates (staging).
 *
 * Uses the Identity Toolkit REST sign-in — no Admin SDK, no service account,
 * no new dependencies. Requires three env vars:
 *
 *   SMOKE_FIREBASE_API_KEY    the target Firebase project's Web API key
 *   SMOKE_FIREBASE_EMAIL      a password user in that project
 *   SMOKE_FIREBASE_PASSWORD   its password
 *
 * Returns null when unconfigured so callers can [SKIP] token-gated checks and
 * local runs stay green. The user must satisfy three server-side conditions or
 * every request 401s/403s regardless of a valid token:
 *   1. email_verified — firebaseAuth rejects unverified emails outright; set
 *      it via the Admin SDK after creating the password user.
 *   2. The email is in the server's DASHBOARD_ALLOWED_EMAILS.
 *   3. A restaurant_members row exists for tenant-scoped routes
 *      (deploy/seeds/staging-venue.sql seeds the staging one).
 */
export async function mintSmokeIdToken(): Promise<string | null> {
  const apiKey = process.env.SMOKE_FIREBASE_API_KEY;
  const email = process.env.SMOKE_FIREBASE_EMAIL;
  const password = process.env.SMOKE_FIREBASE_PASSWORD;
  if (!apiKey || !email || !password) return null;

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const body = (await response.json().catch(() => ({}))) as {
    idToken?: string;
    error?: { message?: string };
  };
  if (!response.ok || !body.idToken) {
    throw new Error(
      `Firebase sign-in failed (${response.status}): ${body.error?.message ?? "no idToken"} — ` +
        `check SMOKE_FIREBASE_* values and that the user exists with a password.`
    );
  }
  return body.idToken;
}
