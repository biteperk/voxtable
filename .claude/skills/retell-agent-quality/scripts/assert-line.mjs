// assert-line.mjs <number> [--strict] [--config path] [--json] [--expect <profile>] [--calls <hours>]
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
// Two shapes of Twilio layer, chosen by the declaration's routing.mode:
//   trunk  (absent = trunk) — the number sits on an Elastic SIP Trunk; checks [15]-[20] read the
//            trunk. Production lines.
//   router — the number's voice_url points at the Twilio Function switchboard in ~/voxstay, and
//            WHICH agent answers is a router Variable. Checks [15]-[21] read the number, its voice
//            region and the live Variables, print the live holder as HOLDER: <profile>, and assert
//            the state is COHERENT with that profile. Until 6 Sep 2026 this script read the AU1
//            trunk the staging number had been detached from since 30 Aug, found the ghost record,
//            and passed while three real calls failed. A checker that reads the wrong layer is worse
//            than none: it ends the conversation.
//   --expect <profile>  additionally fail unless the live holder IS that profile (for a human about
//            to dial, and for switch-line.mjs). Never on a schedule — the holder is switched by hand.
//   --calls <hours>     (router, staging) the most recent SIP leg to Retell in the window must have
//            connected. Configuration read-backs stayed green all night on 5 Sep 2026 while Retell
//            answered nothing; only the outcome of real legs sees that.
//
// Env: RETELL_API_KEY (required, the workspace key for THIS number's environment)
//      RETELL_WEBHOOK_SECRET (optional — production signs /retell/inbound with a DIFFERENT
//        string from the API key; signing with the API key 401s. Defaults to RETELL_API_KEY,
//        which is correct for the staging workspace.)
//      TWILIO_AU1_KEY_SID / TWILIO_AU1_KEY_SECRET (optional — enables the Twilio checks)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Retell } from "retell-sdk";
import { resolveCredentials, resolveSecret } from "./line-credentials.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const configPath = at("--config") ?? "deploy/voice-lines.json";
const expectProfile = at("--expect");
const callsHours = args.includes("--calls") ? (Number(at("--calls")) || 24) : null;
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

