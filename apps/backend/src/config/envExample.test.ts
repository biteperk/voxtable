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

import { ENV_SCHEMA_KEYS } from "./env";

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
