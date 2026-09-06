// switch-line.mjs <+E164> --to <profile> [--apply] [--take] [--config path]
//
// Switch a ROUTER-mode voice line (deploy/voice-lines.json routing.mode = "router") to one of its
// declared profiles, across every layer that has to agree, in a fixed order, and prove it afterwards.
//
// Why it exists: on 5 Sep 2026 the staging number was lent to another project by hand and
// reconnected by hand — Retell rebound in the dashboard, the router variable set from another repo,
// nothing recorded anywhere — and the next person found the line dead by dialling it. Switching is
// a legitimate, frequent operation on a shared test number, so it gets one command that cannot
// leave the layers disagreeing, and cannot claim success without a read-back.
//
// Order:
//   0. pre-flight  — assert-line in report mode; print the current holder; refuse anything undeclared
//   1. Twilio      — voxstay's twilio-route.py (their rule: routing changes go through that CLI only)
//   2. Retell      — the number's inbound mode for the target profile (snapshot, PATCH, read back)
//   3. database    — untouched; the restaurants row stays bound so switching back is Retell+router only
//   4. record      — one line in deploy/voice-line-switches.log, then assert-line --strict --expect
//
// Dry-run by default. Staging only: refuses any line declared production.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCredentials } from "./line-credentials.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const take = args.includes("--take");
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const configPath = at("--config") ?? "deploy/voice-lines.json";
const number = args.find((a) => a.startsWith("+"));
const to = at("--to");
const usage = "usage: node switch-line.mjs <+E164> --to <profile> [--apply] [--take]";
if (!number || !to) { console.error(usage); process.exit(2); }

const declared = JSON.parse(readFileSync(configPath, "utf8")).lines?.[number];
if (!declared) { console.error(`${number} is not declared in ${configPath}.`); process.exit(2); }
if (declared.environment === "production") {
  console.error("Refusing: this line is declared production. Production lines are not switched; they are bound once through the admin API.");
  process.exit(2);
}
const routing = declared.routing;
if (routing?.mode !== "router") {
  console.error(`Refusing: ${number} is not a router-mode line (routing.mode=${routing?.mode ?? "trunk"}). Trunk lines are repaired with apply-line.mjs.`);
  process.exit(2);
}
const profile = routing.profiles?.[to];
if (!profile) {
  console.error(`Refusing: profile "${to}" is not declared for ${number}. Declared: ${Object.keys(routing.profiles ?? {}).join(", ")}.`);
  console.error("Declare it in deploy/voice-lines.json first — a switch to an undeclared target is exactly the unrecorded change this tool exists to prevent.");
  process.exit(2);
}
if (profile.retell === "static" && !profile.retell_agent_id) {
  console.error(`Refusing: profile "${to}" is retell:"static" but declares no retell_agent_id.`);
  process.exit(2);
}

// The Twilio layer belongs to voxstay's CLI. Never fall back to POSTing the number ourselves:
// that repo's rule is that every routing change goes through twilio-route.py, and a second writer
// is how drift starts.
const voxstayRepo = process.env.VOXSTAY_REPO ?? join(process.env.HOME ?? "", "voxstay");
const routeCli = join(voxstayRepo, "scripts", "twilio-route.py");
if (!existsSync(routeCli)) {
  console.error(`Refusing: ${routeCli} not found. Set VOXSTAY_REPO to the voxstay checkout; the Twilio layer is only ever changed through that CLI.`);
  process.exit(2);
}

let KEY;
try { KEY = resolveCredentials(declared).apiKey; }
catch (error) { console.error(`Could not load Retell credentials for ${number}: ${error.message}`); process.exit(2); }
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const json = async (url, init) => {
  const res = await fetch(url, init);
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
};
const here = (f) => new URL(`./${f}`, import.meta.url).pathname;
const say = (s) => console.log(s);

say(`\n${number} — switch to "${to}" (${profile.retell}, target ${profile.router_target})`);
say(apply ? "MODE: apply (writes will happen)\n" : "MODE: dry run — nothing will be written. Re-run with --apply.\n");

