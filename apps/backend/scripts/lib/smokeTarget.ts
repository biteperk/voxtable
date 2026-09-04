const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Fail closed before a smoke script can create dummy state remotely.
 *
 * Local targets remain available for developer feedback. Every remote target
 * must be recognisably staging; production and ambiguous remote hosts are
 * rejected.
 */
export function assertSafeSmokeTarget(rawBaseUrl: string): void {
  let target: URL;
  try {
    target = new URL(rawBaseUrl);
  } catch {
    throw new Error(`Invalid PUBLIC_API_BASE_URL: ${rawBaseUrl}`);
  }

  const host = target.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return;

  if (host.includes("stg") || host.includes("staging")) return;

  throw new Error(
    `Refusing smoke target ${target.origin}: remote smoke tests are staging-only. ` +
    "Production permits only non-mutating health/readiness checks, configuration read-backs and monitoring."
  );
}

/** Reject an obvious production database context before a smoke creates fixtures. */
export function assertSafeSmokeDatabase(): void {
  const signals = [
    process.env.DATABASE_URL,
    process.env.DATABASE_HOST,
    process.env.INSTANCE_CONNECTION_NAME,
    process.env.GOOGLE_CLOUD_PROJECT,
    process.env.GCLOUD_PROJECT,
    process.env.GCP_PROJECT,
    process.env.PUBLIC_API_BASE_URL,
    process.env.K_SERVICE
  ].filter(Boolean).join(" ").toLowerCase();

  if (
    signals.includes("bp-voxtable-prod") ||
    signals.includes("voxtable-prod") ||
    signals.includes("api.biteperk.com.au")
  ) {
    throw new Error("Refusing DB-backed smoke test: production targets may never receive test fixtures.");
  }

  if (
    process.env.APP_ENV === "production" &&
    !signals.includes("stg") &&
    !signals.includes("staging")
  ) {
    throw new Error(
      "Refusing DB-backed smoke test in an unidentified production-posture environment; declare a staging target."
    );
  }
}
