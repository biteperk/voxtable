// selftest-assert-line.mjs [+E164]
//
// Proves assert-line.mjs can actually FAIL. A checker nobody has seen fail is indistinguishable
// from a checker that always passes, and this line has already been burned once by a document
// that recorded a change nobody verified.
//
// It takes a line that currently passes, corrupts one field of the declaration at a time in a
// throwaway copy, and requires the checker to fail on the matching check id. Read-only against
// every vendor — only the local declaration is varied.
//
// Env: whatever assert-line.mjs needs for the chosen line.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const number = process.argv.find((a) => a.startsWith("+")) ?? "+61468203234";
const source = JSON.parse(readFileSync("deploy/voice-lines.json", "utf8"));
const dir = mkdtempSync(join(tmpdir(), "voxtable-selftest-"));
const assertLine = new URL("./assert-line.mjs", import.meta.url).pathname;

const run = (configPath) => spawnSync(process.execPath, [assertLine, number, "--config", configPath],
  { encoding: "utf8", env: process.env });

const cases = [
  { name: "wrong webhook host", expect: 2, mutate: (l) => { l.api_base = "https://api.biteperk.com.au"; } },
  { name: "wrong agent id", expect: 6, mutate: (l) => { l.retell_agent_id = "agent_deadbeefdeadbeefdeadbeef"; } },
  { name: "wrong venue name", expect: 7, mutate: (l) => { l.venue_name = "Some Other Venue"; } },
  { name: "wrong llm id", expect: 11, mutate: (l) => { l.retell_llm_id = "llm_deadbeefdeadbeefdeadbeef"; } },
  { name: "wrong pronunciation", expect: 12, mutate: (l) => { l.pronunciation_dictionary = [{ word: "Mazcina", alphabet: "ipa", phoneme: "zzz" }]; } }
];

console.log(`\nself-test against ${number} — the checker must FAIL each of these\n`);

// Baseline: the unmodified declaration must pass, or every result below is meaningless.
const basePath = join(dir, "base.json");
writeFileSync(basePath, JSON.stringify(source));
const base = run(basePath);
if (base.status !== 0) {
  console.error("✗ baseline does not pass — fix the line first, or the self-test proves nothing.\n");
  console.error(base.stdout);
  process.exit(1);
}
console.log("✓ baseline passes");

let bad = 0;
for (const c of cases) {
  const copy = JSON.parse(JSON.stringify(source));
  c.mutate(copy.lines[number]);
  const path = join(dir, `${c.expect}.json`);
  writeFileSync(path, JSON.stringify(copy));

  const r = run(path);
  const failedIds = [...(r.stdout ?? "").matchAll(/^✗ \[(\d+)\]/gm)].map((m) => Number(m[1]));
  const ok = r.status === 1 && failedIds.includes(c.expect);
  console.log(`${ok ? "✓" : "✗"} ${c.name} → expected check [${c.expect}] to fail; got ${failedIds.length ? `[${failedIds.join("] [")}]` : "no failures"}`);
  if (!ok) bad++;
}

console.log(bad ? `\nSELF-TEST FAILED: ${bad} case(s) the checker did not catch.` : "\nSelf-test passed — the checker detects each corruption.");
process.exit(bad ? 1 : 0);