// ─── 0. Router-mode lines: read the live switchboard before judging anything ──
// The Retell checks below depend on WHO holds the number (a lent-out number legitimately has a
// different Retell shape), so the router is read first. All reads; nothing here writes, and
// nothing here runs voxstay's `status` command — that command auto-releases a stale claim on
// read, and a checker must never change what it checks.
const routing = declared.routing ?? { mode: "trunk" };
const isRouter = routing.mode === "router";
const digits = number.replace(/^\+/, "");
// Mirrors lookup() in ~/voxstay/scripts/router-function.js exactly: the per-number key wins,
// an empty string counts as unset, the un-suffixed global is the fallback, values are trimmed.
const lookup = (vars, base) => {
  const v = vars[`${base}_${digits}`];
  return ((v !== undefined && v !== "" ? v : vars[base]) || "").trim();
};
const acct = declared.twilio_account_sid;
let twBasic = null;   // account-token auth for a router line
let router = null;    // { rec, voiceRegion, vars, varsError, holder, target, desk, profile, svcSid, envSid }
if (isRouter) {
  try {
    const sid = resolveSecret(routing.twilio_auth?.account_sid_secret, routing.twilio_auth?.gcp_project);
    const tok = resolveSecret(routing.twilio_auth?.auth_token_secret, routing.twilio_auth?.gcp_project);
    twBasic = { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString("base64")}` };
  } catch (error) {
    router = { error: `could not resolve routing.twilio_auth: ${error.message}` };
  }
  if (twBasic) {
    const list = await json(
      `https://api.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
      { headers: twBasic });
    const region = await json(`https://routes.twilio.com/v2/PhoneNumbers/${encodeURIComponent(number)}`, { headers: twBasic });
    const vars = {};
    let varsError = null;
    let svcSid = null, envSid = null;
    // Self-test hook: a JSON file of Variables stands in for the live switchboard, so the
    // holder/target/desk checks can be watched failing without touching the router.
    const fixture = process.env.ASSERT_LINE_ROUTER_VARIABLES;
    if (fixture) {
      Object.assign(vars, JSON.parse(readFileSync(fixture, "utf8")));
    } else {
      const services = await json("https://serverless.twilio.com/v1/Services?PageSize=100", { headers: twBasic });
      const svc = (services.body?.services ?? []).find((x) => x.unique_name === routing.router_service);
      if (!svc) {
        varsError = `Serverless service "${routing.router_service}" not found on ${acct} (HTTP ${services.status})`;
      } else {
        const envs = await json(`https://serverless.twilio.com/v1/Services/${svc.sid}/Environments?PageSize=50`, { headers: twBasic });
        const env = (envs.body?.environments ?? []).find((e) => e.domain_name === host(routing.voice_url))
          ?? envs.body?.environments?.[0];
        if (!env) {
          varsError = "router service has no deployed environment";
        } else {
          svcSid = svc.sid; envSid = env.sid;
          const vs = await json(`https://serverless.twilio.com/v1/Services/${svc.sid}/Environments/${env.sid}/Variables?PageSize=100`, { headers: twBasic });
          for (const v of vs.body?.variables ?? []) vars[v.key] = v.value;
          if (vs.status !== 200) varsError = `Variables read returned HTTP ${vs.status}`;
        }
      }
    }
    const holder = lookup(vars, "ACTIVE_APP").toLowerCase();
    router = {
      rec: list.body?.incoming_phone_numbers?.[0] ?? null,
      listStatus: list.status,
      voiceRegion: region.body?.voice_region ?? null,
      vars, varsError, svcSid, envSid,
      holder,
      target: holder ? lookup(vars, `TARGET_${holder.toUpperCase()}`) : "",
      desk: lookup(vars, "DESK_NUMBER"),
      profile: routing.profiles?.[holder] ?? null
    };
  }
  if (!asJson) console.log(`router: ${router?.error ?? router?.varsError ?? `holder "${router.holder || "(unset)"}"`}\n`);
}
const profile = router?.profile ?? null;
// What shape the Retell number must be in. A lent-out number ("untouched") keeps VoxTable's
// webhook shape — Retell simply never sees the call while the router sends it elsewhere.
const retellMode = profile?.retell === "static" ? "static" : "webhook";

// ─── 1. The number exists in this Retell workspace ────────────────────────────
// BREAK 1 (20 Aug 2026): absent. Twilio offered the call to sip.retellai.com, Retell did
// not recognise the DID and rejected it. The caller heard a couple of seconds and a hangup;
// nothing appeared in list-calls, because from Retell's side there was no call.
const num = await json(`https://api.retellai.com/get-phone-number/${number}`, { headers: H });
const numberPresent = check(1, num.status === 200,
  "number is imported in this Retell workspace",
  `get-phone-number returned ${num.status}. Nothing routes to this number — a call to it reaches Retell and is rejected.`);

