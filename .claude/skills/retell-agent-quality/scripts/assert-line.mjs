// assert-line.mjs <number> [--strict] [--config path] [--json]
//
// Asserts the WHOLE inbound chain for one phone number against its declared state
// in deploy/voice-lines.json, and exits non-zero on any drift.
//
// It exists because the line is four bindings in four systems — Twilio trunk, Retell
// number import, Retell agent, the restaurants row — and nothing checked them together.
// On 20 Aug 2026 three of the four were broken at once on production, for a day, and the
// way we found out was Sam placing a call. Each check below is named for the break it
// would have caught.
//
// Env: RETELL_API_KEY (required, the workspace key for THIS number's environment)
//      RETELL_WEBHOOK_SECRET (optional — production signs /retell/inbound with a DIFFERENT
//        string from the API key; signing with the API key 401s. Defaults to RETELL_API_KEY,
//        which is correct for the staging workspace.)
//      TWILIO_AU1_KEY_SID / TWILIO_AU1_KEY_SECRET (optional — enables the Twilio checks)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Retell } from "retell-sdk";
import { resolveCredentials } from "./line-credentials.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const configIdx = args.indexOf("--config");
const configPath = configIdx >= 0 ? args[configIdx + 1] : "deploy/voice-lines.json";
const number = args.find((a) => a.startsWith("+"));

if (!number) {
  console.error("usage: RETELL_API_KEY=… node assert-line.mjs <+E164> [--strict] [--config path]");
  process.exit(2);
}

const declared = JSON.parse(readFileSync(configPath, "utf8")).lines?.[number];
if (!declared) {
  console.error(`${number} is not declared in ${configPath}.`);
  console.error("An undeclared line cannot be checked — add it there first (identifiers only, no secrets).");
  process.exit(2);
}

// Credentials come from the DECLARATION, not the shell. Inheriting an ambient RETELL_API_KEY
// is what pointed this script at the legacy workspace on 20 Aug 2026 and turned a healthy
// production line into a two-hour outage: the wrong key answers every question confidently.
// --use-env exists for one-off debugging and says so loudly.
let KEY, WEBHOOK_SECRET, CRED_SOURCE;
if (args.includes("--use-env")) {
  KEY = process.env.RETELL_API_KEY;
  WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || KEY;
  CRED_SOURCE = "the environment (--use-env)";
  if (!KEY) { console.error("--use-env given but RETELL_API_KEY is not set"); process.exit(2); }
  console.log("⚠️  Using credentials from the environment. Nothing here can tell you whether they");
  console.log("   belong to this line's workspace — a wrong key reports a healthy line as broken.");
} else {
  try {
    const c = resolveCredentials(declared);
    KEY = c.apiKey; WEBHOOK_SECRET = c.webhookSecret; CRED_SOURCE = c.source;
  } catch (error) {
    console.error(`Could not load credentials for ${number}: ${error.message}`);
    process.exit(2);
  }
}
const H = { Authorization: `Bearer ${KEY}` };

// Preflight when the key came from the environment: prove it belongs to THIS line's workspace
// before drawing a single conclusion from it. A wrong key does not error — it returns clean
// 404s, which read as "the line is broken" and invite a repair that breaks a working line.
if (args.includes("--use-env")) {
  const probe = await fetch(`https://api.retellai.com/get-agent/${declared.retell_agent_id}`, { headers: H });
  if (probe.status === 404) {
    console.error(`\n✗ WRONG WORKSPACE KEY — this key cannot see ${declared.retell_agent_id},`);
    console.error(`  the agent ${number} is declared to use in the ${declared.retell_workspace} workspace.`);
    console.error("  Stopping here. Every check below would report a healthy line as broken.");
    process.exit(2);
  }
}

const results = [];
const check = (id, ok, label, detail) => {
  results.push({ id, state: ok ? "pass" : "fail", label, detail });
  if (!asJson) console.log(`${ok ? "✓" : "✗"} [${id}] ${label}${detail && !ok ? `\n     ${detail}` : ""}`);
  return ok;
};
// A layer we could not inspect must never render as a tick. Under --strict it fails the run.
const skip = (id, label, why) => {
  results.push({ id, state: "skip", label, detail: why });
  if (!asJson) console.log(`⚠ [${id}] SKIPPED — ${label}\n     ${why}`);
};

