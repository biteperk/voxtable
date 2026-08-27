# Cuban Corner Parramatta — production agent prepared for `+61485071140`

**27 Aug 2026.** Preparation only. **This agent answers no number yet** — the Twilio trunk
does not exist, the number is not imported to Retell, and `restaurants.twilio_phone_number`
is still NULL. Nothing here is customer-facing.

Everything below is what the read-back actually printed, not what was requested.

## What was changed, and why it was safe today

`agent_2892d65ceace4e68d8a3f3e80c` / `llm_53c6e9de9aac3b60270ffdd6bcba`, Biteperk
(production) workspace. All four faults were found by survey the same day, and all were
fixed **before** the agent is bound — the same edits after go-live would be changes to a
live venue line.

| Fault | Fix | Read-back |
|---|---|---|
| `webhook_url` + all five tool URLs on the legacy `vocotable.algorythmos.com.au` | rewritten to `https://api.biteperk.com.au` | ✅ confirmed |
| `speak_after_execution: false` on all five functional tools | `true` | ✅ confirmed |
| `speak_during_execution: true` on all five | `false` — golden config wants fillers only on `send_payment_link`, which this agent does not have (`assert-agent.mjs:45`) | ✅ confirmed |
| `boosted_keywords: null` | venue name + 12 menu terms | ✅ confirmed |

`speak_after_execution: false` is the dead-air bug: the backend answers in ~95 ms, the agent
never speaks the result, and the caller hangs up. Both workspaces were built with `false`,
so anything cloned from them inherits it.

The prompt was **not** touched. It was already correctly de-venued — 8,987 characters
carrying `{{restaurant_name}}` and no hardcoded venue or owner name — and the greeting
already carries the AI + recording disclosure.

## Still wrong, deliberately not changed here

- **Voice is `11labs-Grace`, `en-US`** — an American accent on a Sydney venue. A dashboard
  edit, and a dashboard publish can erase API-applied fixes like the ones above, so it must
  be a separate pass under `.claude/skills/retell-agent-quality/`.
- **No `{{owner_name}}` in the prompt.** Harmless today (no owner is named in prose either),
  but the callback line cannot personalise until the variable is used.

## Not yet done — the line does not exist

| Layer | State |
|---|---|
| `restaurants` row `22222222-…` | ✅ inserted 27 Aug (10 placeholder tables, `contact_email` NULL, `onboarding_status = provisioning`). **Confirm the real floor onsite.** |
| Menu rows | ❌ absent on production — `Cuban-Corner/cuban-corner-menu-prod.sql` never applied. Menu Q&A is silent without them, and that reads as an agent fault |
| Twilio voice region → **US1** | ❌ console-only, and must be set **before** a trunk is attached |
| Trunk `voxtable-prod-us1` | ❌ not built |
| Retell number import | ❌ not done — do it **last**, it has no clean undo |
| `deploy/voice-lines.json` entry | ❌ deliberately withheld until the trunk SID exists. A half-declaration is not inert: `apply-line.mjs` would act on it |

## Blocker

**There is no working Twilio API credential for Biteperk-production
(`ACd423bd09e9649e552a0b6d19a9eed338`).** The `bp-voxtable-prod` secret
`voxtable-prod-twilio-account-sid` holds `AC949756ac8dc4aced25b15b2e0bbb3a61` — the **legacy
Algorythmos** account — and that pair 401s anyway; the AU1 key in the repo's local `.env`
401s against both BitePerk accounts. So the Twilio half is console-only, and
`assert-line` checks 15–20 cannot pass on any production line until a US1-region API key
exists.

## Declaration to add once the trunk SID is known

```jsonc
"+61485071140": {
  "environment": "production",
  "api_base": "https://api.biteperk.com.au",
  "retell_workspace": "Biteperk",
  "retell_credentials": { "via": "vm-ssh", "instance": "core-central-vm", "zone": "us-central1-a",
    "gcp_project": "vocotable-497209", "env_file": "/opt/vocotable/.env",
    "api_key_var": "RETELL_API_KEY", "webhook_secret_var": "RETELL_WEBHOOK_SECRET" },
  "restaurant_id": "22222222-2222-4222-8222-222222222222",
  "venue_name": "Cuban Corner Parramatta",
  "retell_agent_id": "agent_2892d65ceace4e68d8a3f3e80c",
  "retell_agent_name": "Cuban Corner Parramatta (VoxTable)",
  "retell_llm_id": "llm_53c6e9de9aac3b60270ffdd6bcba",
  "inbound_mode": "webhook-only",
  "required_boosted_keywords": ["Cuban Corner", "Cuban Corner Parramatta"],
  "twilio_account_sid": "ACd423bd09e9649e552a0b6d19a9eed338",
  "twilio_trunk_sid": "TK…",
  "twilio_region": "us1",
  "termination_uri": "voxtable-prod-us1.pstn.twilio.com",
  "origination_transport": null,
  "trunk_secure": null,
  "db": { "via": "vm-ssh", "instance": "core-central-vm", "zone": "us-central1-a",
    "gcp_project": "vocotable-497209", "container": "vocotable-postgres-1" },
  "customer_facing": false
}
```

Fill `origination_transport` and `trunk_secure` from what the trunk actually reads back, not
from the recipe. `assert-line` derives its Twilio API host from `twilio_region`, so `us1`
needs no script change.

## Why US1

The ~7.6 s fixed-timer drop (`deploy/runbooks/incident-7600ms-call-drops.md`) is **AU1-only**
across both accounts; the only trunk that has never dropped a call is US1. This number was
unattached, so it is the one clean chance to route a production line on US1 without risking a
live one — and it settles the last open variable in that incident. AU1 was never onshore call
processing anyway (Retell is US-based), so the residency loss is smaller than it sounds.