// ─── 2. It points at THIS environment, webhook-only ───────────────────────────
if (numberPresent && retellMode === "static") {
  // The live holder pins another Retell agent on this number. Then the webhook MUST be cleared:
  // with both set, the static agent is the fallback that fires when the webhook fails
  // (NUMBERS.md §6), and the number answers as one agent on good days and the other on bad ones.
  const wh = num.body?.inbound_webhook_url ?? "";
  const agents = num.body?.inbound_agents ?? [];
  check(2, !wh, `inbound webhook cleared while profile "${router.holder}" pins a static agent`,
    `found ${wh} alongside inbound_agents — the dual-binding fallback trap, in the other direction.`);
  check(3, agents.length === 1 && agents[0]?.agent_id === profile.retell_agent_id,
    `inbound_agents pins ${profile.retell_agent_id} for profile "${router.holder}"`,
    `found ${JSON.stringify(agents)}.`);
} else if (numberPresent) {
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

// ─── 3. The staging backend answers and resolves the right venue ──────────────
// This POST is a synthetic inbound event. It is permitted in staging only.
// Production policy allows non-mutating health/readiness, configuration
// read-backs and monitoring, so production lines deliberately skip this layer.
let dv = {};
let resolvedAgentId = null;
if (declared.environment === "production") {
  skip(4, "signed /retell/inbound probe", "production synthetic probes are prohibited; run this layer on the staging twin");
  skip(5, "backend dynamic variables", "production is read-back and monitoring only");
  skip(6, "backend agent resolution", "production is read-back and monitoring only");
  skip(7, "backend venue resolution", "production is read-back and monitoring only");
} else {
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
    `got ${probe.status}. 401 usually means RETELL_WEBHOOK_SECRET is wrong.`);

  dv = probe.body?.call_inbound?.dynamic_variables ?? {};
  if (probeOk) {
  // The base set every backend serves. Richer variables depend on the deployed API version;
  // report their presence separately so a deliberately compatible agent remains checkable.
  const base = ["restaurant_id", "restaurant_name", "restaurant_timezone", "today", "tomorrow", "caller_phone"];
  const missing = base.filter((k) => !(k in dv));
  check(5, missing.length === 0, "every base dynamic variable is served", `missing: ${missing.join(", ")}`);

  const richer = ["owner_name", "venue_faq", "today_status", "weekday_local"].filter((k) => k in dv);
  if (!asJson) console.log(`     serves richer variables: ${richer.length ? richer.join(", ") : "none"}`);

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
    { env: {
        ...process.env,
        RETELL_API_KEY: KEY,
        VOXTABLE_API: declared.api_base,
        // The AI/recording disclosure is required on every production greeting. Staging
        // runs the short greeting by design; only a line DECLARED staging may skip it.
        ALLOW_NO_DISCLOSURE: declared.environment === "staging" ? "1" : "0",
        // Per-line, and only ever the AI half — the recording disclosure stays
        // enforced in production regardless. Absent means true (disclose).
        ALLOW_NO_AI_DISCLOSURE: declared.greeting_ai_disclosure === false ? "1" : "0",
        // The backend proved (check [2]/[5]'s probe) whether it serves menu_status.
        // Only then may the prompt be required to reference {{menu_status}} — a
        // reference against an older backend renders literally as spoken braces.
        REQUIRE_MENU_STATUS: "menu_status" in dv ? "1" : "0"
      }, encoding: "utf8" });
  const ok = r.status === 0;
  check(14, ok, "golden agent config (assert-agent.mjs)",
    (r.stdout ?? "").split("\n").filter((l) => l.startsWith("✗")).join("\n     ") || r.stderr);
} else {
  skip(14, "golden agent config", "the agent does not exist, so there is nothing to assert.");
}