const host = (u) => { try { return new URL(u).host; } catch { return null; } };
// Mirrors retellProvisioning.ts:264 exactly. If that guard changes, change this with it.
const comparableName = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

const json = async (url, init) => {
  const res = await fetch(url, init);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body };
};

if (!asJson) {
  console.log(`\n${number} — declared ${declared.environment}, api ${declared.api_base}`);
  console.log(`workspace ${declared.retell_workspace} · credentials from ${CRED_SOURCE}\n`);
}

// ─── 1. The number exists in this Retell workspace ────────────────────────────
// BREAK 1 (20 Aug 2026): absent. Twilio offered the call to sip.retellai.com, Retell did
// not recognise the DID and rejected it. The caller heard a couple of seconds and a hangup;
// nothing appeared in list-calls, because from Retell's side there was no call.
const num = await json(`https://api.retellai.com/get-phone-number/${number}`, { headers: H });
const numberPresent = check(1, num.status === 200,
  "number is imported in this Retell workspace",
  `get-phone-number returned ${num.status}. Nothing routes to this number — a call to it reaches Retell and is rejected.`);

// ─── 2. It points at THIS environment, webhook-only ───────────────────────────
if (numberPresent) {
  const wh = num.body?.inbound_webhook_url ?? "";
  check(2, host(wh) === host(declared.api_base) && wh.endsWith("/retell/inbound"),
    `inbound_webhook_url is ${declared.api_base}/retell/inbound`,
    `found ${wh || "(none)"} — a number pointing at the other environment's API is how a staging test writes a production booking.`);

  if (declared.inbound_mode === "webhook-only") {
    // NUMBERS.md §6: a static inbound_agents entry is a FALLBACK that fires when the webhook
    // fails. On a venue number that means greeting the caller with stale default_dynamic_variables
    // — the wrong venue's name and months-old dates. A confidently wrong agent is worse than a
    // dead line, so webhook-only is deliberate.
    check(3, !num.body?.inbound_agents?.length,
      "no static inbound_agents (webhook-only, per NUMBERS.md §6)",
      `found ${JSON.stringify(num.body?.inbound_agents)} — this is the dual-binding fallback trap.`);
  }
} else {
  skip(2, "webhook URL + inbound mode", "the number is not imported, so there is nothing to inspect.");
}

// ─── 3. The backend answers, and resolves the right venue ─────────────────────
// This probe also proves the restaurants row TRANSITIVELY: override_agent_id and
// restaurant_name come from that row, so no database credentials are needed here.
const body = JSON.stringify({
  event: "call_inbound",
  call_inbound: { from_number: "+61400000000", to_number: number }
});
const sig = await Retell.sign(body, WEBHOOK_SECRET);
const probe = await json(`${declared.api_base}/retell/inbound`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-retell-signature": sig },
  body
});
const probeOk = check(4, probe.status === 200,
  "signed /retell/inbound returns 200",
  `got ${probe.status}. 401 usually means RETELL_WEBHOOK_SECRET is wrong — production signs with the webhook secret, NOT the API key.`);

const dv = probe.body?.call_inbound?.dynamic_variables ?? {};
let resolvedAgentId = null;
if (probeOk) {
  // The base set every backend serves. venue_faq / owner_name / today_status arrive only on
  // newer backends — production sits at migration 024 and cannot serve them, and requiring
  // them outright would fail a correctly-adapted agent. Report, don't fail.
  const base = ["restaurant_id", "restaurant_name", "restaurant_timezone", "today", "tomorrow", "caller_phone"];
  const missing = base.filter((k) => !(k in dv));
  check(5, missing.length === 0, "every base dynamic variable is served", `missing: ${missing.join(", ")}`);

  const richer = ["owner_name", "venue_faq", "today_status", "weekday_local"].filter((k) => k in dv);
  if (!asJson) console.log(`     serves richer variables: ${richer.length ? richer.join(", ") : "none (older backend — expected on production at migration 024)"}`);

  resolvedAgentId = probe.body?.call_inbound?.override_agent_id ?? null;

  // BREAK 2 (20 Aug 2026): the restaurants row bound the number to agent_b6b6488af08b82d80e8f4d270a,
  // which does not exist. The number could have been re-imported and the call would STILL have failed.
  check(6, resolvedAgentId === declared.retell_agent_id,
    `backend resolves the declared agent ${declared.retell_agent_id}`,
    `resolved ${resolvedAgentId ?? "(none — no agent bound)"}. This value comes from restaurants.retell_agent_id, so the database row is what is wrong.`);

  check(7, dv.restaurant_name === declared.venue_name,
    `backend resolves the venue as "${declared.venue_name}"`,
    `resolved "${dv.restaurant_name}" — restaurants.name differs from the declaration.`);
}

