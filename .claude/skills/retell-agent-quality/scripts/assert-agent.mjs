// assert-agent.mjs <agent_id> <llm_id>
// The definition-of-done machine checks. Exits non-zero on any violation.
// Requires RETELL_API_KEY; optional VOXTABLE_API to assert environment hostnames,
// optional VENUE_NAMES (comma-separated) to extend the de-venue grep.
const KEY = process.env.RETELL_API_KEY;
const [agentId, llmId] = process.argv.slice(2);
if (!KEY || !agentId || !llmId) {
  console.error("usage: RETELL_API_KEY=… node assert-agent.mjs <agent_id> <llm_id>");
  process.exit(1);
}
const H = { Authorization: `Bearer ${KEY}` };
const agent = await (await fetch(`https://api.retellai.com/get-agent/${agentId}`, { headers: H })).json();
const llm = await (await fetch(`https://api.retellai.com/get-retell-llm/${llmId}`, { headers: H })).json();

const failures = [];
const check = (ok, label) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) failures.push(label); };

// De-venued prose: known venue names + any extras via VENUE_NAMES.
const names = ["mazcina", "natalia", ...(process.env.VENUE_NAMES ?? "").toLowerCase().split(",").filter(Boolean)];
const prose = `${llm.general_prompt}\n${llm.begin_message ?? ""}`.toLowerCase();
check(!names.some((n) => prose.includes(n)), "prompt + greeting are de-venued (no venue names in prose)");

const functional = (llm.general_tools ?? []).filter((t) => t.type === "custom");
check(functional.length > 0 && functional.every((t) => t.speak_during_execution === true && t.speak_after_execution === true),
  "every functional tool has speak_during + speak_after = true");
check(Object.keys(llm.default_dynamic_variables ?? {}).length === 0, "default_dynamic_variables is empty {}");

// Golden knobs (see SKILL.md table).
check(agent.stt_mode === "fast", "stt_mode = fast");
check(agent.enable_expressive_mode !== true, "expressive mode off (costs ~1s/turn)");
check(agent.interruption_sensitivity === 0.6, "interruption_sensitivity = 0.6");
check(agent.ambient_sound == null, "no ambient_sound");
check(agent.enable_backchannel === true, "backchannel on");
check(agent.begin_message_delay_ms === 500, "begin_message_delay_ms = 500");
check(agent.data_storage_retention_days === 30, "30-day retention");
check(llm.model === "gpt-4.1", "model = gpt-4.1");

// Environment hostname assertions.
const urls = [agent.webhook_url, ...functional.map((t) => t.url)].filter(Boolean).join(" ");
if (process.env.VOXTABLE_API) {
  const host = new URL(process.env.VOXTABLE_API).host;
  check(urls.split(" ").every((u) => u.includes(host)), `every webhook/tool URL points at ${host}`);
}
check(!/vocotable\.algorythmos/.test(urls) || !!process.env.ALLOW_LEGACY_HOST, "no legacy Algorythmos hostname in URLs");

// Prompt structural invariants.
for (const marker of ["## Sound human", "Open or closed?", "be honest, never fake it", "{{venue_faq}}", "{{today_status}}", "end_call"]) {
  check(llm.general_prompt.includes(marker), `prompt carries "${marker}"`);
}

console.log(failures.length ? `\nFAILED: ${failures.length} violation(s)` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