// ─── 6r. Twilio, router mode: the number points at the switchboard and the switchboard is coherent
if (isRouter) {
  if (!twBasic) {
    skip(15, "Twilio number → router", router?.error ?? "no credentials");
  } else {
    const rec = router.rec;
    const found = check(15, !!rec, `Twilio account ${acct} still owns the number`,
      `lookup returned ${router.listStatus} with no match.`);
    if (found) {
      check(16, rec.voice_url === routing.voice_url && rec.voice_fallback_url === routing.voice_fallback_url && !rec.trunk_sid,
        "number's voice_url and voice_fallback_url point at the router, and no trunk is attached",
        `voice_url=${rec.voice_url || "(none)"} fallback=${rec.voice_fallback_url || "(none)"} trunk_sid=${rec.trunk_sid ?? "(none)"} — ` +
        "a trunk bypasses the router entirely, and a moved voice_url means the number was edited by hand (voxstay docs/number-routing.md rule 1).");
      check(17, router.voiceRegion === routing.twilio_voice_region,
        `voice region is ${routing.twilio_voice_region}`,
        `routes API says ${router.voiceRegion ?? "(unreadable)"} — in au1 this number received NO inbound at all for 18 days in Aug 2026, with no error anywhere.`);
    }
    if (router.varsError) {
      skip(19, "router holder", router.varsError);
      skip(20, "router target", router.varsError);
      skip(21, "desk fallback", router.varsError);
    } else {
      const declaredProfiles = Object.keys(routing.profiles ?? {});
      check(19, !!profile,
        `router holder "${router.holder || "(unset)"}" is a declared profile (${declaredProfiles.join(", ")})`,
        `ACTIVE_APP resolves to "${router.holder || "(unset)"}" — every call goes to a target this declaration knows nothing about, or to the desk. Declare the profile, or switch back with switch-line.mjs.`);
      if (profile) {
        // The Variable holds the TEMPLATE — "{To}" is substituted by the router per call — so the
        // comparison is template to template. Well-formedness is judged after substitution, the way
        // the router itself does it, because that is the string a call actually dials.
        const dialed = router.target.split("{To}").join(number);
        const wellFormed = /^https:\/\/[^\s"'<>]+$/.test(dialed) || /^sip:[^\s"'<>]+$/.test(dialed);
        check(20, router.target === profile.router_target && wellFormed,
          `router target for "${router.holder}" is ${profile.router_target} (dials ${dialed})`,
          `live TARGET is "${router.target || "(unset)"}" — a wrong transport, host or user-part reaches nothing, and a malformed one is silently routed to the desk.`);
      }
      check(21, router.desk === routing.desk_number,
        `desk fallback is ${routing.desk_number}`,
        `DESK_NUMBER resolves to "${router.desk || "(unset)"}" — a failed SIP leg rings this, or hangs up if unset.`);
    }
  }
}

// ─── 6. Twilio, trunk mode: the number still points at our trunk ──────────────
// AU1 resources answer ONLY at {product}.sydney.au1.twilio.com and need AU1-scoped
// credentials; the US1 endpoints return empty lists that look exactly like a deleted estate.
// The reverse is equally true and was hardcoded here: a US1 line checked against the AU1 host
// returns 401, which reads as "the credentials are wrong" when nothing is wrong at all. Derive
// the host from the DECLARED region instead — Cuban Corner's line is US1 on purpose.
const twHost = (product) => declared.twilio_region === "au1"
  ? `https://${product}.sydney.au1.twilio.com`
  : `https://${product}.twilio.com`;
const tw = process.env.TWILIO_AU1_KEY_SID && process.env.TWILIO_AU1_KEY_SECRET
  ? { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_AU1_KEY_SID}:${process.env.TWILIO_AU1_KEY_SECRET}`).toString("base64")}` }
  : null;

