/**
 * The boot gate.
 *
 * Every rule here exists because of one bug: the production `superRefine`
 * returned early unless `APP_ENV === "production"`, and that block was the only
 * thing forcing signature verification and dashboard auth on. All three gates
 * defaulted to false and `.env.example` shipped `APP_ENV=development`, so a
 * deployed environment file with one wrong word served every tenant's
 * reservations, call transcripts and customer phone numbers to anonymous
 * callers — with no log line, no alert, and /health still returning ok.
 *
 * Run these against the old env.ts and the four "public host with a gate off"
 * cases all pass, which is the whole problem.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateEnv } from "./env";

const DB = "postgres://test:test@localhost:5432/test";
const PUBLIC_URL = "https://vocotable.algorythmos.com.au";
const CORS_ORIGINS = "https://voxtable.biteperk.com.au,https://vocotable.algorythmos.com.au";

/**
 * The shape of a minimal production .env, minus the secrets. Deliberately
 * WITHOUT RETELL_AGENT_ID and TWILIO_PHONE_NUMBER: those are per-restaurant
 * database data (restaurants.retell_agent_id / twilio_phone_number), not
 * deployment config, so a Cloud Run environment that never sets them must
 * boot — that is exactly what staging does.
 */
const productionEnv = {
  APP_ENV: "production",
  CORS_ALLOWED_ORIGINS: CORS_ORIGINS,
  DATABASE_URL: DB,
  PUBLIC_API_BASE_URL: PUBLIC_URL,
  RETELL_API_KEY: "key_realish",
  RETELL_VERIFY_SIGNATURE: "true",
  TWILIO_ACCOUNT_SID: "AC0",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_VALIDATE_SIGNATURE: "true",
  DASHBOARD_VERIFY_AUTH: "true",
  DASHBOARD_ALLOWED_EMAILS: "sam@example.com",
  // Dashboard auth is enforced on reachable hosts, and Firebase Admin cannot
  // verify a token without a project id — so a reachable host must carry it.
  FIREBASE_PROJECT_ID: "vocotable",
  // Required in every production, not just self-serve ones: the acceptance
  // ledger is only evidence if the server decides what was accepted.
  LEGAL_DOCUMENTS_MANIFEST_URL: "https://storage.googleapis.com/bp-legal/current/manifest.json"
};

const issuePaths = (result: ReturnType<typeof validateEnv>): string[] =>
  result.success ? [] : result.error.issues.map((i) => i.path.join("."));

test("APP_ENV has no default — an env that never mentions it refuses to boot", () => {
  const result = validateEnv({ DATABASE_URL: DB });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("APP_ENV"));
});

test("the three security gates default to true, not false", () => {
  const result = validateEnv({ APP_ENV: "test", DATABASE_URL: DB });
  assert.equal(result.success, true);
  assert.equal(result.data!.RETELL_VERIFY_SIGNATURE, true);
  assert.equal(result.data!.TWILIO_VALIDATE_SIGNATURE, true);
  assert.equal(result.data!.DASHBOARD_VERIFY_AUTH, true);
});

test("feature flags still default to false — a gate default must not leak into them", () => {
  const result = validateEnv({ APP_ENV: "test", DATABASE_URL: DB });
  assert.equal(result.success, true);
  assert.equal(result.data!.CALCOM_SYNC_ENABLED, false);
  assert.equal(result.data!.STRIPE_BILLING_ENABLED, false);
  assert.equal(result.data!.MENU_OCR_ENABLED, false);
});

test("on localhost the gates may be turned off — that is the dev escape hatch", () => {
  const result = validateEnv({
    APP_ENV: "development",
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: "http://localhost:3050",
    RETELL_VERIFY_SIGNATURE: "false",
    TWILIO_VALIDATE_SIGNATURE: "false",
    DASHBOARD_VERIFY_AUTH: "false"
  });
  assert.equal(result.success, true);
});

for (const gate of [
  "RETELL_VERIFY_SIGNATURE",
  "TWILIO_VALIDATE_SIGNATURE",
  "DASHBOARD_VERIFY_AUTH"
]) {
  test(`${gate}=false on a public host refuses to boot, whatever APP_ENV says`, () => {
    const result = validateEnv({
      // The exact bug: development rules on a public host.
      APP_ENV: "development",
      DATABASE_URL: DB,
      PUBLIC_API_BASE_URL: PUBLIC_URL,
      DASHBOARD_ALLOWED_EMAILS: "sam@example.com",
      [gate]: "false"
    });
    assert.equal(result.success, false);
    assert.ok(issuePaths(result).includes(gate));
  });
}

