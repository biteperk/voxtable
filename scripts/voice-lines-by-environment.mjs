#!/usr/bin/env node
// voice-lines-by-environment.mjs <environment>
// voice-lines-by-environment.mjs --assert-covered <environment...>
//
// Reads deploy/voice-lines.json and prints the numbers declared for an environment, one per
// line, so .github/workflows/voice-line-health.yml can iterate the declaration instead of
// hardcoding numbers.
//
// It exists because the workflow DID hardcode them. Its own header claimed to assert "every
// line declared in deploy/voice-lines.json" while checking exactly two, so Cuban Corner's
// line — the newest, and the only one on a US1 trunk — was unmonitored from the day it was
// declared. Nothing failed; the check simply had no opinion about it, which is the worst
// shape a check can take.
//
// --assert-covered is the other half: it fails when a declared line names an environment no
// job handles. Without it, adding a line with a new environment would silently go unchecked
// again, one layer up.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.VOICE_LINES_CONFIG ?? join(repoRoot, "deploy/voice-lines.json");

let doc;
try {
  doc = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`Cannot read ${configPath}: ${error.message}`);
  process.exit(2);
}
const lines = doc.lines;
if (!lines || typeof lines !== "object") {
  console.error(`${configPath} has no "lines" object.`);
  process.exit(2);
}
// `agents` is optional — number-less agents (staging twins) whose greeting/hosts the pipeline
// still reconciles. Each entry carries the same `environment` field a line does.
const agents = doc.agents && typeof doc.agents === "object" ? doc.agents : {};

const entries = Object.entries(lines);
const agentEntries = Object.entries(agents);
const args = process.argv.slice(2);

if (args[0] === "--assert-covered") {
  const covered = new Set(args.slice(1));
  if (covered.size === 0) {
    console.error("usage: --assert-covered <environment...>");
    process.exit(2);
  }
  // Both lines and agents must name a covered environment, or a declared twin goes unchecked.
  const all = [...entries.map(([k, v]) => [k, v, "line"]), ...agentEntries.map(([k, v]) => [k, v, "agent"])];
  const orphans = all.filter(([, v]) => !covered.has(v.environment));
  for (const [k, v, kind] of all) {
    console.log(`${orphans.some(([n]) => n === k) ? "✗" : "✓"} ${k} (${v.environment}, ${kind})`);
  }
  if (orphans.length > 0) {
    console.error("");
    console.error(`::error::${orphans.length} declared line(s)/agent(s) are not asserted by any job:`);
    for (const [k, v, kind] of orphans) {
      console.error(`::error::  ${k} (${kind}) declares environment "${v.environment}" — jobs cover: ${[...covered].join(", ")}`);
    }
    console.error("Add a job for that environment, or it is declared but unchecked.");
    process.exit(1);
  }
  console.log(`\nAll ${all.length} declared line(s)/agent(s) are covered.`);
  process.exit(0);
}

// --agents <env>: print the declared number-less agent ids for an environment (may be empty).
if (args[0] === "--agents") {
  const environment = args[1];
  if (!environment) {
    console.error("usage: voice-lines-by-environment.mjs --agents <environment>");
    process.exit(2);
  }
  const ids = agentEntries.filter(([, a]) => a.environment === environment).map(([id]) => id);
  // Empty is legitimate — most environments have no number-less agents — so no non-zero exit.
  if (ids.length) console.log(ids.join("\n"));
  process.exit(0);
}

const environment = args[0];
if (!environment) {
  console.error("usage: voice-lines-by-environment.mjs <environment> | --agents <environment> | --assert-covered <environment...>");
  process.exit(2);
}

const numbers = entries
  .filter(([, line]) => line.environment === environment)
  .map(([number]) => number);

// An environment the workflow asks about but the declaration has none of is a mistake worth
// surfacing: a job looping over nothing passes, and a passing job reads as a checked line.
if (numbers.length === 0) {
  console.error(`No lines declared with environment "${environment}" in ${configPath}.`);
  process.exit(1);
}

console.log(numbers.join("\n"));
