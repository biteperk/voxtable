// probe-inbound.mjs <to_number>
// Signed /retell/inbound probe: prints every dynamic variable and asserts the
// required set is present. Requires RETELL_API_KEY and VOXTABLE_API env vars.
import { Retell } from "retell-sdk";

const KEY = process.env.RETELL_API_KEY;
const API = process.env.VOXTABLE_API;
const to = process.argv[2];
if (!KEY || !API || !to) {
  console.error("usage: RETELL_API_KEY=… VOXTABLE_API=… node probe-inbound.mjs <to_number>");
  process.exit(1);
}

const body = JSON.stringify({ event: "call_inbound", call_inbound: { from_number: "+61400000000", to_number: to } });
const sig = await Retell.sign(body, KEY);
const t0 = Date.now();
const res = await fetch(`${API}/retell/inbound`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-retell-signature": sig },
  body
});
const json = await res.json();
const dv = json?.call_inbound?.dynamic_variables ?? {};
console.log(`status ${res.status} in ${Date.now() - t0}ms | override_agent_id: ${json?.call_inbound?.override_agent_id ?? "(NONE — no agent bound)"}`);
for (const [k, v] of Object.entries(dv)) console.log(`  ${k}: ${String(v).slice(0, 100)}`);

const required = ["restaurant_name", "owner_name", "venue_faq", "restaurant_timezone", "today", "tomorrow", "weekday_local", "today_status", "caller_phone"];
const missing = required.filter((k) => !(k in dv));
const literalAnon = dv.caller_phone === "anonymous";
if (res.status !== 200 || missing.length || literalAnon || !json?.call_inbound?.override_agent_id) {
  if (missing.length) console.error("MISSING variables:", missing.join(", "));
  if (literalAnon) console.error("caller_phone is the literal 'anonymous' — must be \"\"");
  process.exit(1);
}
console.log("PROBE OK");
