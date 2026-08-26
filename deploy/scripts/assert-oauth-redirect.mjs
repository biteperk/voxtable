// assert-oauth-redirect.mjs <client_id> <host...> [--json]
//
// Asserts that every dashboard host is a registered redirect URI on the Google OAuth
// web client that Firebase Auth signs in with, and exits non-zero if any is missing.
//
// It exists because this layer is invisible to every other control we have. Terraform
// cannot manage a Web-application OAuth client's redirect URIs — no public API exposes
// them (biteperk-cloud-platform/docs/firebase-auth.md §"What stays console-only"), and
// there is no read API either: the oauth2 clients REST endpoint 404s. So the repo's only
// record is a hand-maintained markdown table, and on 26 Aug 2026 that table had a row in
// it marked "⏳ pending" while staging Google sign-in was dead. The detector was a human
// trying to log in.
//
// What it does instead of reading config: it asks Google the question the browser asks.
// A redirect_uri that is not registered sends the authorize endpoint to its error page;
// a registered one proceeds to sign-in. That is observable without any credential at all,
// which is what makes this the cheapest check in the estate.
//
// ⚠️ The negative control is not optional. This probe depends on a third party's
// response shape, so it can stop discriminating without anyone changing anything on our
// side — and a probe that always passes is worse than no probe. Every run therefore also
// probes a host that CANNOT be registered and requires that one to fail. If it doesn't,
// every pass in the run is reported as untrustworthy.
//
// No credentials. No dependencies (node built-ins only) — the platform repo has no Node
// toolchain and must be able to run this file straight from a checkout.
//
//   node deploy/scripts/assert-oauth-redirect.mjs \
//     198624206590-….apps.googleusercontent.com bp-voxtable-stg.web.app

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const positional = args.filter((a) => !a.startsWith("--"));
const clientId = positional[0];
const hosts = positional.slice(1);

if (!clientId || hosts.length === 0) {
  console.error("usage: node assert-oauth-redirect.mjs <client_id> <host...> [--json]");
  console.error("  host is a bare hostname, e.g. bp-voxtable-stg.web.app");
  process.exit(2);
}
if (!clientId.endsWith(".apps.googleusercontent.com")) {
  console.error(`"${clientId}" does not look like an OAuth client id.`);
  console.error("Expected something ending in .apps.googleusercontent.com — the Web application");
  console.error("client of the Firebase project that authenticates the dashboard.");
  process.exit(2);
}

const results = [];
const check = (id, ok, label, detail) => {
  results.push({ id, state: ok ? "pass" : "fail", label, detail });
  if (!asJson) console.log(`${ok ? "✓" : "✗"} [${id}] ${label}${detail && !ok ? `\n     ${detail}` : ""}`);
  return ok;
};

export function handlerUri(host) {
  return `https://${host}/__/auth/handler`;
}

/**
 * Ask Google whether it will accept this redirect_uri for this client.
 *
 * Returns "registered" | "rejected" | "indeterminate". The distinction between
 * "rejected" and "indeterminate" matters: a network failure must never be reported
 * as a missing redirect URI, or someone will "fix" a client that was already correct.
 */
export async function probeRedirectUri(clientId, redirectUri, fetchImpl = fetch) {
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    "&response_type=code&scope=openid";

  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    return { verdict: "indeterminate", why: `could not reach accounts.google.com: ${error.message}` };
  }

  // Google answers a bad redirect_uri by landing on its own error page rather than by
  // returning an error status, so the status code tells us nothing — the final URL does.
  const finalUrl = response.url || "";
  if (/\/signin\/oauth\/error/.test(finalUrl)) {
    return { verdict: "rejected", finalUrl };
  }
  // Anything that reached the sign-in/consent flow means the client accepted the URI.
  if (/accounts\.google\.com/.test(finalUrl)) {
    return { verdict: "registered", finalUrl };
  }
  return { verdict: "indeterminate", why: `unrecognised destination ${finalUrl}`, finalUrl };
}

const NEGATIVE_CONTROL_HOST =
  `oauth-negative-control-${Math.random().toString(36).slice(2, 10)}.invalid.example`;

async function main() {
  if (!asJson) {
    console.log(`OAuth web client ${clientId}`);
    console.log(`probing ${hosts.length} dashboard host(s) — no credentials required\n`);
  }

  let id = 0;
  for (const h of hosts) {
    id += 1;
    const uri = handlerUri(h);
    const { verdict, why } = await probeRedirectUri(clientId, uri);
    if (verdict === "registered") {
      check(id, true, `${uri} is a registered redirect URI`);
    } else if (verdict === "rejected") {
      check(
        id,
        false,
        `${uri} is a registered redirect URI`,
        "Google returned its error page: Google sign-in on this host fails with redirect_uri_mismatch.\n" +
          "     There is no API for this (docs/firebase-auth.md §console-only). In the GCP console, on the\n" +
          `     OAuth web client above: add redirect URI ${uri} and JavaScript origin https://${h}.\n` +
          "     Then add a row to that doc's console-only change register."
      );
    } else {
      check(id, false, `${uri} is a registered redirect URI`, `INDETERMINATE — ${why}. Not a verdict; re-run.`);
    }
  }

  // The check that guards the checks. A probe whose discriminating power has silently
  // lapsed reports a broken environment as healthy, which is the failure mode this whole
  // script exists to prevent.
  id += 1;
  const control = await probeRedirectUri(clientId, handlerUri(NEGATIVE_CONTROL_HOST));
  const controlOk = control.verdict === "rejected";
  check(
    id,
    controlOk,
    "negative control: an unregistered host is rejected",
    "A redirect URI that CANNOT be registered was accepted. Google's response shape has changed,\n" +
      "     so this probe no longer discriminates and every ✓ above is a false green.\n" +
      "     Treat those passes as unverified and re-derive the probe before trusting this script."
  );

  const failed = results.filter((r) => r.state === "fail");
  const realFailures = failed.filter((r) => r.id !== id);

  if (asJson) {
    console.log(JSON.stringify({ clientId, hosts, results, failed: failed.length }, null, 2));
  } else {
    console.log("");
    if (!controlOk) {
      console.log("FAILED: the probe itself is not trustworthy — see the negative control above.");
    } else if (realFailures.length) {
      console.log(`FAILED: ${realFailures.length} host(s) cannot sign in — ${realFailures.map((f) => `[${f.id}]`).join(" ")}`);
    } else {
      console.log("All hosts are registered, and the probe was proven to still discriminate.");
    }
  }

  process.exit(failed.length ? 1 : 0);
}

// Importable for the selftest; only runs the CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
