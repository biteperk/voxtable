// apply-line.mjs <+E164> [--apply] [--config path]
//
// Idempotent reconcile of a voice line's LIVE state to its DECLARED state in
// deploy/voice-lines.json. Dry-run by default; --apply performs the writes.
//
// This is the repair, and it is meant to stay. Every previous recovery of this line was
// fresh archaeology across two vendor consoles and an SSH session, which is why the same
// break kept coming back wearing different clothes. Running this twice is a no-op.
//
// Order is deliberate:
//   1. agent   — the name must be right before anything binds to it (the bind guard reads it)
//   2. database — so the first call after the import already resolves
//   3. number   — the import is the last step, and the one with no undo (NUMBERS.md §7)
//
// Env: RETELL_API_KEY (required), RETELL_WEBHOOK_SECRET (for the post-check probe).
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const configIdx = args.indexOf("--config");
const configPath = configIdx >= 0 ? args[configIdx + 1] : "deploy/voice-lines.json";
const number = args.find((a) => a.startsWith("+"));
if (!number) { console.error("usage: RETELL_API_KEY=… node apply-line.mjs <+E164> [--apply]"); process.exit(2); }

const KEY = process.env.RETELL_API_KEY;
if (!KEY) { console.error("RETELL_API_KEY not set"); process.exit(2); }
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const d = JSON.parse(readFileSync(configPath, "utf8")).lines?.[number];
if (!d) { console.error(`${number} is not declared in ${configPath}.`); process.exit(2); }

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const snapDir = `deploy/retell-snapshots/${stamp}-${d.environment}-apply-line`;
const changes = [];
const say = (s) => console.log(s);

const json = async (url, init) => {
  const res = await fetch(url, init);
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
};
// Deep, key-order-insensitive compare. Retell returns object keys in its own order
// (pronunciation entries come back {phoneme, alphabet, word}), so a raw JSON.stringify
// compare reports a mismatch on identical data — which both cries wolf on the read-back
// AND re-patches on every run, destroying idempotence.
const canon = (v) => Array.isArray(v)
  ? v.map(canon)
  : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

say(`\n${number} — reconciling ${d.environment} to ${configPath}`);
say(apply ? "MODE: apply (writes will happen)\n" : "MODE: dry run — nothing will be written. Re-run with --apply.\n");

// ─── 0. Snapshot before touching anything ─────────────────────────────────────
if (apply) {
  mkdirSync(`${snapDir}-pre`, { recursive: true });
  const r = spawnSync(new URL("./snapshot.sh", import.meta.url).pathname,
    [d.retell_agent_id, d.retell_llm_id, `${snapDir}-pre`], { encoding: "utf8", env: process.env });
  if (r.status !== 0) { console.error("snapshot failed — refusing to write without a rollback point.\n", r.stderr); process.exit(1); }
  say(`snapshot: ${snapDir}-pre\n`);
}

// ─── 1. Agent: name, pronunciation, boosted keywords ──────────────────────────
const agent = await json(`https://api.retellai.com/get-agent/${d.retell_agent_id}`, { headers: { Authorization: H.Authorization } });
if (agent.status !== 200) {
  console.error(`✗ declared agent ${d.retell_agent_id} does not exist (${agent.status}). Nothing here can fix that — build the agent first.`);
  process.exit(1);
}

const patch = {};
if (agent.body.agent_name !== d.retell_agent_name) patch.agent_name = d.retell_agent_name;
if (d.pronunciation_dictionary && !eq(agent.body.pronunciation_dictionary, d.pronunciation_dictionary)) {
  patch.pronunciation_dictionary = d.pronunciation_dictionary;
}
const wantKw = d.required_boosted_keywords ?? [];
const haveKw = agent.body.boosted_keywords ?? [];
const missingKw = wantKw.filter((k) => !haveKw.includes(k));
// Append, never replace: the rest of the list is the venue's menu vocabulary and is not
// declared here. Overwriting it would silently cost the STT every dish name.
if (missingKw.length) patch.boosted_keywords = [...haveKw, ...missingKw];

