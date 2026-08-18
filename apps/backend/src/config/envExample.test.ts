/**
 * .env.example drift check.
 *
 * The fail-closed env gate turns a missing variable into a refused boot, so
 * the first anyone hears of an undocumented variable is a production revision
 * that won't start. This pins the contract: every key the schema knows is
 * either present in .env.example or deliberately listed below with a reason.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ENV_SCHEMA_KEYS, validateEnv } from "./env";

// Keys the schema accepts but .env.example deliberately omits. Every entry
// needs a reason comment — an entry without one is just drift with extra
// steps. Empty today: everything the schema knows is documented.
const DELIBERATELY_UNDOCUMENTED = new Set<string>([]);

const examplePath = path.resolve(__dirname, "../../../../.env.example");

function exampleKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of fs.readFileSync(examplePath, "utf8").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) {
      keys.add(match[1]);
    }
  }
  return keys;
}

test("every schema key is documented in .env.example (or deliberately excluded)", () => {
  const documented = exampleKeys();
  const missing = ENV_SCHEMA_KEYS.filter(
    (key) => !documented.has(key) && !DELIBERATELY_UNDOCUMENTED.has(key)
  );
  assert.deepEqual(
    missing,
    [],
    `These env keys exist in config/env.ts but not in .env.example — document them ` +
      `(or add to DELIBERATELY_UNDOCUMENTED with a reason): ${missing.join(", ")}`
  );
});

test("the deliberate-exclusion list holds only real schema keys", () => {
  // Catches an exclusion going stale after a key is renamed or removed.
  const stale = [...DELIBERATELY_UNDOCUMENTED].filter((key) => !ENV_SCHEMA_KEYS.includes(key));
  assert.deepEqual(stale, [], `Stale exclusions: ${stale.join(", ")}`);
});

// Parsing `.env.example` line-by-line, the way dotenv does: everything after
// `KEY=` is the value, including "" for the keys a human is meant to fill in.
function exampleEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(examplePath, "utf8").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      values[match[1]] = (match[2] ?? "").replace(/\s+#.*$/, "").trim();
    }
  }
  return values;
}

test("a fresh `cp .env.example .env` produces an environment that boots", () => {
  // The documented first-time setup is `cp .env.example .env` and run. That
  // path was broken: `.env.example` ships ~34 keys blank, and eight of them fed
  // validators that reject "" — six `z.string().url()` and two
  // `z.coerce.number().positive()` (which coerces "" to 0). The result was a
  // refused boot on values nobody had supplied. Key presence alone never caught
  // it, because the keys WERE present — they were just empty.
  const result = validateEnv({
    ...exampleEnv(),
    // The three the file legitimately expects a human to supply before running.
    APP_ENV: "development",
    DATABASE_URL: "postgres://user:pass@localhost:5432/vocotable",
    PUBLIC_API_BASE_URL: "http://localhost:3050"
  });

  const problems = result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  assert.deepEqual(
    problems,
    [],
    `.env.example does not boot as shipped. Blank optional values must parse as ` +
      `"not set" — wrap the key in blankAsUnset(). Failures:\n  ${problems.join("\n  ")}`
  );
});

test("blank means unset, but a malformed value is still rejected", () => {
  const base = {
    APP_ENV: "development",
    DATABASE_URL: "postgres://user:pass@localhost:5432/vocotable",
    PUBLIC_API_BASE_URL: "http://localhost:3050",
    DASHBOARD_ALLOWED_EMAILS: "dev@example.com"
  };

  const blank = validateEnv({ ...base, SENTRY_DSN: "   ", CALCOM_EVENT_TYPE_ID: "" });
  assert.equal(blank.success, true, "whitespace-only should be treated as unset");
  if (blank.success) {
    assert.equal(blank.data.SENTRY_DSN, undefined);
    assert.equal(blank.data.CALCOM_EVENT_TYPE_ID, undefined);
  }

  // The loosening must not swallow real mistakes.
  assert.equal(
    validateEnv({ ...base, SENTRY_DSN: "not-a-url" }).success,
    false,
    "a malformed URL must still refuse the boot"
  );
  assert.equal(
    validateEnv({ ...base, CALCOM_EVENT_TYPE_ID: "-3" }).success,
    false,
    "a non-positive number must still refuse the boot"
  );
});
