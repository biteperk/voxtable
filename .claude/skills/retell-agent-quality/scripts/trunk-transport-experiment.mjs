// trunk-transport-experiment.mjs — run (and undo) the ~7.6s call-drop experiment on a voice
// line's SIP trunk, from the line's DECLARATION rather than from ambient shell state.
//
// The experiment itself is deploy/runbooks/incident-7600ms-call-drops.md §6: align a failing
// AU1 trunk with the only configuration that has never dropped a call, one variable at a time.
//
// Why this is a script and not two curl commands (which the runbook already has):
//
//   1. ORDER IS LOAD-BEARING, AND THE ROLLBACK ORDER IS NOT THE REVERSE OF THE COMMANDS.
//      Secure Trunking REQUIRES TLS. So applying goes Secure=false -> transport=tcp, and
//      rolling back must go transport=tls -> Secure=true. Running the rollback in the same
//      order as the apply sets Secure=true while transport is still tcp, which does not
//      restore the line — it breaks it. A copied pair of curls invites exactly that.
//
//   2. NOTHING ASSERTED WHICH ACCOUNT IT WAS TALKING TO. That is the 20 Aug failure mode:
//      a credential is just a string, a wrong one returns clean confident answers, and the
//      "repair" that follows takes the line down. This asserts the trunk's own account_sid
//      equals the declared one BEFORE it writes anything, and exits 2 — not a wall of red —
//      when the credential cannot see the trunk at all.
//
//   3. THE RUNBOOK SAYS "read the config back". Write responses are not evidence
//      (SKILL doctrine: a document may only claim what a read-back printed), so this re-reads
//      from the API afterwards and asserts the values landed.
//
// Usage:
//   node trunk-transport-experiment.mjs <number>              # read-only report (default)
//   node trunk-transport-experiment.mjs <number> --apply      # TLS+secure -> TCP, staging only
//   node trunk-transport-experiment.mjs <number> --rollback    # restore TLS + Secure Trunking
//
// After --apply: place SIX calls, then
//   node latency-report.mjs 8
//   zero 7.6s drops in 6 -> transport confirmed (~93% at the observed ~35% rate)
//   any  7.6s drop       -> transport exonerated; AU1 region is the remaining variable
//                           (a trunk's region cannot be changed after creation — that is a
//                            new trunk and a number re-attach, i.e. its own decision)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DECLARATION = resolve(HERE, "../../../../deploy/voice-lines.json");

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

const number = process.argv[2];
const mode = process.argv.includes("--apply") ? "apply"
  : process.argv.includes("--rollback") ? "rollback"
  : "report";

if (!number || number.startsWith("--")) {
  console.error("usage: trunk-transport-experiment.mjs <number> [--apply|--rollback]");
  process.exit(64);
}

const lines = JSON.parse(readFileSync(DECLARATION, "utf8")).lines;
const declared = lines[number];
if (!declared) {
  console.error(`${number} is not declared in deploy/voice-lines.json. Declared: ${Object.keys(lines).join(", ")}`);
  process.exit(64);
}

console.log(`\nLine ${number} — ${declared.environment.toUpperCase()} — Twilio account ${declared.twilio_account_sid}`);
console.log(`Trunk ${declared.twilio_trunk_sid} (${declared.twilio_region})\n`);

// --- Guard 1: this experiment is staging-only, by the runbook's own design -------------------
if (mode !== "report" && declared.environment !== "staging") {
  bad(`Refusing to mutate a ${declared.environment} trunk.`);
  info("The experiment is deliberately staging-first: one variable, reversible, on a line that");
  info("is declared not customer-facing. Production repeats it only AFTER staging returns a");
  info("verdict, and per the runbook it is done in the Twilio console — no BitePerk-production");
  info("API credentials exist outside it (voice-lines.json: twilio_au1_key_secret = null).");
  process.exit(3);
}
if (mode !== "report" && declared.customer_facing) {
  bad("Refusing: this line is declared customer-facing.");
  process.exit(3);
}

