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

const run = (configPath, forNumber = number, extraArgs = [], extraEnv = {}) =>
  spawnSync(process.execPath, [assertLine, forNumber, "--config", configPath, ...extraArgs],
    { encoding: "utf8", env: { ...process.env, ...extraEnv } });

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
    mutate: (l) => { l.trunk_secure = !l.trunk_secure; } },
  // Router-mode checks (staging). These exist because the checker read a detached AU1 trunk as a
  // ghost record for a week and passed while three real calls failed (6 Sep 2026). Each corrupts
  // the declaration; the live switchboard is never touched.
  { name: "router: declared voice_url disagrees with the number", expect: 16, router: true,
    mutate: (l) => { l.routing.voice_url = "https://example.invalid/router"; } },
  { name: "router: declared voice region disagrees with the number", expect: 17, router: true,
    mutate: (l) => { l.routing.twilio_voice_region = l.routing.twilio_voice_region === "us1" ? "au1" : "us1"; } },
  { name: "router: live holder is not a declared profile", expect: 19, router: true,
    mutate: (l) => { delete l.routing.profiles.voxtable; } },
  { name: "router: declared target transport disagrees with the Variable", expect: 20, router: true,
    mutate: (l) => { l.routing.profiles.voxtable.router_target = "sip:{To}@sip.retellai.com;transport=tls"; } },
  { name: "router: declared desk disagrees with DESK_NUMBER", expect: 21, router: true,
    mutate: (l) => { l.routing.desk_number = "+61400000000"; } },
  // And the other direction: the DECLARATION is right and the SWITCHBOARD drifted. A fixture file
  // stands in for the live Variables (ASSERT_LINE_ROUTER_VARIABLES), so this is the one case that
  // watches the checker catch a hand change at the vendor rather than a typo in the repo.
  { name: "router: switchboard holder drifted to an undeclared slug", expect: 19, router: true,
    variables: { ACTIVE_APP_61468203234: "somebody_else", TARGET_SOMEBODY_ELSE_61468203234: "https://example.invalid/twiml", DESK_NUMBER: "+61450011140" } },
  { name: "router: --expect names a profile that is not the holder", expect: 23, router: true, extraArgs: ["--expect", "voxstay"] }
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

const isRouterLine = source.lines[number]?.routing?.mode === "router";
if (!isRouterLine) console.log(`\n⚠ ${number} is not a router-mode line — router cases cannot run against it.`);

let skipped = 0;
let bad = 0;
for (const c of cases) {
  if (c.needsTwilio && !hasTwilio) { skipped++; continue; }
  if (c.router && !isRouterLine) { skipped++; continue; }
  const copy = JSON.parse(JSON.stringify(source));
  const target = c.number ?? number;
  if (c.mutate) c.mutate(copy.lines[target]);
  const path = join(dir, `${c.expect}-${cases.indexOf(c)}.json`);
  writeFileSync(path, JSON.stringify(copy));
  const extraEnv = {};
  if (c.variables) {
    const fixture = join(dir, `vars-${cases.indexOf(c)}.json`);
    writeFileSync(fixture, JSON.stringify(c.variables));
    extraEnv.ASSERT_LINE_ROUTER_VARIABLES = fixture;
  }

  const r = run(path, c.number ?? number, c.extraArgs ?? [], extraEnv);
  const failedIds = [...(r.stdout ?? "").matchAll(/^✗ \[(\d+)\]/gm)].map((m) => Number(m[1]));
  const ok = r.status === 1 && failedIds.includes(c.expect);
  console.log(`${ok ? "✓" : "✗"} ${c.name} → expected check [${c.expect}] to fail; got ${failedIds.length ? `[${failedIds.join("] [")}]` : "no failures"}`);
  if (!ok) bad++;
}

if (skipped) console.log(`\n${skipped} case(s) skipped (Twilio trunk credentials absent, or the chosen line is not router-mode).`);
console.log(bad ? `\nSELF-TEST FAILED: ${bad} case(s) the checker did not catch.` : "\nSelf-test passed — the checker detects each corruption.");
process.exit(bad ? 1 : 0);