// ─── 0. Pre-flight ────────────────────────────────────────────────────────────
// Rule 8: prove the key sees the declared agent before believing anything else it says.
const agent = await json(`https://api.retellai.com/get-agent/${declared.retell_agent_id}`, { headers: { Authorization: H.Authorization } });
if (agent.status !== 200) {
  console.error(`✗ this key cannot see ${declared.retell_agent_id} (${agent.status}) — wrong workspace, or the agent is gone. Stopping before touching anything.`);
  process.exit(1);
}
const pre = spawnSync(process.execPath, [here("assert-line.mjs"), number, "--config", configPath, "--json"], { encoding: "utf8", env: process.env });
let preReport = null;
try { preReport = JSON.parse(pre.stdout); } catch {}
const holder = preReport?.holder ?? "(unreadable)";
say(`current holder: ${holder}`);
if (!preReport) { console.error("✗ pre-flight assert-line produced no report:\n" + (pre.stderr || pre.stdout)); process.exit(1); }
const preFails = preReport.results.filter((r) => r.state === "fail").map((r) => `[${r.id}]`);
if (preFails.length) say(`⚠ pre-flight has failing checks ${preFails.join(" ")} — the switch will proceed and the post-check decides.`);
if (holder !== to && !take) {
  say(`note: "${holder}" currently holds the number. If voxstay's collision guard refuses the switch, re-run with --take after confirming with whoever holds it.`);
}

// ─── 1. Twilio layer via voxstay's CLI ────────────────────────────────────────
const cli = (cmdArgs) => {
  say(`→ voxstay: twilio-route.py ${cmdArgs.join(" ")}`);
  if (!apply) return { status: 0, stdout: "(dry run)" };
  const r = spawnSync("python3", [routeCli, ...cmdArgs], { encoding: "utf8", cwd: voxstayRepo, env: process.env });
  process.stdout.write((r.stdout ?? "") + (r.stderr ?? ""));
  return r;
};
const changes = [];
if (holder === to) {
  say(`✓ router already routes ${number} to ${to}`);
} else {
  // Write the target only when the live Variable differs from the declaration. The CLI's
  // health-check probes voxstay's LOCAL orchestrator for its own host, which is not running on a
  // VoxTable laptop and is not this repo's concern — so when a write is needed it passes
  // --no-preflight, and the post-check below is what proves the target. (A dead voxstay target
  // is voxstay's to notice: their `status` warns on it.)
  const liveTarget = preReport.router_targets?.[to];
  if (liveTarget === profile.router_target) {
    say(`✓ TARGET_${to.toUpperCase()} already equals the declared target`);
  } else {
    const r0 = cli(["set-target", to, profile.router_target, "--number", number, "--no-preflight"]);
    if (r0.status !== 0) { console.error("✗ set-target failed"); process.exit(1); }
  }
  let r;
  const setArgs = ["set", to, "--number", number];
  if (take) setArgs.push("--force");
  r = cli(setArgs);
  if (r.status !== 0) {
    // The CLI writes ACTIVE_APP first and the claim stamp second, so a failure here can leave the
    // router already switched. Say where the number actually is before giving up — a "failed"
    // switch that silently succeeded is the unrecorded change this tool exists to prevent.
    console.error("✗ set failed. If the CLI said the number is LENT to another app, re-run with --take after confirming with whoever holds it.");
    const now = spawnSync(process.execPath, [here("assert-line.mjs"), number, "--config", configPath, "--json"], { encoding: "utf8", env: process.env });
    let nowHolder = "(unreadable)";
    try { nowHolder = JSON.parse(now.stdout).holder ?? "(unset)"; } catch {}
    console.error(`  live holder right now: ${nowHolder}`);
    if (nowHolder === to) console.error(`  The router DID switch to ${to} before the CLI failed. Re-run this command: it will skip the router and finish the remaining layers.`);
    process.exit(1);
  }
  changes.push(`router → ${to}`);
}