// --- Credentials, from the declaration ------------------------------------------------------
const base = declared.twilio_au1_key_secret;
if (!base) {
  bad("This line declares no twilio_au1_key_secret, so there is no API path to its trunk.");
  info("That is true of production by design — use the Twilio console for that account.");
  process.exit(3);
}
const project = declared.retell_credentials?.gcp_project;
const secret = (suffix) => execFileSync("gcloud",
  ["secrets", "versions", "access", "latest", `--secret=${base}-${suffix}`, `--project=${project}`],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let keySid, keySecret;
try {
  keySid = secret("sid");
  keySecret = secret("secret");
} catch {
  bad(`Could not read ${base}-sid / ${base}-secret from Secret Manager (${project}).`);
  info("This is a credentials problem, not a trunk problem — nothing was read or changed.");
  process.exit(2);
}

// ⚠️ AU1 trunks live on the AU1 host. trunking.twilio.com 404s on them and the 404 looks
// exactly like a deleted trunk, which is its own way to send someone rebuilding a healthy line.
const HOST = declared.twilio_region === "au1"
  ? "https://trunking.sydney.au1.twilio.com"
  : "https://trunking.twilio.com";

const auth = "Basic " + Buffer.from(`${keySid}:${keySecret}`).toString("base64");
async function api(path, form) {
  const res = await fetch(`${HOST}${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: auth,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const trunkPath = `/v1/Trunks/${declared.twilio_trunk_sid}`;

// --- Guard 2: preflight identity. Never write to a trunk you have not proven is the right one.
const pre = await api(trunkPath);
if (pre.status === 401 || pre.status === 403) {
  bad(`The credential was rejected (${pre.status}).`);
  info("Wrong key or wrong account — NOT a broken trunk. Nothing was changed.");
  process.exit(2);
}
if (pre.status === 404) {
  bad(`Trunk ${declared.twilio_trunk_sid} not found on ${HOST}.`);
  info("A confident 404 here means the credential belongs to a DIFFERENT ACCOUNT far more often");
  info("than it means the trunk is gone. Verify the account before concluding anything.");
  process.exit(2);
}
if (pre.status !== 200) {
  bad(`Unexpected ${pre.status} reading the trunk.`);
  process.exit(2);
}
if (pre.body.account_sid !== declared.twilio_account_sid) {
  bad("ACCOUNT MISMATCH — refusing to touch this trunk.");
  info(`declared: ${declared.twilio_account_sid}`);
  info(`actual:   ${pre.body.account_sid}`);
  info("The credential can see a trunk, but not the one this line declares. This is the exact");
  info("shape of the 20 Aug incident: a wrong credential answering confidently.");
  process.exit(2);
}
ok(`account matches the declaration (${pre.body.account_sid})`);
ok(`trunk reachable on the ${declared.twilio_region.toUpperCase()} host`);

const origins = await api(`${trunkPath}/OriginationUrls`);
const urls = origins.body?.origination_urls ?? [];
if (urls.length !== 1) {
  bad(`Expected exactly 1 origination URL, found ${urls.length}.`);
  info("The experiment changes one variable; several URLs means the variable is not isolated.");
  urls.forEach((u) => info(`- ${u.sid} ${u.sip_url} (enabled=${u.enabled}, priority=${u.priority})`));
  if (mode !== "report") process.exit(3);
}
const origin = urls[0];

const transportOf = (u) => (u?.sip_url?.match(/transport=(\w+)/)?.[1] ?? "unspecified");
const state = () => `Secure Trunking = ${pre.body.secure}, origination = ${origin?.sip_url}  (transport ${transportOf(origin)})`;

console.log(`\nCurrent state:\n    ${state()}\n`);
// WHEN it last changed is as important as what it is. A trunk whose transport was altered by
// hand and never recorded turns every call before that moment into evidence about a different
// configuration — and the drop history is the only evidence this incident has.
info(`trunk last modified       : ${pre.body.date_updated}`);
info(`origination last modified : ${origin?.date_updated}`);
console.log("");

if (mode === "report") {
  const suspect = transportOf(origin) === "tls" && declared.twilio_region === "au1";
  console.log(suspect
    ? "This trunk carries BOTH surviving suspects from the incident: AU1 + TLS origination.\n" +
      "Re-run with --apply to test transport (the one that can be changed in place), place SIX\n" +
      "calls, then: node latency-report.mjs 8"
    : "This trunk is not in the suspected configuration; the experiment does not apply as written.");
  console.log("\nRead-only. Nothing was changed.\n");
  process.exit(0);
}

// --- Mutations. Order is load-bearing in BOTH directions. -----------------------------------
const steps = mode === "apply"
  // Secure Trunking requires TLS, so it must come off BEFORE the transport changes underneath it.
  ? [
      { what: "Secure Trunking -> false", call: () => api(trunkPath, { Secure: "false" }) },
      { what: "origination transport -> tcp",
        call: () => api(`${trunkPath}/OriginationUrls/${origin.sid}`,
          { SipUrl: "sip:sip.retellai.com;transport=tcp" }) },
    ]
  // Reverse: TLS must be back BEFORE Secure Trunking is re-enabled, or the line is left broken.
  : [
      { what: "origination transport -> tls",
        call: () => api(`${trunkPath}/OriginationUrls/${origin.sid}`,
          { SipUrl: "sip:sip.retellai.com;transport=tls" }) },
      { what: "Secure Trunking -> true", call: () => api(trunkPath, { Secure: "true" }) },
    ];

console.log(`Applying (${mode}) — ${steps.length} steps, in order:\n`);
for (const s of steps) {
  const r = await s.call();
  if (r.status >= 300) {
    bad(`${s.what} FAILED (${r.status}) ${JSON.stringify(r.body).slice(0, 200)}`);
    info("Stopping here. The line may be half-changed — re-run the OPPOSITE mode to restore,");
    info("and read the state back before placing any calls.");
    process.exit(1);
  }
  ok(s.what);
}

// --- Read-back. The write responses above are not evidence. ---------------------------------
const after = await api(trunkPath);
const afterOrigins = await api(`${trunkPath}/OriginationUrls`);
const afterOrigin = (afterOrigins.body?.origination_urls ?? [])[0];
const wantTransport = mode === "apply" ? "tcp" : "tls";
const wantSecure = mode === "apply" ? false : true;

console.log("\nREAD-BACK (from the API, not from the write responses):");
info(`Secure Trunking = ${after.body.secure}`);
info(`origination     = ${afterOrigin?.sip_url}  (transport ${transportOf(afterOrigin)})`);

let good = true;
if (transportOf(afterOrigin) !== wantTransport) { bad(`transport is ${transportOf(afterOrigin)}, expected ${wantTransport}`); good = false; }
if (after.body.secure !== wantSecure) { bad(`Secure Trunking is ${after.body.secure}, expected ${wantSecure}`); good = false; }
if (!good) process.exit(1);
ok("both values landed");

console.log(mode === "apply"
  ? "\nNEXT: place SIX calls to this number, then `node latency-report.mjs 8`.\n" +
    "  zero 7.6s drops -> transport confirmed. Repeat on production IN THE CONSOLE, and file\n" +
    "                     the Twilio ticket anyway — the right end state is TLS that works.\n" +
    "  any  7.6s drop  -> transport exonerated. AU1 region is what is left, and that means a\n" +
    "                     new trunk plus a number re-attach. Bring it back as its own decision.\n" +
    "  Undo at any time: --rollback\n"
  : "\nRestored to the configuration recorded in the runbook §4.\n");
