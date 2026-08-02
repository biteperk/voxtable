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

/** The shape of the real production .env, minus the secrets. */
const productionEnv = {
  APP_ENV: "production",
  DATABASE_URL: DB,
  PUBLIC_API_BASE_URL: PUBLIC_URL,
  RETELL_API_KEY: "key_realish",
  RETELL_AGENT_ID: "agent_realish",
  RETELL_VERIFY_SIGNATURE: "true",
  TWILIO_ACCOUNT_SID: "AC0",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_PHONE_NUMBER: "+61200000000",
  TWILIO_VALIDATE_SIGNATURE: "true",
  DASHBOARD_VERIFY_AUTH: "true",
  DASHBOARD_ALLOWED_EMAILS: "sam@example.com"
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
  assert.equal(result.data!.MULTITENANCY_LEGACY_FALLBACK, false);
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
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: PUBLIC_URL
  });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes("DASHBOARD_ALLOWED_EMAILS"));
});

test("a public host with every gate on and a real allowlist boots", () => {
  const result = validateEnv({
    APP_ENV: "development",
    DATABASE_URL: DB,
    PUBLIC_API_BASE_URL: PUBLIC_URL,
    DASHBOARD_ALLOWED_EMAILS: "sam@example.com"
  });
  assert.equal(result.success, true);
});

test("the real production environment still boots", () => {
  const result = validateEnv(productionEnv);
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
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
