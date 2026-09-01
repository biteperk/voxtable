#!/usr/bin/env node
// run-sim-tests.mjs [--sync] [--case <name>] [--engine <llm_id|flow_id>]
//
// Runs the declared simulation suite (deploy/voice-tests/cases.json) against a
// Retell agent WITHOUT placing a phone call, and prints one pass/fail line per
// case plus the grader's explanation for every failure.
//
// Why this exists. Until 27 Aug 2026 the only way to verify a change was one
// human phone call. 58 calls had ever been placed; the latency gate had been met
// on three days; the same four complaints were re-reported in twelve sessions;
// and fourteen "verification still owed" items were never done. A loop that slow
// cannot converge, so the config drifted for a month. This is the loop.
//
//   --sync   create/update the case definitions on Retell from cases.json first.
//            Cases are matched by `name`, so editing cases.json and re-syncing
//            updates in place rather than duplicating.
//
// COST — this is not free, and it emptied the staging credit once already.
// A simulated run bills TWO models (the simulated caller AND the agent) plus one
// grading unit per case, at roughly $0.001-$0.05 per message. On 27 Aug 2026 a single
// fix-then-regrade session ran 50 case-runs of ~20 turns each — ~2,000 billed
// model-messages — and hit "402 Credit balance exhausted" mid-session.
//
// Two things keep it cheap:
//   1. Iterating on one defect? Use --case <name>. A full run costs 10x and tells you
//      nothing more about the one thing you just changed.
//   2. cases.json sets llm_model for the simulated caller. Keep it on a cheap tier —
//      it plays a customer ordering dinner, not the agent.
// The third multiplier is the agent's own prompt, re-sent every turn. At 15,580 chars
// that was ~3.9M input tokens in one session: prompt bloat bills twice, once in
// latency on every real call and once here.
//
// SAFETY — read before removing anything below.
// Retell's docs: "A tool call that matches no mock falls through to the real
// tool." Unmocked, a simulated caller WILL write a real booking and text a real
// payment link to whatever number it invents. This script therefore refuses to
// run unless every tool on the response engine has a mock in every case. That
// check is the reason this file is safe to run against the staging engine, and
// it must not be weakened into a warning.

const KEY = process.env.RETELL_API_KEY;
if (!KEY) { console.error("RETELL_API_KEY not set"); process.exit(1); }

const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const BASE = "https://api.retellai.com";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