if (isRouter) {
  // handled in 6r above
} else if (!tw) {
  skip(15, "Twilio number → trunk → origination",
    declared.twilio_au1_key_secret
      ? `no AU1 credentials in env. Load them: TWILIO_AU1_KEY_SID/SECRET from Secret Manager (${declared.twilio_au1_key_secret}-sid / -secret).`
      : "no AU1 API key exists for this account. Create one (Console → Account → API keys, Region = AU1); until then this layer is unverifiable and --strict fails.");
} else {
  const list = await json(
    `${twHost("api")}/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
    { headers: tw });
  const rec = list.body?.incoming_phone_numbers?.[0];
  const found = check(15, !!rec, `Twilio account ${acct} still owns the number`,
    `lookup returned ${list.status} with ${list.body?.incoming_phone_numbers?.length ?? 0} matches.`);

  if (found) {
    check(16, rec.trunk_sid === declared.twilio_trunk_sid,
      `number is attached to trunk ${declared.twilio_trunk_sid}`,
      `attached to ${rec.trunk_sid ?? "(no trunk)"} — with no trunk the call never reaches Retell at all.`);

    const orig = await json(
      `${twHost("trunking")}/v1/Trunks/${declared.twilio_trunk_sid}/OriginationUrls`,
      { headers: tw });
    const urls = orig.body?.origination_urls ?? [];
    check(17, urls.some((u) => u.enabled && /sip\.retellai\.com/.test(u.sip_url)),
      "trunk has an enabled origination URL to sip.retellai.com",
      `found ${JSON.stringify(urls.map((u) => ({ sip_url: u.sip_url, enabled: u.enabled })))}`);

    // [19]/[20] exist because a hand change to this trunk went unrecorded for six days
    // (incident-7600ms-call-drops.md §3b). Nothing referenced the transport, so nothing could
    // notice, and call data from that window was read against the wrong assumed config.
    const transportOf = (u) => u?.sip_url?.match(/transport=(\w+)/)?.[1] ?? "unspecified";
    const live = transportOf(urls.find((u) => /sip\.retellai\.com/.test(u.sip_url)));

    if (declared.origination_transport == null) {
      skip(19, "trunk origination transport",
        "not declared for this line. That is deliberate where nobody can read the trunk back " +
        "(production has no API credentials outside the console) — a guessed value in a " +
        "declaration is worse than a blank. Read it from the console and fill it in.");
    } else {
      check(19, live === declared.origination_transport,
        `origination transport is ${declared.origination_transport}`,
        `trunk says ${live}. Someone changed it at the vendor without updating this declaration — ` +
        `treat every conclusion drawn from recent call data as being about an unknown config.`);
    }

    const trunk = await json(`${twHost("trunking")}/v1/Trunks/${declared.twilio_trunk_sid}`, { headers: tw });
    if (declared.trunk_secure == null) {
      skip(20, "Secure Trunking flag", "not declared for this line — see [19].");
    } else {
      check(20, trunk.body?.secure === declared.trunk_secure,
        `Secure Trunking is ${declared.trunk_secure}`,
        `trunk says ${trunk.body?.secure}. Secure Trunking REQUIRES TLS, so this flag and [19] ` +
        `move together: secure=true with a non-TLS transport is a broken line, not a downgrade.`);
    }
  }
}

// ─── 7. --expect: the holder a human is about to rely on ──────────────────────
if (expectProfile) {
  if (!isRouter) skip(23, `holder is "${expectProfile}"`, "only a router-mode line has a switchable holder.");
  else if (!router?.holder && router?.varsError) skip(23, `holder is "${expectProfile}"`, router.varsError);
  else check(23, router.holder === expectProfile,
    `holder is "${expectProfile}"`,
    `holder is "${router.holder || "(unset)"}". Do not dial expecting ${expectProfile}. Switch with: node ${new URL("./switch-line.mjs", import.meta.url).pathname} ${number} --to ${expectProfile} --apply`);
}

// ─── 8. --calls: did the last real leg to Retell actually connect? ────────────
// Judged on the MOST RECENT leg only. "Any failure in the window" would keep this red for a day
// after one transient stall and teach everyone to scroll past it.
if (callsHours !== null) {
  const label = `most recent SIP leg to Retell in ${callsHours} h connected`;
  if (!isRouter) skip(24, label, "trunk-routed legs never appear in the Calls API; only a router line can be judged on outcomes.");
  else if (declared.environment === "production") skip(24, label, "production is read-back and monitoring only.");
  else if (!twBasic) skip(24, label, router?.error ?? "no Twilio credentials");
  else {
    const since = new Date(Date.now() - callsHours * 3600e3);
    const when = (c) => new Date(c.start_time ?? c.date_created);
    const calls = await json(
      `https://api.twilio.com/2010-04-01/Accounts/${acct}/Calls.json?StartTime%3E=${since.toISOString().slice(0, 10)}&PageSize=1000`,
      { headers: twBasic });
    const legs = (calls.body?.calls ?? [])
      .filter((c) => c.direction === "outbound-dial" && /sip\.retellai\.com/.test(c.to ?? "") && when(c) >= since)
      .sort((a, b) => when(a) - when(b));
    // Same threshold the router's /sip-failed uses: a "completed" leg shorter than this collapsed.
    const minOk = Number(lookup(router.vars ?? {}, "SIP_MIN_OK_SECONDS")) || 5;
    const bad = (c) => c.status !== "completed" || Number(c.duration) < minOk;
    const nBad = legs.filter(bad).length;
    let rescueNote = "";
    if (router.svcSid) {
      const logs = await json(`https://serverless.twilio.com/v1/Services/${router.svcSid}/Environments/${router.envSid}/Logs?PageSize=100`, { headers: twBasic });
      const rescues = (logs.body?.logs ?? [])
        .filter((l) => /sip-failed → desk/.test(l.message ?? "") && new Date(l.date_created) >= since)
        .sort((a, b) => new Date(a.date_created) - new Date(b.date_created));
      const lastRescue = rescues.at(-1);
      if (lastRescue) rescueNote = `; last rescue ${lastRescue.date_created} ${lastRescue.message.match(/sip=\S+/)?.[0] ?? ""}`;
    }
    const summary = `${legs.length} leg(s): ok ${legs.length - nBad} / rescued ${nBad}${rescueNote}`;
    const last = legs.at(-1);
    if (!last) check(24, true, `${label} (no SIP legs to Retell in the window — nothing to judge)`);
    else check(24, !bad(last), `${label} (${summary})`,
      `last leg ${last.sid} at ${last.start_time ?? last.date_created}: ${last.status}, ${last.duration ?? 0}s (${summary}). ` +
      "Configuration can be perfect and this still red: Retell accepted the INVITE and did not answer (5 Sep 2026, SIP 487 ×3). " +
      "Retry once; if it repeats, Retell support with the call ids — and run the ear battery as web calls meanwhile.");
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
  // router_targets: the live Variable for every DECLARED profile (template form), so switch-line
  // can skip a set-target that would write the value already there.
  const routerTargets = isRouter && router?.vars
    ? Object.fromEntries(Object.keys(routing.profiles ?? {}).map((slug) => [slug, lookup(router.vars, `TARGET_${slug.toUpperCase()}`)]))
    : null;
  console.log(JSON.stringify({ number, environment: declared.environment, routing_mode: routing.mode, holder: isRouter ? (router?.holder ?? null) : null, router_targets: routerTargets, results, failed: failed.length, skipped: skipped.length }, null, 2));
} else {
  console.log("");
  // Who answers, stated on every run — the one line a person about to dial actually needs.
  if (isRouter) console.log(`HOLDER: ${router?.holder || "(unset)"}${profile ? ` (${profile.retell === "untouched" ? "Retell never sees the call" : `Retell ${profile.retell}`})` : " — NOT A DECLARED PROFILE"}`);
  if (failed.length) console.log(`FAILED: ${failed.length} broken layer(s) — ${failed.map((f) => `[${f.id}]`).join(" ")}`);
  else console.log(`All checks passed${skipped.length ? ` (${skipped.length} skipped)` : ""}.`);
  if (skipped.length && !strict) console.log(`${skipped.length} layer(s) unverified — re-run with --strict to treat that as failure.`);
  // NUMBERS.md §6: "The number is configured, so it works" is the standing mistake. This
  // script proves configuration. Only a real call that lands in call_logs proves the line.
  if (!failed.length) console.log("Configuration is proven. Exercise the full call path only on staging; production gets read-back and monitoring.");
}

process.exit(failed.length || (strict && skipped.length) ? 1 : 0);