// ─── 4. The agent the backend hands out actually exists ───────────────────────
// The check nobody had. verifyAgentForVenue does this on the admin bind path, but production
// is at migration 024 so that route cannot run there — every production bind is raw SQL,
// which checks nothing.
// Verify the DECLARED agent, always — not whatever the backend happened to resolve. When the
// row points somewhere dead we still need the config checks below to run, or a second fault
// hides behind the first. That is exactly what happened on 20 Aug: the dead binding masked a
// stale agent name that would have 409'd the next rebind.
const agentIdToVerify = declared.retell_agent_id;
const agent = await json(`https://api.retellai.com/get-agent/${agentIdToVerify}`, { headers: H });
const agentExists = check(8, agent.status === 200,
  `declared agent ${agentIdToVerify} exists in this workspace`,
  `get-agent returned ${agent.status}. The agent this line is supposed to use is gone.`);

// And separately: if the backend resolved a DIFFERENT id, is that id even usable? A live call
// uses the resolved one, so a dead resolved id means every call fails regardless of check 8.
if (resolvedAgentId && resolvedAgentId !== declared.retell_agent_id) {
  const resolved = await json(`https://api.retellai.com/get-agent/${resolvedAgentId}`, { headers: H });
  check(18, false,
    `backend is serving a different agent (${resolvedAgentId})`,
    resolved.status === 200
      ? "that agent exists but is not the declared one — calls answer as the wrong venue."
      : `and get-agent returns ${resolved.status} for it — it does not exist, so every call to this number fails.`);
}

if (agentExists) {
  const agentName = agent.body?.agent_name ?? "";
  const venueForGuard = dv.restaurant_name ?? declared.venue_name;

  // BREAK 3 (20 Aug 2026): the production agent was still "Mazcina (production)" while the venue
  // had been renamed "Mazcina Resto-Bar". comparableName("mazcina") does not CONTAIN
  // "mazcinarestobar", so the next rebind through the admin API would have 409'd — discoverable
  // only mid-incident. Catch it while it is still cosmetic.
  check(9, comparableName(agentName).includes(comparableName(venueForGuard)),
    `agent name passes the bind guard against "${venueForGuard}"`,
    `agent is named "${agentName}" — a rebind would fail with 409 RETELL_AGENT_VENUE_MISMATCH (retellProvisioning.ts:322).`);

  check(10, agentName === declared.retell_agent_name,
    `agent name is exactly "${declared.retell_agent_name}"`,
    `found "${agentName}".`);

  const llmId = agent.body?.response_engine?.llm_id ?? null;
  check(11, llmId === declared.retell_llm_id,
    `agent runs the declared LLM ${declared.retell_llm_id}`,
    `runs ${llmId} — the agent has been re-pointed at a different prompt.`);

  for (const want of declared.pronunciation_dictionary ?? []) {
    const got = (agent.body?.pronunciation_dictionary ?? []).find((p) => p.word === want.word);
    check(12, got?.phoneme === want.phoneme,
      `pronunciation of "${want.word}" is ${want.phoneme}`,
      got ? `found ${got.phoneme}` : "no entry — the agent will guess, and guessed wrong on a venue name before.");
  }

  const boosted = agent.body?.boosted_keywords ?? [];
  const missingKw = (declared.required_boosted_keywords ?? []).filter((k) => !boosted.includes(k));
  check(13, missingKw.length === 0,
    "boosted_keywords carry the venue's full name",
    `missing: ${missingKw.join(", ")} — the STT is biased against hearing a caller say it.`);
}

// ─── 5. Golden config — delegate, don't restate ───────────────────────────────
if (agentExists) {
  const r = spawnSync(process.execPath,
    [new URL("./assert-agent.mjs", import.meta.url).pathname, agentIdToVerify, declared.retell_llm_id],
    // Pass the RESOLVED key down. assert-agent.mjs reads RETELL_API_KEY from its environment,
    // and since we no longer inherit an ambient one, the child would otherwise run keyless —
    // or worse, pick up a stale shell value for a different workspace.
    { env: { ...process.env, RETELL_API_KEY: KEY, VOXTABLE_API: declared.api_base }, encoding: "utf8" });
  const ok = r.status === 0;
  check(14, ok, "golden agent config (assert-agent.mjs)",
    (r.stdout ?? "").split("\n").filter((l) => l.startsWith("✗")).join("\n     ") || r.stderr);
} else {
  skip(14, "golden agent config", "the agent does not exist, so there is nothing to assert.");
}

