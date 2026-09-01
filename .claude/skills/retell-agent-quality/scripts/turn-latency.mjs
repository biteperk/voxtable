// turn-latency.mjs [n=100]
// Decomposes turn latency instead of reporting one blended number.
//
// Why this exists: latency-report.mjs gives e2e p50 per call, which blends three
// very different things and hides the dominant term. On 27 Aug 2026 a blended
// 2475ms was being chased by tuning voice knobs; this split showed the cost was
// ~600ms of endpointing on EVERY turn plus a second LLM round trip on every
// TOOL turn — and that our own API was 67ms and never the problem.
//
// Calls shorter than 15s are excluded: those are the ~7.6s telephony drops
// (deploy/runbooks/incident-7600ms-call-drops.md), not agent behaviour. Judging
// agent quality on them measures a broken line.
const KEY = process.env.RETELL_API_KEY;
if (!KEY) { console.error("RETELL_API_KEY not set"); process.exit(1); }
const n = Number(process.argv[2] ?? 100);

const calls = await (await fetch("https://api.retellai.com/v2/list-calls", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ sort_order: "descending", limit: n })
})).json();

const plain = [], tooled = [];
const llm = [], tts = [];
let healthy = 0, dropped = 0;

for (const c of calls) {
  if (c.call_type && c.call_type !== "phone_call") continue;
  if ((c.duration_ms ?? 0) < 15000) { dropped++; continue; }
  healthy++;
  if (c.latency?.llm?.p50 != null) llm.push(c.latency.llm.p50);
  if (c.latency?.tts?.p50 != null) tts.push(c.latency.tts.p50);

  let lastUserEnd = null, sawTool = false;
  for (const u of c.transcript_with_tool_calls ?? []) {
    if (u.role === "user") { lastUserEnd = u.words?.at(-1)?.end ?? lastUserEnd; sawTool = false; continue; }
    if (u.role === "tool_call_invocation") { sawTool = true; continue; }
    if (u.role === "agent" && lastUserEnd != null) {
      const s = u.words?.[0]?.start;
      // Guard against barge-in: a negative gap means the agent was already talking.
      if (s != null && s > lastUserEnd) {
        const gap = s - lastUserEnd;
        if (gap > 0 && gap < 30) (sawTool ? tooled : plain).push(gap);
      }
      lastUserEnd = null; sawTool = false;
    }
  }
}

const q = (a, p) => (a.length ? a[Math.floor(a.length * p)] : null);
const secs = (a, label) => {
  a.sort((x, y) => x - y);
  const f = p => (a.length ? `${q(a, p).toFixed(2)}s` : "-");
  console.log(`  ${label.padEnd(30)} n=${String(a.length).padStart(3)}  p50=${f(0.5).padStart(6)}  p90=${f(0.9).padStart(6)}`);
};

console.log(`Turn-latency decomposition — ${healthy} healthy calls (${dropped} sub-15s drops excluded)\n`);
secs(plain, "turn WITHOUT a tool call");
secs(tooled, "turn WITH a tool call");

llm.sort((a, b) => a - b); tts.sort((a, b) => a - b);
const L = q(llm, 0.5), T = q(tts, 0.5), P = q(plain, 0.5), X = q(tooled, 0.5);
if (L != null && T != null && P != null) {
  console.log(`\n  Retell-reported: llm p50 ${Math.round(L)}ms | tts p50 ${Math.round(T)}ms`);
  console.log(`  => endpointing  ~${Math.round(P * 1000 - L - T)}ms, paid on EVERY turn`);
  if (X != null) console.log(`  => tool overhead ~${Math.round((X - P) * 1000)}ms, paid on every TOOL turn`);
  console.log(`\n  Our own API is NOT in the numbers above. Read it from Cloud Run:`);
  console.log(`    gcloud logging read 'resource.labels.service_name="voxtable-stg-api" AND jsonPayload.evt="http_request" AND jsonPayload.path=~"/retell/tools/"' \\`);
  console.log(`      --project=bp-voxtable-stg --limit=1000 --freshness=14d \\`);
  console.log(`      --format='value(jsonPayload.path,jsonPayload.durationMs)'`);
  console.log(`  Measured 27 Aug 2026: p50 67ms across n=180. The backend has never been the bottleneck.`);
}
console.log(`\nGate: e2e p50 <= 1700ms on healthy calls. Tool turns are the expensive ones —`);
console.log(`removing a tool call is worth more than any voice knob.`);