test("an empty allowlist on a public host refuses to boot", () => {
  const result = validateEnv({
    APP_ENV: "development",
    CORS_ALLOWED_ORIGINS: CORS_ORIGINS,
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: PUBLIC_URL
  });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("DASHBOARD_ALLOWED_EMAILS"));
});

test("an empty CORS origin list on a public host refuses to boot", () => {
  const result = validateEnv({
    APP_ENV: "development",
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: PUBLIC_URL,
    DASHBOARD_ALLOWED_EMAILS: "sam@example.com"
  });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("CORS_ALLOWED_ORIGINS"));
});

test("a public host with every gate on and a real allowlist boots", () => {
  const result = validateEnv({
    APP_ENV: "development",
    CORS_ALLOWED_ORIGINS: CORS_ORIGINS,
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: PUBLIC_URL,
    DASHBOARD_ALLOWED_EMAILS: "sam@example.com",
    FIREBASE_PROJECT_ID: "vocotable"
  });
  assert.equal(result.success, true);
});

test("a public host without FIREBASE_PROJECT_ID refuses to boot — auth is on but cannot work", () => {
  const result = validateEnv({
    APP_ENV: "development",
    CORS_ALLOWED_ORIGINS: CORS_ORIGINS,
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: PUBLIC_URL,
    DASHBOARD_ALLOWED_EMAILS: "sam@example.com"
  });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("FIREBASE_PROJECT_ID"));
});

// --- TERMS_ALLOW_UNPUBLISHED_DOCS is keyed on the host, not APP_ENV ---------

for (const host of ["https://api.biteperk.com.au", "https://vocotable.algorythmos.com.au"]) {
  test(`unpublished-docs flag on ${new URL(host).hostname} refuses to boot, whatever APP_ENV says`, () => {
    const result = validateEnv({
      ...productionEnv,
      PUBLIC_API_BASE_URL: host,
      TERMS_ALLOW_UNPUBLISHED_DOCS: "true"
    });
    assert.equal(result.success, false);
    assert.ok(issuePaths(result).includes("TERMS_ALLOW_UNPUBLISHED_DOCS"));
  });
}

