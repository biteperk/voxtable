# Cuban Corner production — pre-snapshot before adding `{{menu_status}}`

> Historical snapshot only. The VM credential provenance below is obsolete and is not a current
> production procedure. Production credentials come from `bp-voxtable-prod` Secret Manager.

**Date:** 3 September 2026
**Agent:** `agent_2892d65ceace4e68d8a3f3e80c` (Cuban Corner Parramatta (VoxTable))
**LLM:** `llm_53c6e9de9aac3b60270ffdd6bcba` — prompt 19,369 chars at snapshot time
**Credentials:** read from `core-central-vm:/opt/vocotable/.env` via `line-credentials.mjs`.

Live production config immediately before a one-section PATCH. Since the 1.1.0 promotion the
production backend serves `menu_status` per call, so `assert-line.mjs` check [14] now requires
the prompt to reference `{{menu_status}}` — this line was failing that check (and only that
check) on 3 Sep.

Signed probe before the PATCH (`probe-inbound.mjs +61485071140`, `PROBE OK`):

```
override_agent_id: agent_2892d65ceace4e68d8a3f3e80c
owner_name: the manager
today_status: OPEN today (Thursday), 7 AM to 10 PM.
menu_status: Menu right now: the all-day menu is serving. Items served between 7 AM and 12 PM are NOT available n…
menu_highlights:                  ← "" — Cuban Corner has no ranked dishes; not referenced
```

## What the following PATCH changes (`../20260903-cuban-corner-menu-status-post/`)

Only the **"What's on the menu right now"** section (the same text staging has carried since
30 Aug, `../20260830-staging-menu-status-pre/` → post), inserted before "When a tool doesn't
work". Nothing else. `{{menu_highlights}}` is deliberately **not** added: it is empty for this
venue and the recommend line would fall through to `menu_lookup` for nothing.

## Rollback

```
PATCH /update-retell-llm/llm_53c6e9de9aac3b60270ffdd6bcba   {"general_prompt": <llm.json .general_prompt>}
```