// Retried on transport failures and 5xx only. A batch run polls for minutes, and a
// single dropped connection used to abandon a run that was still executing server-side.
// 4xx is NOT retried: that is a bad request and repeating it just hides the message.
const api = async (method, path, body, attempt = 1) => {
  let r;
  try {
    r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    if (attempt >= 4) throw new Error(`${method} ${path} -> ${err.message} (after ${attempt} attempts)`);
    await new Promise((res) => setTimeout(res, 2000 * attempt));
    return api(method, path, body, attempt + 1);
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (r.status >= 500 && attempt < 4) {
    await new Promise((res) => setTimeout(res, 2000 * attempt));
    return api(method, path, body, attempt + 1);
  }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 400)}`);
  return json;
};

const suite = JSON.parse(
  await (await import("node:fs/promises")).readFile(new URL("../../../../deploy/voice-tests/cases.json", import.meta.url), "utf8")
);

const engineId = opt("--engine") ?? suite.response_engine.llm_id;
const engine = { ...suite.response_engine, llm_id: engineId };

// ---------------------------------------------------------------- safety gate
// Enumerate the tools the live engine actually exposes, and require a mock for
// each in every case. Reading the engine (not cases.json) is deliberate: a tool
// added to the agent without a mock is exactly the accident this prevents.
const llm = await api("GET", `/get-retell-llm/${engineId}`);
const liveTools = (llm.general_tools ?? []).map((t) => t.name).filter(Boolean);
const NO_SIDE_EFFECT = new Set(["end_call"]); // terminates the sim; nothing to mock

let cases = suite.cases;
const only = opt("--case");
if (only) cases = cases.filter((c) => c.name === only);
if (!cases.length) { console.error(only ? `no case named ${only}` : "no cases"); process.exit(1); }

const gaps = [];
for (const c of cases) {
  const mocked = new Set((c.tool_mocks ?? []).map((m) => m.tool_name));
  for (const t of liveTools) {
    if (!NO_SIDE_EFFECT.has(t) && !mocked.has(t)) gaps.push(`${c.name}: no mock for "${t}"`);
  }
}
if (gaps.length) {
  console.error("REFUSING TO RUN — unmocked tools would hit the real API:\n  " + gaps.join("\n  "));
  console.error("\nRetell: \"A tool call that matches no mock falls through to the real tool.\"");
  console.error("Add a catch-all mock ({\"type\":\"any\"}) for each, then re-run.");
  process.exit(2);
}
console.log(`Safety gate: ${liveTools.length} live tools, all mocked in all ${cases.length} case(s). OK.\n`);

// ---------------------------------------------------------------------- sync
const existing = await api("GET", `/list-test-case-definitions?type=${engine.type}&llm_id=${engineId}`);
const byName = new Map((existing?.items ?? existing?.data ?? existing ?? []).map((d) => [d.name, d.test_case_definition_id]));

const ids = [];
for (const c of cases) {
  const payload = {
    name: c.name,
    response_engine: engine,
    user_prompt: c.user_prompt,
    metrics: c.metrics,
    dynamic_variables: { ...suite.dynamic_variables, ...(c.dynamic_variables ?? {}) },
    tool_mocks: c.tool_mocks ?? []
  };
  if (suite.llm_model) payload.llm_model = suite.llm_model;

  const found = byName.get(c.name);
  if (flag("--sync")) {
    const res = found
      ? await api("PUT", `/update-test-case-definition/${found}`, payload)
      : await api("POST", "/create-test-case-definition", payload);
    const id = res.test_case_definition_id ?? found;
    console.log(`  ${found ? "updated" : "created"}  ${c.name}`);
    ids.push(id);
  } else if (found) {
    ids.push(found);
  } else {
    console.error(`case "${c.name}" does not exist on Retell — run with --sync first`);
    process.exit(1);
  }
}
if (flag("--sync")) console.log();

// ----------------------------------------------------------------- run batch
const batch = await api("POST", "/create-batch-test", { test_case_definition_ids: ids, response_engine: engine });
const batchId = batch.test_case_batch_job_id;
console.log(`batch ${batchId} — ${ids.length} case(s) against ${engineId}\n`);

const started = Date.now();
let status = "pending";
while (status !== "complete") {
  await new Promise((r) => setTimeout(r, 5000));
  const b = await api("GET", `/get-batch-test/${batchId}`);
  status = b.status ?? "unknown";
  process.stdout.write(`\r  ${status} … ${Math.round((Date.now() - started) / 1000)}s   `);
  if (Date.now() - started > 15 * 60 * 1000) { console.error("\ntimed out after 15m"); process.exit(1); }
}
console.log("\n");

// ------------------------------------------------------------------- results
const runs = await api("GET", `/v2/list-test-runs/${batchId}`);
const list = runs?.items ?? runs?.data ?? runs ?? [];

let pass = 0, fail = 0;
const failures = [];
for (const r of list) {
  const name = r.test_case_definition_snapshot?.name ?? r.test_case_definition_id;
  const ok = r.status === "pass";
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : r.status === "error" ? "ERR " : "FAIL"}  ${name}`);
  if (!ok) failures.push({ name, why: r.result_explanation, id: r.test_case_job_id });
}

if (failures.length) {
  console.log("\n--- why each failure failed (the grader's words, not a summary) ---");
  for (const f of failures) console.log(`\n${f.name}\n  ${f.why ?? "(no explanation returned)"}\n  run: ${f.id}`);
}

console.log(`\n${pass} passed, ${fail} failed, ${list.length} total.`);
console.log("Audible defects — filler words, pacing, backchannel — are NOT covered here:");
console.log("backchannel audio never appears in transcripts. Use a Web Call for those.");
process.exit(fail ? 1 : 0);