// ─── 6. Twilio: the number still points at our trunk ──────────────────────────
// AU1 resources answer ONLY at {product}.sydney.au1.twilio.com and need AU1-scoped
// credentials; the US1 endpoints return empty lists that look exactly like a deleted estate.
const tw = process.env.TWILIO_AU1_KEY_SID && process.env.TWILIO_AU1_KEY_SECRET
  ? { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_AU1_KEY_SID}:${process.env.TWILIO_AU1_KEY_SECRET}`).toString("base64")}` }
  : null;

if (!tw) {
  skip(15, "Twilio number → trunk → origination",
    declared.twilio_au1_key_secret
      ? `no AU1 credentials in env. Load them: TWILIO_AU1_KEY_SID/SECRET from Secret Manager (${declared.twilio_au1_key_secret}-sid / -secret).`
      : "no AU1 API key exists for this account. Create one (Console → Account → API keys, Region = AU1); until then this layer is unverifiable and --strict fails.");
} else {
  const acct = declared.twilio_account_sid;
  const list = await json(
    `https://api.sydney.au1.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
    { headers: tw });
  const rec = list.body?.incoming_phone_numbers?.[0];
  const found = check(15, !!rec, `Twilio account ${acct} still owns the number`,
    `lookup returned ${list.status} with ${list.body?.incoming_phone_numbers?.length ?? 0} matches.`);

  if (found) {
    check(16, rec.trunk_sid === declared.twilio_trunk_sid,
      `number is attached to trunk ${declared.twilio_trunk_sid}`,
      `attached to ${rec.trunk_sid ?? "(no trunk)"} — with no trunk the call never reaches Retell at all.`);

    const orig = await json(
      `https://trunking.sydney.au1.twilio.com/v1/Trunks/${declared.twilio_trunk_sid}/OriginationUrls`,
      { headers: tw });
    const urls = orig.body?.origination_urls ?? [];
    check(17, urls.some((u) => u.enabled && /sip\.retellai\.com/.test(u.sip_url)),
      "trunk has an enabled origination URL to sip.retellai.com",
      `found ${JSON.stringify(urls.map((u) => ({ sip_url: u.sip_url, enabled: u.enabled })))}`);
  }
}

// ─── Verdict ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.state === "fail");
const skipped = results.filter((r) => r.state === "skip");

// If NEITHER the number nor the declared agent is visible, the likeliest explanation is not
// that both vanished — it is that this key belongs to a different workspace. Saying so is the
// difference between a five-minute fix and the 20 Aug outage, where the same reading was taken
// at face value and "repaired".
const numberMissing = results.some((r) => r.id === 1 && r.state === "fail");
const agentMissing = results.some((r) => r.id === 8 && r.state === "fail");
if (numberMissing && agentMissing && !asJson) {
  console.log("");
  console.log("⚠️  BOTH the number and the declared agent are invisible to this key.");
  console.log(`   That usually means the key is not ${declared.retell_workspace}'s, rather than that the`);
  console.log("   line is broken. Confirm the workspace in the Retell dashboard BEFORE changing");
  console.log("   anything — importing or rebinding on this reading will break a working line.");
}

if (asJson) {
  console.log(JSON.stringify({ number, environment: declared.environment, results, failed: failed.length, skipped: skipped.length }, null, 2));
} else {
  console.log("");
  if (failed.length) console.log(`FAILED: ${failed.length} broken layer(s) — ${failed.map((f) => `[${f.id}]`).join(" ")}`);
  else console.log(`All checks passed${skipped.length ? ` (${skipped.length} skipped)` : ""}.`);
  if (skipped.length && !strict) console.log(`${skipped.length} layer(s) unverified — re-run with --strict to treat that as failure.`);
  // NUMBERS.md §6: "The number is configured, so it works" is the standing mistake. This
  // script proves configuration. Only a real call that lands in call_logs proves the line.
  if (!failed.length) console.log("Configuration is proven. A real test call is still the only proof the line WORKS.");
}

process.exit(failed.length || (strict && skipped.length) ? 1 : 0);