if (Object.keys(patch).length === 0) {
  say("✓ agent already matches the declaration");
} else {
  for (const k of Object.keys(patch)) changes.push(`agent.${k}`);
  say(`→ agent PATCH: ${Object.keys(patch).join(", ")}`);
  if (patch.agent_name) say(`    agent_name: "${agent.body.agent_name}" → "${patch.agent_name}"`);
  if (patch.pronunciation_dictionary) say(`    pronunciation: ${JSON.stringify(agent.body.pronunciation_dictionary)} → ${JSON.stringify(patch.pronunciation_dictionary)}`);
  if (patch.boosted_keywords) say(`    boosted_keywords += ${JSON.stringify(missingKw)}`);
  if (apply) {
    const res = await json(`https://api.retellai.com/update-agent/${d.retell_agent_id}`,
      { method: "PATCH", headers: H, body: JSON.stringify(patch) });
    if (res.status >= 300) { console.error(`✗ agent PATCH failed ${res.status}: ${JSON.stringify(res.body)}`); process.exit(1); }
    // Never trust the write response (CLAUDE.md §D rule 5) — read it back.
    const back = await json(`https://api.retellai.com/get-agent/${d.retell_agent_id}`, { headers: { Authorization: H.Authorization } });
    const ok = back.body.agent_name === d.retell_agent_name
      && (!d.pronunciation_dictionary || eq(back.body.pronunciation_dictionary, d.pronunciation_dictionary))
      && wantKw.every((k) => (back.body.boosted_keywords ?? []).includes(k));
    say(ok ? "  ✓ read back and confirmed" : "  ✗ READ-BACK MISMATCH — the write did not stick");
    if (!ok) process.exit(1);
  }
}

// ─── 2. Database row ──────────────────────────────────────────────────────────
// The one layer with no vendor API. Production is at migration 024, so the admin bind route
// (which verifies the agent before storing it) does not exist there — raw SQL is the only path,
// and it checks nothing. That is why assert-line runs immediately afterwards.
const sql = `UPDATE restaurants SET retell_agent_id = '${d.retell_agent_id}', twilio_phone_number = '${number}' `
  + `WHERE id = '${d.restaurant_id}' AND (retell_agent_id IS DISTINCT FROM '${d.retell_agent_id}' OR twilio_phone_number IS DISTINCT FROM '${number}');`;