// ─── 2. Retell layer ──────────────────────────────────────────────────────────
const num = await json(`https://api.retellai.com/get-phone-number/${number}`, { headers: { Authorization: H.Authorization } });
if (num.status !== 200) {
  console.error(`✗ get-phone-number returned ${num.status}. The number is not in this workspace — that is a repair (apply-line.mjs / rule 7), not a switch.`);
  process.exit(1);
}
const wantWebhook = `${declared.api_base}/retell/inbound`;
const liveAgents = num.body.inbound_agents ?? [];
let patch = null;
if (profile.retell === "webhook") {
  if (num.body.inbound_webhook_url !== wantWebhook || liveAgents.length) patch = { inbound_webhook_url: wantWebhook, inbound_agents: [] };
} else if (profile.retell === "static") {
  const pinned = liveAgents.length === 1 && liveAgents[0].agent_id === profile.retell_agent_id;
  if (!pinned || num.body.inbound_webhook_url) patch = { inbound_webhook_url: null, inbound_agents: [{ agent_id: profile.retell_agent_id, weight: 1 }] };
} // "untouched": Retell never sees the call; leave the number exactly as it is.

if (!patch) {
  say(`✓ Retell number already in the "${profile.retell}" shape for ${to}`);
} else {
  say(`→ Retell PATCH update-phone-number: ${JSON.stringify(patch)}`);
  if (apply) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const snapDir = `deploy/retell-snapshots/${stamp}-${declared.environment}-switch-line-${to}`;
    if (!existsSync(`${snapDir}-pre`)) {
      mkdirSync(`${snapDir}-pre`, { recursive: true });
      const s = spawnSync(here("snapshot.sh"), [declared.retell_agent_id, declared.retell_llm_id, `${snapDir}-pre`],
        { encoding: "utf8", env: { ...process.env, RETELL_API_KEY: KEY } });
      if (s.status !== 0) { console.error("✗ snapshot failed — refusing to write without a rollback point.\n" + s.stderr); process.exit(1); }
      say(`  snapshot: ${snapDir}-pre (number object before: ${JSON.stringify({ inbound_webhook_url: num.body.inbound_webhook_url, inbound_agents: liveAgents })})`);
    }
    const res = await json(`https://api.retellai.com/update-phone-number/${number}`, { method: "PATCH", headers: H, body: JSON.stringify(patch) });
    if (res.status >= 300) { console.error(`✗ PATCH failed ${res.status}: ${JSON.stringify(res.body)}`); process.exit(1); }
    // Never trust the write response — read it back (CLAUDE.md §D rule 5).
    const back = await json(`https://api.retellai.com/get-phone-number/${number}`, { headers: { Authorization: H.Authorization } });
    const backAgents = back.body?.inbound_agents ?? [];
    const ok = profile.retell === "webhook"
      ? back.body?.inbound_webhook_url === wantWebhook && backAgents.length === 0
      : !back.body?.inbound_webhook_url && backAgents.length === 1 && backAgents[0].agent_id === profile.retell_agent_id;
    say(`  read-back: ${JSON.stringify({ inbound_webhook_url: back.body?.inbound_webhook_url ?? null, inbound_agents: backAgents })}`);
    if (!ok) { console.error("✗ READ-BACK MISMATCH — the write did not stick."); process.exit(1); }
    say("  ✓ read back and confirmed");
    changes.push(`retell → ${profile.retell}`);
  }
}

// ─── 3. Database — untouched by design ────────────────────────────────────────
say("database: untouched (the restaurants row stays bound; a different VENUE agent goes through the admin provisioning PATCH, never this tool)");

// ─── 4. Record and prove ──────────────────────────────────────────────────────
if (apply) {
  const who = process.env.USER ?? process.env.LOGNAME ?? "unknown";
  const line = `${new Date().toISOString()} ${who} ${number} ${holder} -> ${to} [${changes.join("; ") || "no change"}]\n`;
  appendFileSync("deploy/voice-line-switches.log", line);
  say(`\nrecorded: deploy/voice-line-switches.log ← ${line.trim()}`);
  say("\npost-check:");
  const post = spawnSync(process.execPath, [here("assert-line.mjs"), number, "--config", configPath, "--strict", "--expect", to], { encoding: "utf8", env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  if (post.status !== 0) { console.error(`\n✗ post-check failed — the line is NOT proven to reach ${to}.`); process.exit(1); }
  say(`\n✓ ${number} now reaches ${to}, proven by read-back.`);
} else {
  say(`\nDry run complete. Would change: ${changes.length ? changes.join(", ") : "nothing"}${patch ? ", retell number" : ""}.`);
}
