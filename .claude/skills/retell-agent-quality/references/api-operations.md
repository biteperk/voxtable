# API operations — keys, endpoints, snapshots, probes, gotchas

## Keys — never in files, always from Secret Manager / env

| Environment | Retell key | Where |
|---|---|---|
| Staging (Staging workspace) | `voxtable-stg-retell-api-key` | GCP Secret Manager, project `bp-voxtable-stg` — `gcloud secrets versions access latest --secret voxtable-stg-retell-api-key --project bp-voxtable-stg` |
| Production (Biteperk workspace) | `voxtable-prod-retell-api-key` | GCP Secret Manager, project `bp-voxtable-prod` — one key per environment |

The workspace's single API key doubles as its webhook secret (badged "Webhook key") — both
env values take the same string. Twilio-side keys (incl. the AU1 regional pair) are in
`call-forensics.md`.

## Endpoints used in anger

| Op | Endpoint |
|---|---|
| Read/patch the LLM (prompt, tools, greeting) | `GET/PATCH https://api.retellai.com/get-retell-llm/{id}` / `update-retell-llm/{id}` |
| Read/patch the agent (voice, audio, latency knobs) | `GET/PATCH …/get-agent/{id}` / `update-agent/{id}` |
| Create for a new venue | `POST …/create-retell-llm`, `POST …/create-agent` |
| Calls | `POST …/v2/list-calls` (filterable), `GET …/v2/get-call/{id}` |
| Numbers | `GET …/list-phone-numbers` |
| Capacity | `GET …/get-concurrency` |

## The change discipline (applies to every PATCH, even one-liners)

1. Fresh **pre-snapshot**: `scripts/snapshot.sh <agent_id> <llm_id> deploy/retell-snapshots/<date>-<reason>-pre` —
   never trust an older snapshot; the dashboard may have drifted (Sam auditions voices there).
2. PATCH.
3. **Read back and assert** — check the exact fields you set AND the invariants you didn't
   (speak flags, `default_dynamic_variables: {}`, voice, sensitivity). Never trust the write
   response; a 200 with silently-dropped fields has happened.
4. Post-snapshot + a README saying what changed, why, the measured evidence, and the
   rollback line ("re-apply the pre snapshot: one PATCH per object"). Commit.
5. A staging test call and ear battery. Production changes receive only configuration
   read-back and monitoring of the next genuine customer call.

## Signed probes (exercise the production-grade signature path, no phone needed)

```js
import { Retell } from "retell-sdk";
const body = JSON.stringify({ event: "call_inbound", call_inbound: { from_number: "+61400000000", to_number: "<the DID>" } });
const sig = await Retell.sign(body, KEY);           // KEY = the workspace API key
await fetch(API + "/retell/inbound", { method: "POST",
  headers: { "content-type": "application/json", "x-retell-signature": sig }, body });
```
Same shape for tools: `{ name: "menu_lookup", call: { call_id: "probe", to_number: "<DID>" }, args: {…} }`
to `/retell/tools/menu-lookup` etc. `scripts/probe-inbound.mjs` wraps the inbound one with
assertions. Signed probes are also how `smoke:retell-signed` proves the machine half.

## Retell gotchas (each cost real time)

- **Tool descriptions cap at 1024 chars** — the PATCH 400s ("Tool description too long") and nothing hints which tool. Trim before appending contract lines (hit 30 Aug 2026 adding the available_now contract to menu_lookup).
- **PATCH updates in place** — the version number does not bump; don't use version to detect
  your own change, use read-back.
- **A missing dynamic variable renders literally** (`{{today_status}}` spoken aloud as
  "curly curly today underscore status"). Backend serves the variable FIRST (deploy +
  probe), prompt references it SECOND.
- **The dashboard draft hazard**: dashboard edits open a draft; publishing a stale draft
  erases every API change since. Audition in the dashboard, discard the draft, apply via API.
- **API-created agents inherit nothing** — set `webhook_url`, all knobs, all tool fields
  explicitly on create.
- **Unpublished drafts still serve in webhook mode** (staging runs this way, proven 13 Aug);
  production should publish anyway (see promotion recipe).
- Missing-variable + `default_dynamic_variables` interplay: keep defaults `{}` so a webhook
  failure yields a hard failure you can see, not a stale greeting that "works".
- The permission classifier in agent sessions may block paid/mutating vendor calls (placing
  calls, trunk writes) — hand those to Sam as a one-click `bash` block instead of retrying.

## scripts/ usage

```bash
S=.claude/skills/retell-agent-quality/scripts
export RETELL_API_KEY=$(gcloud secrets versions access latest --secret voxtable-stg-retell-api-key --project bp-voxtable-stg)
export VOXTABLE_API=https://voxtable-stg-api-naed3dbhna-ts.a.run.app   # or the prod host

$S/snapshot.sh agent_7b67073710604d306443cc569c llm_c1d40dbe180e737dd2ce1309ed3f /tmp/pre
node $S/probe-inbound.mjs +61468203234
node $S/review-call.mjs latest          # or a call_id
node $S/latency-report.mjs 10
node $S/assert-agent.mjs agent_7b67073710604d306443cc569c llm_c1d40dbe180e737dd2ce1309ed3f
```
All read-only; `assert-agent.mjs` exits non-zero on any definition-of-done violation, so it
can gate CI later.
