// trunk-region-experiment.mjs — the AU1-vs-US1 test for the fixed ~7.6s call drop.
// See deploy/runbooks/incident-7600ms-call-drops.md §10 item 1.
//
// WHY THIS IS THE REMAINING EXPERIMENT
// Transport was exonerated on 27 Aug: the staging trunk has been TCP since 20 Aug and calls
// still dropped at 7,590–7,594 ms. Region is the only field left that differs between these
// trunks and the one that has never dropped a call in three months.
//
// WHY IT IS NOT A ONE-LINE CHANGE
// A trunk's region is fixed at creation. Testing region means BUILDING A SECOND TRUNK and
// MOVING THE NUMBER onto it. The move is the dangerous step: for the moment between detaching
// and attaching, the number routes nowhere and the line is dead. So this script does the build
// and the move as separate commands, and the move is a single API call that sets the new trunk
// rather than a detach followed by an attach.
//
// EXPERIMENTAL DESIGN — READ BEFORE CHANGING ANYTHING ELSE
// The new trunk is built with transport=tcp and Secure Trunking OFF *on purpose*. Staging is
// AU1+TCP today; the known-good trunk is US1+TCP. Building the new one as US1+TLS would change
// two variables at once and the result would be unattributable — which is exactly what made an
// earlier latency regression here impossible to attribute. Restore TLS AFTER the region has a
// verdict, as its own step.
//
// Usage:
//   node trunk-region-experiment.mjs <number>            # report: what exists, what would happen
//   node trunk-region-experiment.mjs <number> --build    # create the US1 trunk (does NOT move the number)
//   node trunk-region-experiment.mjs <number> --move     # point the number at the US1 trunk
//   node trunk-region-experiment.mjs <number> --revert   # point the number back at the declared trunk
//
// After --move: update deploy/voice-lines.json (twilio_trunk_sid, twilio_region, termination_uri)
// IN THE SAME SITTING — an undeclared trunk change is the exact failure this incident already
// suffered — then `assert-line.mjs <number>` and place ~20 calls.
//
// WHY ~20 AND NOT 6: the runbook's original 6 assumed a 35% drop rate. The observed rate is now
// 3/19. Six clean calls would prove very little; twenty gives a real answer.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DECLARATION = resolve(HERE, "../../../../deploy/voice-lines.json");
const NEW_TRUNK_NAME = "voxtable-staging-us1";
const SIP = "sip:sip.retellai.com;transport=tcp";

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

const number = process.argv[2];
const flag = (f) => process.argv.includes(f);
const mode = flag("--build") ? "build" : flag("--move") ? "move" : flag("--revert") ? "revert" : "report";
if (!number || number.startsWith("--")) {
  console.error("usage: trunk-region-experiment.mjs <number> [--build|--move|--revert]");
  process.exit(64);
}

const lines = JSON.parse(readFileSync(DECLARATION, "utf8")).lines;
const declared = lines[number];
if (!declared) { console.error(`${number} is not declared in deploy/voice-lines.json`); process.exit(64); }

console.log(`\nLine ${number} — ${declared.environment.toUpperCase()} — account ${declared.twilio_account_sid}`);
console.log(`Declared trunk ${declared.twilio_trunk_sid} (${declared.twilio_region})\n`);

// Staging-only, same reasoning as the transport experiment: this line is declared not
// customer-facing, and production has no API credentials outside the console anyway.
if (mode !== "report" && (declared.environment !== "staging" || declared.customer_facing)) {
  bad(`Refusing: this experiment runs on a non-customer-facing staging line only.`);
  info(`environment=${declared.environment} customer_facing=${declared.customer_facing}`);
  process.exit(3);
}
const base = declared.twilio_au1_key_secret;
if (!base) { bad("No API key declared for this account — use the Twilio console."); process.exit(3); }