test("staging keeps its unpublished-docs carve-out: APP_ENV=production on a non-production host boots with the flag on", () => {
  // Staging runs the production posture (APP_ENV=production) on its own
  // Cloud Run hostname and legitimately sets this flag so the wizard stays
  // testable before the real CSA text publishes. Refusing this combination
  // would take staging down, which is why the gate keys on the host.
  const result = validateEnv({
    ...productionEnv,
    PUBLIC_API_BASE_URL: "https://voxtable-stg-api-naed3dbhna-ts.a.run.app",
    TERMS_ALLOW_UNPUBLISHED_DOCS: "true"
  });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

test("unpublished-docs flag on localhost boots — the dev escape hatch holds", () => {
  const result = validateEnv({
    APP_ENV: "development",
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: "http://localhost:3050",
    TERMS_ALLOW_UNPUBLISHED_DOCS: "true"
  });
  assert.equal(result.success, true);
});

test("the real production environment still boots", () => {
  const result = validateEnv(productionEnv);
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

test("the voice kill switch defaults ON — a forgotten env var must never silence the phone line", () => {
  const result = validateEnv({ APP_ENV: "test", DATABASE_URL: DB });
  assert.equal(result.success, true);
  assert.equal(result.data!.VOICE_BOOKING_ENABLED, true);
});

test("the voice kill switch may be turned OFF in production — unlike the security gates", () => {
  // If this test starts failing, someone added VOICE_BOOKING_ENABLED to the
  // superRefine gate enforcement. That turns the kill switch into a boot
  // refusal: flipping it during an incident would take the whole api down
  // instead of pausing bookings.
  const result = validateEnv({ ...productionEnv, VOICE_BOOKING_ENABLED: "false" });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
  assert.equal(result.data!.VOICE_BOOKING_ENABLED, false);
});

test("production still refuses a localhost public URL", () => {
  const result = validateEnv({ ...productionEnv, PUBLIC_API_BASE_URL: "http://localhost:3050" });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("PUBLIC_API_BASE_URL"));
});

test("production still requires the Retell and Twilio credentials", () => {
  const { RETELL_API_KEY, TWILIO_AUTH_TOKEN, ...missing } = productionEnv;
  const result = validateEnv(missing);
  assert.equal(result.success, false);
  const paths = issuePaths(result);
  assert.ok(paths.includes("RETELL_API_KEY"));
  assert.ok(paths.includes("TWILIO_AUTH_TOKEN"));
});

test("production boots without the per-restaurant identifiers", () => {
  // RETELL_AGENT_ID and TWILIO_PHONE_NUMBER belong to the restaurants row,
  // not the deployment (review decision, biteperk-cloud-platform PR #20).
  // If this test starts failing, someone re-added them to requireInProd and
  // every Cloud Run environment without them stops booting again.
  const result = validateEnv(productionEnv);
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
  assert.equal(result.data!.RETELL_AGENT_ID, undefined);
  assert.equal(result.data!.TWILIO_PHONE_NUMBER, undefined);
});

// --- Voice-order payments (ORDER_PAYMENTS_ENABLED) --------------------------

test("order payments off by default, and the expiry floor respects Stripe's minimum + skew margin", () => {
  const result = validateEnv({ APP_ENV: "test", DATABASE_URL: DB });
  assert.equal(result.success, true);
  assert.equal(result.data!.ORDER_PAYMENTS_ENABLED, false);
  assert.equal(result.data!.STRIPE_CONNECT_ENABLED, false);
  assert.equal(result.data!.ORDER_PAYMENT_EXPIRY_MINUTES, 45);

  // Stripe rejects expires_at < 30 min out; exactly 30 fails intermittently
  // on clock skew, so the schema floor is 35.
  const tooShort = validateEnv({ APP_ENV: "test", DATABASE_URL: DB, ORDER_PAYMENT_EXPIRY_MINUTES: "30" });
  assert.equal(tooShort.success, false);
  assert.ok(issuePaths(tooShort).includes("ORDER_PAYMENT_EXPIRY_MINUTES"));
});

test("production with ORDER_PAYMENTS_ENABLED=true and nothing else refuses to boot, naming every gap", () => {
  const result = validateEnv({ ...productionEnv, ORDER_PAYMENTS_ENABLED: "true" });
  assert.equal(result.success, false);
  const paths = issuePaths(result);
  assert.ok(paths.includes("STRIPE_SECRET_KEY"));
  assert.ok(paths.includes("STRIPE_WEBHOOK_SECRET"));
  assert.ok(paths.includes("NOTIFICATIONS_SMS_FROM"));
  // Without this the success_url is literally "undefined/order/paid".
  assert.ok(paths.includes("PUBLIC_ORDER_RETURN_BASE_URL"));
  assert.ok(paths.includes("NOTIFICATIONS_ENABLED"));
  assert.ok(paths.includes("STRIPE_CONNECT_ENABLED"));
});

test("production with the full order-payments config boots", () => {
  const result = validateEnv({
    ...productionEnv,
    ORDER_PAYMENTS_ENABLED: "true",
    STRIPE_CONNECT_ENABLED: "true",
    NOTIFICATIONS_ENABLED: "true",
    EMAIL_PROVIDER: "zeptomail",
    ZEPTOMAIL_TOKEN: "ztok",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    NOTIFICATIONS_SMS_FROM: "+61400000000",
    PUBLIC_ORDER_RETURN_BASE_URL: "https://voxtable.biteperk.com.au"
  });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

test("production boots with email switched off and SMS still configured", () => {
  // The shape production actually runs in from 8 Sep 2026. Two things must hold
  // at once and they pull against each other: no email credential of any kind,
  // and SMS fully alive. Dropping the credential while EMAIL_PROVIDER=zeptomail
  // trips the boot gate, and NOTIFICATIONS_ENABLED=false would take SMS with it
  // AND block every SMS feature flag from ever being enabled — EMAIL_PROVIDER=none
  // is what makes this combination expressible.
  const result = validateEnv({
    ...productionEnv,
    NOTIFICATIONS_ENABLED: "true",
    EMAIL_PROVIDER: "none",
    NOTIFICATIONS_MESSAGING_SERVICE_SID: "MG7ceaa2aaa3cea6195ea7979d57b78b14",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "twilio-token"
  });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

test("EMAIL_PROVIDER=none refuses to boot alongside the verification-code flag", () => {
  // Production carried EMAIL_VERIFICATION_CODE_ENABLED=true for days against a
  // sender with no credit, queueing codes nobody could receive. Nothing calls
  // that endpoint any more — sign-up verification is Firebase's native link —
  // so the two settings together are always a mistake, and the boot says so
  // rather than the admin's "needs attention" list discovering it later.
  const result = validateEnv({
    ...productionEnv,
    NOTIFICATIONS_ENABLED: "true",
    EMAIL_PROVIDER: "none",
    EMAIL_VERIFICATION_CODE_ENABLED: "true",
    NOTIFICATIONS_MESSAGING_SERVICE_SID: "MG7ceaa2aaa3cea6195ea7979d57b78b14",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "twilio-token"
  });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("EMAIL_VERIFICATION_CODE_ENABLED"));
});

test("production order-payments boots on the Messaging Service alone, with no NOTIFICATIONS_SMS_FROM", () => {
  // The branded-SMS configuration: the Messaging Service owns the sender pool,
  // so there is no bare `from` to set. Before the sender ID landed this gate
  // demanded NOTIFICATIONS_SMS_FROM unconditionally, which would have made a
  // correctly-configured branded deployment refuse to boot.
  const result = validateEnv({
    ...productionEnv,
    ORDER_PAYMENTS_ENABLED: "true",
    STRIPE_CONNECT_ENABLED: "true",
    NOTIFICATIONS_ENABLED: "true",
    EMAIL_PROVIDER: "zeptomail",
    ZEPTOMAIL_TOKEN: "ztok",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    NOTIFICATIONS_MESSAGING_SERVICE_SID: "MG7ceaa2aaa3cea6195ea7979d57b78b14",
    PUBLIC_ORDER_RETURN_BASE_URL: "https://voxtable.biteperk.com.au"
  });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

test("a malformed Messaging Service SID is rejected at boot, not at send time", () => {
  // A typo'd SID would otherwise surface as a Twilio 400 on the first payment
  // link — mid phone call, with the caller waiting on a text that never comes.
  const result = validateEnv({
    ...productionEnv,
    NOTIFICATIONS_MESSAGING_SERVICE_SID: "MG-nope"
  });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("NOTIFICATIONS_MESSAGING_SERVICE_SID"));
});

test("production refuses to boot without the legal-documents manifest, even invite-only", () => {
  // This gate used to fire only when SELF_SERVE_SIGNUP_ENABLED=true, which
  // defaults false. An invite-only production therefore booted with no manifest
  // URL, and the agreement route fell back to writing the browser's own version
  // string and document hashes into the append-only ledger with a log line.
  // Self-serve is not what makes the evidence matter — a manually onboarded
  // venue signs the same agreement.
  const { LEGAL_DOCUMENTS_MANIFEST_URL, ...withoutManifest } = productionEnv;
  void LEGAL_DOCUMENTS_MANIFEST_URL;

  const inviteOnly = validateEnv({ ...withoutManifest, SELF_SERVE_SIGNUP_ENABLED: "false" });
  assert.equal(inviteOnly.success, false, "invite-only production must not boot unverified");
  assert.ok(issuePaths(inviteOnly).includes("LEGAL_DOCUMENTS_MANIFEST_URL"));

  // And the case that was already covered, so the stricter rule keeps it.
  const selfServe = validateEnv({ ...withoutManifest, SELF_SERVE_SIGNUP_ENABLED: "true" });
  assert.equal(selfServe.success, false);
  assert.ok(issuePaths(selfServe).includes("LEGAL_DOCUMENTS_MANIFEST_URL"));
});

test("development does not need the manifest — it is the local escape hatch", () => {
  const result = validateEnv({
    APP_ENV: "development",
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: "http://localhost:3050"
  });
  assert.equal(result.success, true);
});

// --- Cal.com per-venue event types (migration 035) ---------------------------
//
// These three encode the PR #107 lesson in a second channel: a boot gate must
// demand deployment config, never per-restaurant data. Cal.com event types moved
// onto the restaurants row, so the production rule inverted — the value must be
// ABSENT, not present.

test("production with Cal.com sync on boots without a global event type", () => {
  const result = validateEnv({
    ...productionEnv,
    CALCOM_SYNC_ENABLED: "true",
    CALCOM_API_KEY: "cal_test_key",
    CALCOM_WEBHOOK_SECRET: "whsec"
  });
  // The old gate demanded CALCOM_EVENT_TYPE_ID here, which is per-venue data —
  // exactly the mistake that stopped staging booting until PR #107.
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

test("production refuses a GLOBAL Cal.com event type — it would cross tenants", () => {
  const result = validateEnv({
    ...productionEnv,
    CALCOM_SYNC_ENABLED: "true",
    CALCOM_API_KEY: "cal_test_key",
    CALCOM_WEBHOOK_SECRET: "whsec",
    CALCOM_EVENT_TYPE_ID: "3414737"
  });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("CALCOM_EVENT_TYPE_ID"));
});

test("the credentials that ARE deployment config are still demanded", () => {
  const result = validateEnv({ ...productionEnv, CALCOM_SYNC_ENABLED: "true" });
  assert.equal(result.success, false);
  const paths = issuePaths(result);
  assert.ok(paths.includes("CALCOM_API_KEY"));
  assert.ok(paths.includes("CALCOM_WEBHOOK_SECRET"));
});

test("outside production the deprecated key parses but changes nothing", () => {
  const result = validateEnv({
    APP_ENV: "development",
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: "http://localhost:3050",
    CALCOM_SYNC_ENABLED: "true",
    CALCOM_EVENT_TYPE_ID: "3414737"
  });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
  assert.equal(result.data!.CALCOM_EVENT_TYPE_ID, 3414737);
});