if (d.db?.via === "vm-ssh") {
  say(`\n→ database (${d.db.instance}):\n    ${sql}`);
  if (apply) {
    const inner = `docker exec ${d.db.container} psql -U $(docker exec ${d.db.container} printenv POSTGRES_USER) `
      + `-d $(docker exec ${d.db.container} printenv POSTGRES_DB) -c "${sql.replace(/"/g, '\\"')}"`;
    const r = spawnSync("gcloud", ["compute", "ssh", d.db.instance, "--zone", d.db.zone,
      "--project", d.db.gcp_project, "--command", inner], { encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    say(`    ${out.split("\n").filter((l) => /UPDATE \d/.test(l)).join(" ") || out.slice(-200)}`);
    if (r.status !== 0) { console.error("✗ database update failed"); process.exit(1); }
    if (/UPDATE 1/.test(out)) changes.push("restaurants row");
    else say("    (already correct — no row changed)");
  }
} else {
  say(`\n⚠ database not reachable from here: ${d.db?.note ?? "no db access declared"}`);
}

// ─── 3. Retell number import ──────────────────────────────────────────────────
// Webhook-only, never inbound_agents: a static entry is a FALLBACK that answers with stale
// default_dynamic_variables when the webhook fails — the wrong venue's name and old dates.
// NUMBERS.md §6. Importing is also the one step with no clean undo, so it goes last.
const wantWebhook = `${d.api_base}/retell/inbound`;
const num = await json(`https://api.retellai.com/get-phone-number/${number}`, { headers: { Authorization: H.Authorization } });

if (num.status === 404) {
  say(`\n→ import number into the Retell workspace (webhook-only)`);
  say(`    inbound_webhook_url: ${wantWebhook}`);
  say(`    termination_uri:     ${d.termination_uri}  (required by the API, unused on an inbound-only number)`);
  if (apply) {
    const res = await json("https://api.retellai.com/import-phone-number", {
      method: "POST", headers: H,
      body: JSON.stringify({
        phone_number: number,
        termination_uri: d.termination_uri,
        inbound_webhook_url: wantWebhook
      })
    });
    if (res.status >= 300) {
      // "Phone number already exists" while get-phone-number 404s in THIS workspace is not a
      // contradiction: Retell scopes a number to exactly one workspace GLOBALLY, across every
      // account. So the number is held somewhere we cannot see, and importing it there silently
      // evicted it from here. This is the failure that kept reading as "the import vanished".
      if (/already exists/i.test(res.body?.message ?? "")) {
        console.error(`\n✗ Retell refuses the import: "${res.body.message}"`);
        console.error(`  But get-phone-number returned 404 for ${number} in this workspace.`);
        console.error("  Both are true: a number lives in exactly ONE Retell workspace, account-wide.");
        console.error(`  ${number} is therefore registered in a workspace this API key cannot see —`);
        console.error("  and whoever imported it there evicted it from here. Nothing on our side can");
        console.error("  route this number until it is released.\n");
        console.error("  To resolve (needs a human at the Retell dashboard):");
        console.error("   1. Sign in and check EVERY workspace on the account for this number.");
        console.error("   2. Also check the legacy Algorythmos workspace — a different login, a");
        console.error("      different company's account (NUMBERS.md §4).");
        console.error("   3. DELETE it there, then re-run this script. Deletion is one-way and a");
        console.error("      failed re-import means a 24–48h Retell support ticket (CLAUDE.md §D rule 7).");
        process.exit(1);
      }
      console.error(`✗ import failed ${res.status}: ${JSON.stringify(res.body)}`);
      process.exit(1);
    }
    const back = await json(`https://api.retellai.com/get-phone-number/${number}`, { headers: { Authorization: H.Authorization } });
    const ok = back.status === 200 && back.body.inbound_webhook_url === wantWebhook && !back.body.inbound_agents?.length;
    say(ok ? "  ✓ imported, webhook-only, read back and confirmed" : `  ✗ READ-BACK MISMATCH: ${JSON.stringify(back.body)}`);
    if (!ok) process.exit(1);
    changes.push("retell number import");
  }
} else if (num.status === 200) {
  const fixes = {};
  if (num.body.inbound_webhook_url !== wantWebhook) fixes.inbound_webhook_url = wantWebhook;
  if (d.inbound_mode === "webhook-only" && num.body.inbound_agents?.length) fixes.inbound_agents = [];
  if (Object.keys(fixes).length === 0) {
    say("\n✓ number already imported and pointing at the right place");
  } else {
    say(`\n→ number PATCH: ${Object.keys(fixes).join(", ")}`);
    if (apply) {
      const res = await json(`https://api.retellai.com/update-phone-number/${number}`,
        { method: "PATCH", headers: H, body: JSON.stringify(fixes) });
      if (res.status >= 300) { console.error(`✗ number PATCH failed ${res.status}: ${JSON.stringify(res.body)}`); process.exit(1); }
      changes.push("retell number config");
      say("  ✓ patched");
    }
  }
} else {
  console.error(`✗ get-phone-number returned ${num.status} — cannot tell what state the number is in; refusing to guess.`);
  process.exit(1);
}

// ─── 4. Post-snapshot and verdict ─────────────────────────────────────────────
if (apply && changes.length) {
  mkdirSync(`${snapDir}-post`, { recursive: true });
  spawnSync(new URL("./snapshot.sh", import.meta.url).pathname,
    [d.retell_agent_id, d.retell_llm_id, `${snapDir}-post`], { encoding: "utf8", env: process.env });
  say(`\nsnapshot: ${snapDir}-post`);
}

say(`\n${apply ? `Applied: ${changes.length ? changes.join(", ") : "nothing — already reconciled"}` : "Dry run complete."}`);
say(`Next: node ${new URL("./assert-line.mjs", import.meta.url).pathname.replace(process.cwd() + "/", "")} ${number} --strict`);
say("A README beside the snapshot may only claim what that read-back printed.");