const project = declared.retell_credentials?.gcp_project;
const secret = (sfx) => execFileSync("gcloud",
  ["secrets","versions","access","latest",`--secret=${base}-${sfx}`,`--project=${project}`],
  { encoding:"utf8", stdio:["ignore","pipe","pipe"] }).trim();
// TWO credentials, and they are NOT interchangeable — verified 27 Aug 2026:
//   AU1 API key       -> sees AU1 trunks. 401 on US1.
//   account auth token -> sees US1 trunks. 401 on AU1.
// So the region being addressed decides the credential. Using one for both produces 401s that
// read as "the resource does not exist", which is the failure this project keeps paying for.
let auth, acctAuth;
try {
  auth = "Basic " + Buffer.from(`${secret("sid")}:${secret("secret")}`).toString("base64");
  const g = (n) => execFileSync("gcloud", ["secrets","versions","access","latest",`--secret=${n}`,`--project=${project}`],
    { encoding:"utf8", stdio:["ignore","pipe","pipe"] }).trim();
  acctAuth = "Basic " + Buffer.from(`${g("voxtable-stg-twilio-account-sid")}:${g("voxtable-stg-twilio-auth-token")}`).toString("base64");
} catch {
  bad(`Could not read ${base}-sid / ${base}-secret from Secret Manager (${project}).`);
  info("Credentials problem, not a trunk problem. Nothing was read or changed.");
  process.exit(2);
}

// ⚠️ An AU1 API key is region-scoped. It can address AU1 resources at the Sydney hosts and the
// account's global resources (phone numbers) at api.twilio.com — but a US1 TRUNK may need a US1
// key. If --build 401s, that is what happened: create a US1 key in the console rather than
// concluding anything about trunks.
const US1 = "https://trunking.twilio.com";
const AU1 = "https://trunking.sydney.au1.twilio.com";
const declaredHost = declared.twilio_region === "au1" ? AU1 : US1;
const apiHost = declared.twilio_region === "au1" ? "https://api.sydney.au1.twilio.com" : "https://api.twilio.com";

