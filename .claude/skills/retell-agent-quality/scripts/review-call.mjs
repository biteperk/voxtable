// review-call.mjs <call_id|latest>
// The per-call report: durations, disconnect semantics, latency, timed transcript
// with tool calls/results, media node, debug-log tail. Requires RETELL_API_KEY.
const KEY = process.env.RETELL_API_KEY;
let id = process.argv[2];
if (!KEY || !id) {
  console.error("usage: RETELL_API_KEY=… node review-call.mjs <call_id|latest>");
  process.exit(1);
}
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

if (id === "latest") {
  const list = await (await fetch("https://api.retellai.com/v2/list-calls", {
    method: "POST", headers: H, body: JSON.stringify({ sort_order: "descending", limit: 1 })
  })).json();
  id = list[0]?.call_id;
  if (!id) { console.error("no calls"); process.exit(1); }
}

const c = await (await fetch(`https://api.retellai.com/v2/get-call/${id}`, { headers: H })).json();
console.log(`${c.call_id} | ${new Date(c.start_timestamp).toString().slice(0, 24)}`);
console.log(`dur ${c.duration_ms}ms | disconnect: ${c.disconnection_reason} | from: ${c.from_number} | lk-ip: ${c.retell_llm_dynamic_variables?.["lk-real-ip"]}`);
for (const k of ["e2e", "llm", "tts"]) {
  const l = c.latency?.[k];
  if (l) console.log(`  ${k}: p50 ${Math.round(l.p50)} p90 ${Math.round(l.p90)} max ${Math.round(l.max)} (n=${l.num})`);
}
if (c.disconnection_reason === "user_hangup") console.log("  NB: user_hangup = BYE received; NOT proof the human hung up (see call-forensics.md)");

console.log("--- transcript (word-timed) ---");
let lastUserEnd = null;
for (const u of c.transcript_with_tool_calls ?? []) {
  if (u.role === "agent" || u.role === "user") {
    const s = u.words?.[0]?.start, e = u.words?.at(-1)?.end;
    const gap = u.role === "agent" && lastUserEnd != null && s != null ? ` [+${(s - lastUserEnd).toFixed(1)}s after user]` : "";
    console.log(`${s?.toFixed(1)}-${e?.toFixed(1)}s ${u.role.toUpperCase()}${gap}: ${u.content}`);
    if (u.role === "user" && e != null) lastUserEnd = e;
  }
  if (u.role === "tool_call_invocation") console.log(`  >> TOOL ${u.name} ${String(u.arguments ?? "").slice(0, 120)}`);
  if (u.role === "tool_call_result") console.log(`  << RESULT ${String(u.content).length} chars: ${String(u.content).slice(0, 150)}`);
}
if (c.public_log_url) console.log(`debug log: ${c.public_log_url}`);
