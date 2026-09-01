// latency-report.mjs [n=10]
// e2e/llm/tts percentiles across the last n phone calls, flagging the
// fixed-duration dead-call signature. Requires RETELL_API_KEY.
const KEY = process.env.RETELL_API_KEY;
if (!KEY) { console.error("RETELL_API_KEY not set"); process.exit(1); }
const n = Number(process.argv[2] ?? 10);

const calls = await (await fetch("https://api.retellai.com/v2/list-calls", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ sort_order: "descending", limit: n })
})).json();

const durations = [];
console.log("time     | dur_ms  | disconnect    | e2e p50 | e2e p90 | llm p50 | tts p50 | flag");
for (const c of calls) {
  if (c.call_type && c.call_type !== "phone_call") continue;
  durations.push(c.duration_ms ?? 0);
  const t = new Date(c.start_timestamp).toTimeString().slice(0, 8);
  const l = (k, p) => (c.latency?.[k]?.[p] != null ? String(Math.round(c.latency[k][p])).padStart(7) : "      -");
  // The signature is a TIGHT band (7,593-8,532 ms observed), not merely "short".
  // Flagging every short user_hangup produced false positives — an 11.3 s call was
  // marked as the fault when it is plainly outside the band. Match the band only.
  const ms = c.duration_ms ?? 0;
  const dead = ms >= 7000 && ms <= 8600 && c.disconnection_reason === "user_hangup";
  console.log(`${t} | ${String(c.duration_ms).padStart(7)} | ${String(c.disconnection_reason).padEnd(13)} |${l("e2e","p50")} |${l("e2e","p90")} |${l("llm","p50")} |${l("tts","p50")} | ${dead ? "DEAD?" : ""}`);
}
const shorts = durations.filter((d) => d > 0 && d < 15000);
if (shorts.length >= 2 && Math.max(...shorts) - Math.min(...shorts) < 1500) {
  console.log(`\n⚠️ ${shorts.length} short calls within a ${Math.max(...shorts) - Math.min(...shorts)}ms band — fixed-duration drop signature. See references/call-forensics.md and deploy/runbooks/incident-7600ms-call-drops.md.`);
}
console.log("\nGate: e2e p50 ≤ 1700ms on healthy calls.");

// Judge agent quality on healthy calls ONLY. A sub-15s drop is the telephony
// incident, not Bella — and on 27 Aug 2026, 21 of 58 calls ever placed were
// drops, so a blended average was reporting a broken LINE as a bad AGENT.
const healthy = calls.filter(
  (c) => (!c.call_type || c.call_type === "phone_call") && (c.duration_ms ?? 0) >= 15000
);
const p50s = healthy.map((c) => c.latency?.e2e?.p50).filter((x) => x != null).sort((a, b) => a - b);
console.log(`\nHealthy calls (>15s): ${healthy.length} of ${durations.length}. Drops excluded: ${shorts.length}.`);
if (p50s.length) {
  const med = Math.round(p50s[Math.floor(p50s.length / 2)]);
  console.log(`e2e p50 across healthy calls: median ${med}ms, best ${Math.round(p50s[0])}ms — ${med <= 1700 ? "PASS" : "OVER GATE"}`);
} else {
  console.log("No healthy calls in this window — nothing to judge the agent on.");
}
console.log("\nGate: e2e p50 ≤ 1700ms on healthy calls.");
console.log("For WHERE the time goes rather than how much, run turn-latency.mjs.");
