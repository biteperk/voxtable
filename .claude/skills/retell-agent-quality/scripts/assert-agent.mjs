// assert-agent.mjs <agent_id> <llm_id>
// The definition-of-done machine checks. Exits non-zero on any violation.
// Requires RETELL_API_KEY; optional VOXTABLE_API to assert environment hostnames,
// optional VENUE_NAMES (comma-separated) to extend the de-venue grep, and
// ALLOW_NO_DISCLOSURE=1 to skip the greeting-disclosure check (staging only).
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
// NUMBERS.md §6: defaults are the fallback when /retell/inbound fails, and nothing
// refreshes them — so they may only ever be VAGUE, never WRONG. Time-varying and
// caller-specific keys go stale into confidently-wrong answers; a single-venue agent's
// own identity cannot. Hard-fail the dangerous set, flag the rest.
const VOLATILE_DEFAULTS = ["today", "tomorrow", "weekday_local", "now_local", "caller_phone"];
const dv = llm.default_dynamic_variables ?? {};
const volatileLeak = VOLATILE_DEFAULTS.filter((k) => k in dv);
check(volatileLeak.length === 0, `default_dynamic_variables carries no volatile keys${volatileLeak.length ? ` (found: ${volatileLeak})` : ""}`);
if (Object.keys(dv).length > 0) {
  console.log(`  note: static defaults set (${Object.keys(dv).join(", ")}) — safe only while they match THIS agent's one venue; clear them if the agent is ever re-pointed.`);
}

// Golden knobs (see SKILL.md table).
check(agent.stt_mode === "fast", "stt_mode = fast");
check(agent.enable_expressive_mode !== true, "expressive mode off (costs ~1s/turn)");
// Raised 0.6 -> 0.8 on staging, 26 Aug 2026: on a real call she talked over the
// caller three times while he repeated "fish and chips". The old warning that
// 0.7 self-interrupts applied to a build WITH ambient_sound, removed long ago —
// that track was being transcribed as caller speech.
// Revert trigger: she cuts herself off mid-greeting with no caller audio.
//
// BOTH values pass until production is promoted. Pinning only the new one made
// this script fail production for the crime of not having been promoted yet,
// which turns an hourly check permanently red — and a check that is always red
// is one people learn to scroll past. Tighten to 0.8 alone on promotion day.
// The band, not a point: 0.6 is production (unpromoted), 0.8 stopped her talking
// over a caller, and 0.7 is being measured because 0.8 coincided with e2e p50
// rising from ~1.2s to ~2.5s. Pin a single value again once that is settled —
// until then a point check just fails whichever agent is not today's guess.
check(agent.interruption_sensitivity >= 0.6 && agent.interruption_sensitivity <= 0.8,
  `interruption_sensitivity is within the tuning band 0.6-0.8 — got ${agent.interruption_sensitivity}`);
check(agent.ambient_sound == null, "no ambient_sound");
check(agent.enable_backchannel === true, "backchannel on");
check(agent.begin_message_delay_ms === 500, "begin_message_delay_ms = 500");

// The AI + recording disclosure lives in the GREETING, and it is a legal gate: the owner
// warrants in the agreement ledger that Bella announces both on every call. This script
// reported ALL CHECKS PASSED on the production Mazcina agent while its greeting carried
// neither — because nothing here looked. A missing greeting is the same failure.
// Staging deliberately runs the short greeting (SKILL.md) — it opts out with
// ALLOW_NO_DISCLOSURE=1, which assert-line.mjs sets from the line's declared environment.
const greeting = String(llm.begin_message ?? "");
if (process.env.ALLOW_NO_DISCLOSURE === "1") {
  console.log("  note: disclosure check skipped (ALLOW_NO_DISCLOSURE=1 — staging only, never production)");
} else {
  check(/\bAI\b/i.test(greeting), "greeting discloses AI (\"an AI assistant\")");
  check(/record/i.test(greeting), "greeting discloses recording (\"this call's recorded\")");
}
check(agent.data_storage_retention_days === 30, "30-day retention");
check(llm.model === "gpt-4.1", "model = gpt-4.1");

// Environment hostname assertions.
const urls = [agent.webhook_url, ...functional.map((t) => t.url)].filter(Boolean).join(" ");
if (process.env.VOXTABLE_API) {
  const host = new URL(process.env.VOXTABLE_API).host;
  check(urls.split(" ").every((u) => u.includes(host)), `every webhook/tool URL points at ${host}`);
}
check(!/vocotable\.algorythmos/.test(urls) || !!process.env.ALLOW_LEGACY_HOST, "no legacy Algorythmos hostname in URLs");

// Prompt structural invariants — these hold on every backend.
for (const marker of ["## Sound human", "Open or closed?", "be honest, never fake it", "end_call", "{{restaurant_name}}"]) {
  check(llm.general_prompt.includes(marker), `prompt carries "${marker}"`);
}

// Venue facts and today's open/closed status: assert the CAPABILITY, not the mechanism.
// A backend that serves venue_faq/today_status supplies them per call; an older one cannot,
// and those agents carry a "This venue's details" section instead. Requiring the variables
// outright failed the production agent for being correctly adapted — a false alarm that
// would train people to ignore this script.
const venueSection = llm.general_prompt.includes("This venue's details");
check(llm.general_prompt.includes("{{venue_faq}}") || venueSection,
  "can answer venue questions (via {{venue_faq}} or a venue-details section)");
check(llm.general_prompt.includes("{{today_status}}") || venueSection,
  "can answer opening hours (via {{today_status}} or a venue-details section)");
if (venueSection && !llm.general_prompt.includes("{{venue_faq}}")) {
  console.log("  note: venue facts are in the PROMPT, not per-call data — this agent must never be cloned for another venue; delete the section once the backend serves venue_faq.");
}

console.log(failures.length ? `\nFAILED: ${failures.length} violation(s)` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
