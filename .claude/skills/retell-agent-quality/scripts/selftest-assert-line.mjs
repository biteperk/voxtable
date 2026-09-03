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

const run = (configPath, forNumber = number) => spawnSync(process.execPath, [assertLine, forNumber, "--config", configPath],
  { encoding: "utf8", env: process.env });

const cases = [
  { name: "wrong webhook host", expect: 2, mutate: (l) => { l.api_base = "https://api.biteperk.com.au"; } },
  { name: "wrong agent id", expect: 6, mutate: (l) => { l.retell_agent_id = "agent_deadbeefdeadbeefdeadbeef"; } },
  { name: "wrong venue name", expect: 7, mutate: (l) => { l.venue_name = "Some Other Venue"; } },
  { name: "wrong llm id", expect: 11, mutate: (l) => { l.retell_llm_id = "llm_deadbeefdeadbeefdeadbeef"; } },
  { name: "wrong pronunciation", expect: 12, mutate: (l) => { l.pronunciation_dictionary = [{ word: "Mazcina", alphabet: "ipa", phoneme: "zzz" }]; } },
  // [19]/[20] guard against a hand change at the vendor going unrecorded. The bug they exist to
  // catch is silent by construction — the line keeps answering — so the only way to know they
  // work is to watch them fail against a declaration that disagrees with the live trunk.
  // These two must run against a line that DECLARES the fields. Staging declares
  // neither, so [19]/[20] skip there and a mutation proves nothing — the first
  // version of this self-test toggled null to "tls", which happens to match the
  // real staging trunk, and reported the checker as broken when it was the case
  // that was wrong.
  { name: "declared transport disagrees with the trunk", expect: 19, number: "+61468202846", needsTwilio: true,
    mutate: (l) => { l.origination_transport = l.origination_transport === "tls" ? "tcp" : "tls"; } },
  { name: "declared Secure Trunking disagrees with the trunk", expect: 20, number: "+61468202846", needsTwilio: true,
    mutate: (l) => { l.trunk_secure = !l.trunk_secure; } }
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

const hasTwilio = Boolean(process.env.TWILIO_AU1_KEY_SID && process.env.TWILIO_AU1_KEY_SECRET);
if (!hasTwilio) {
  // assert-line skips its whole Twilio block without these, so [19]/[20] are never
  // evaluated and a mutation proves nothing. Saying so is the point: a self-test that
  // silently cannot reach a check reports the checker as sound when it was never asked.
  console.log("\n⚠ TWILIO_AU1_KEY_SID/SECRET not in env — trunk cases [19]/[20] cannot run.");
  console.log("  Export them (check-all-lines.sh does) to exercise those two.");
}

let skipped = 0;
let bad = 0;
for (const c of cases) {
  if (c.needsTwilio && !hasTwilio) { skipped++; continue; }
  const copy = JSON.parse(JSON.stringify(source));
  const target = c.number ?? number;
  c.mutate(copy.lines[target]);
  const path = join(dir, `${c.expect}.json`);
  writeFileSync(path, JSON.stringify(copy));

  const r = run(path, c.number ?? number);
  const failedIds = [...(r.stdout ?? "").matchAll(/^✗ \[(\d+)\]/gm)].map((m) => Number(m[1]));
  const ok = r.status === 1 && failedIds.includes(c.expect);
  console.log(`${ok ? "✓" : "✗"} ${c.name} → expected check [${c.expect}] to fail; got ${failedIds.length ? `[${failedIds.join("] [")}]` : "no failures"}`);
  if (!ok) bad++;
}

if (skipped) console.log(`\n${skipped} case(s) skipped for want of Twilio credentials.`);
console.log(bad ? `\nSELF-TEST FAILED: ${bad} case(s) the checker did not catch.` : "\nSelf-test passed — the checker detects each corruption.");
process.exit(bad ? 1 : 0);