async function call(url, form, method) {
  // US1 hosts take the account token; AU1 hosts take the AU1 key.
  const cred = /\.au1\.twilio\.com/.test(url) ? auth : acctAuth;
  const res = await fetch(url, {
    method: method ?? (form ? "POST" : "GET"),
    headers: { Authorization: cred, ...(form ? {"Content-Type":"application/x-www-form-urlencoded"} : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// --- Identity preflight. Never write to an account you have not proven. ---------------------
const cur = await call(`${declaredHost}/v1/Trunks/${declared.twilio_trunk_sid}`);
if (cur.status === 401 || cur.status === 403) { bad(`Credential rejected (${cur.status}). Wrong key or account — nothing changed.`); process.exit(2); }
if (cur.status === 404) { bad(`Declared trunk not found on ${declaredHost}. A confident 404 usually means the WRONG ACCOUNT, not a deleted trunk.`); process.exit(2); }
if (cur.status !== 200) { bad(`Unexpected ${cur.status} reading the declared trunk.`); process.exit(2); }
if (cur.body.account_sid !== declared.twilio_account_sid) {
  bad("ACCOUNT MISMATCH — refusing to touch anything.");
  info(`declared: ${declared.twilio_account_sid}`);
  info(`actual:   ${cur.body.account_sid}`);
  process.exit(2);
}
ok(`account matches the declaration (${cur.body.account_sid})`);

// --- Where is the number actually pointing right now? ---------------------------------------
const numQ = await call(`${apiHost}/2010-04-01/Accounts/${declared.twilio_account_sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
const rec = numQ.body?.incoming_phone_numbers?.[0];
if (!rec) { bad(`This account does not own ${number} (lookup ${numQ.status}).`); process.exit(2); }
ok(`account owns the number (${rec.sid})`);
info(`currently attached to trunk: ${rec.trunk_sid ?? "(none)"}`);

// --- Does a US1 trunk already exist? ---------------------------------------------------------
const existing = await call(`${US1}/v1/Trunks?PageSize=50`);
// An AU1-scoped key that cannot see US1 returns an ERROR, but `body.trunks` is then undefined and
// `?? []` would render that as "no trunk exists" — a credential failure wearing the costume of an
// empty estate. That mistake has already cost this project a two-hour outage once. Check the
// status, and refuse to reason about US1 at all if the answer is not a real list.
if (existing.status !== 200 || !Array.isArray(existing.body?.trunks)) {
  bad(`Cannot list US1 trunks (${existing.status}).`);
  info("This is NOT evidence that no US1 trunk exists — it is evidence this credential cannot see");
  info("US1. An AU1-scoped API key is region-scoped; create a US1 key in the Twilio console");
  info("(Account → API keys, Region = US1) and re-run. Nothing was changed.");
  process.exit(2);
}
const us1 = existing.body.trunks.find((t) => t.friendly_name === NEW_TRUNK_NAME);
if (us1) { ok(`US1 trunk already exists: ${us1.sid} (secure=${us1.secure})`); }
else info(`no US1 trunk named ${NEW_TRUNK_NAME} yet`);

if (mode === "report") {
  console.log(`\nWhat each command would do:`);
  info(`--build   create ${NEW_TRUNK_NAME} in US1, Secure OFF, origination ${SIP}`);
  info(`          (deliberately TCP: staging is AU1+TCP today, so region is the ONLY variable)`);
  info(`--move    BLOCKED — the number's config is region-partitioned (US1 reports no trunk,`);
  info(`          AU1 reports the AU1 trunk), so writing a US1 binding adds a parallel one`);
  info(`          instead of moving the line, and the read-back would pass on a dead line.`);
  info(`          Settle the number's voice region in the console first; --move explains how.`);
  info(`--revert  point it back at ${declared.twilio_trunk_sid}`);
  console.log(`\nRead-only. Nothing was changed.\n`);
  process.exit(0);
}

if (mode === "build") {
  if (us1) { ok("nothing to do — the trunk already exists"); process.exit(0); }
  const made = await call(`${US1}/v1/Trunks`, { FriendlyName: NEW_TRUNK_NAME, Secure: "false" });
  if (made.status >= 300) {
    bad(`Trunk creation failed (${made.status}) ${JSON.stringify(made.body).slice(0,200)}`);
    if (made.status === 401 || made.status === 403) info("An AU1-scoped key may not create US1 trunks — make a US1 key in the console.");
    process.exit(1);
  }
  ok(`created trunk ${made.body.sid}`);
  const org = await call(`${US1}/v1/Trunks/${made.body.sid}/OriginationUrls`,
    { FriendlyName:"retell", SipUrl:SIP, Priority:"1", Weight:"1", Enabled:"true" });
  if (org.status >= 300) {
    bad(`Origination URL failed (${org.status}) ${JSON.stringify(org.body).slice(0,200)}`);
    info(`The trunk exists but routes nowhere. Add the origination URL before moving the number.`);
    process.exit(1);
  }
  ok(`origination ${SIP}`);
  const rb = await call(`${US1}/v1/Trunks/${made.body.sid}/OriginationUrls`);
  console.log("\nREAD-BACK:");
  (rb.body?.origination_urls ?? []).forEach((u) => info(`${u.sip_url} enabled=${u.enabled}`));
  console.log(`\nNothing routes here yet — the number is untouched.`);
  console.log(`Record this trunk SID in deploy/voice-lines.json / the incident runbook NOW: an`);
  console.log(`unrecorded vendor resource is the thing that cost this incident six days of evidence.`);
  console.log(`\n--move is BLOCKED until the number's voice region is settled in the console.`);
  console.log(`Run --move to see what has to be established first.\n`);
  process.exit(0);
}

// ⚠️ STOP — THE NUMBER'S CONFIGURATION IS REGION-PARTITIONED.
// Verified 27 Aug 2026 on this very number: asked via the US1 host it reports trunk_sid=null,
// and via the AU1 host it reports the AU1 trunk. Same number, same account, two answers.
// So writing a US1 trunk binding does NOT move the line — it adds a second, parallel binding,
// and which one carries inbound calls depends on the number's VOICE REGION, which this API does
// not expose. CLAUDE.md records the same rule from the other direction: "a US1 number is
// invisible to an AU1 trunk — always change region BEFORE attaching."
//
// A --move that writes the binding and reads it back would therefore PASS while the line was
// dead. That is the worst available outcome, so the move is blocked until someone establishes
// how the number's voice region is set and changed. Do it in the console, on staging, and record
// the answer here.
if (mode === "move") {
  bad("Refusing to move the number — the region question is unresolved.");
  info("This number reports a DIFFERENT trunk binding per region (US1: none, AU1: the AU1 trunk),");
  info("so setting a US1 trunk adds a parallel binding rather than moving the line. The read-back");
  info("would pass and the line could still be dead — a false green on a live number.");
  info("");
  info("Settle this first, in the Twilio console on the STAGING account:");
  info("  1. Find where the number's voice region / inbound processing region is set.");
  info("  2. Confirm whether changing it is reversible.");
  info("  3. Record both answers in incident-7600ms-call-drops.md, then unblock this branch.");
  info("");
  info("--build is safe and unblocked: it creates a US1 trunk that nothing routes to yet.");
  process.exit(3);
}
if (!us1 && mode === "move") { bad(`No US1 trunk to move to. Run --build first.`); process.exit(3); }
const target = mode === "move" ? us1.sid : declared.twilio_trunk_sid;
const targetLabel = mode === "move" ? `${NEW_TRUNK_NAME} (US1)` : `${declared.twilio_trunk_sid} (${declared.twilio_region})`;

if (rec.trunk_sid === target) { ok(`already attached to ${targetLabel} — nothing to do`); process.exit(0); }

// One call, not detach-then-attach: a two-step move leaves a window where the number routes
// nowhere and every inbound call is dead air.
console.log(`\nMoving ${number} -> ${targetLabel}\n`);
const mv = await call(`${apiHost}/2010-04-01/Accounts/${declared.twilio_account_sid}/IncomingPhoneNumbers/${rec.sid}.json`,
  { TrunkSid: target });
if (mv.status >= 300) {
  bad(`Move failed (${mv.status}) ${JSON.stringify(mv.body).slice(0,200)}`);
  info(`The number should be unchanged (still ${rec.trunk_sid ?? "unattached"}) — verify before calling.`);
  process.exit(1);
}
const after = await call(`${apiHost}/2010-04-01/Accounts/${declared.twilio_account_sid}/IncomingPhoneNumbers/${rec.sid}.json`);
const landed = after.body?.trunk_sid;
console.log("READ-BACK (from the API, not the write response):");
info(`trunk_sid = ${landed}`);
if (landed !== target) { bad(`expected ${target}`); process.exit(1); }
ok("the number is on the intended trunk");

console.log(mode === "move"
  ? `\nNEXT, in this order:\n` +
    `  1. Update deploy/voice-lines.json NOW: twilio_trunk_sid=${target}, twilio_region="us1",\n` +
    `     termination_uri, and keep origination_transport="tcp" / trunk_secure=false.\n` +
    `     Declaring it later is how the last unrecorded trunk change cost six days of evidence.\n` +
    `  2. node assert-line.mjs ${number}\n` +
    `  3. Place ~20 calls, then: node latency-report.mjs 25\n` +
    `     any 7.6s drop -> region exonerated too, and the trunk is NOT the layer after all;\n` +
    `                      the Twilio ticket becomes the critical path.\n` +
    `     zero drops    -> region confirmed. Then re-introduce TLS as a SEPARATE step.\n` +
    `  Undo at any time: --revert\n`
  : `\nReverted. Update deploy/voice-lines.json back to the AU1 trunk in the same sitting.\n`);
