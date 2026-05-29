# 20260529-busy-fix — Retell hardening after the inbound-call "busy / no booking" incident

## Why
A real call connected but wrote no booking: every `/retell/tools/*` call 401'd
(wrong `RETELL_API_KEY` at the signature gate). While fixing the key, we also
hardened the agent against the failure modes that call exposed.

## What changed vs `20260529-bella-v3-live`

**`llm.json`** (apply via `PATCH /update-retell-llm/llm_2cad4da643f2beb4d07dd0b311d1`)
- **Added prompt section "When a tool doesn't work — be honest, never fake it."**
  Tells Bella to never confirm a booking/availability/order she didn't get a
  successful result for, never list menu items from memory when `menu_lookup`
  errors, and to take a callback number and hand off to a human instead of
  pretending. Also covers the partial case (booking ok, pre-order failed).
- **Refreshed `default_dynamic_variables`** to `today=2026-05-29`,
  `tomorrow=2026-05-30`, `weekday_local=friday`. These are now also injected
  fresh per call by the re-enabled `/retell/inbound` webhook; the defaults are a
  safety net only.
- `general_tools` (all 6) and every other field are byte-identical to live —
  this file was produced by `jq` transforming the live snapshot, not by hand.

**`agent.json`** (apply via `PATCH /update-agent/agent_7b7a5f6c21c9968ee88afd3bac`)
- Added `reminder_trigger_ms: 18000` and `reminder_max_count: 1` so Bella stops
  firing "are you still there?" every ~10s during tool calls (the default).
- `interruption_sensitivity` left at `0.7` — lower it if barge-in persists.
- Base is the `20260526-194440-audit-c` agent snapshot; **reconcile against the
  live agent before PATCHing** (the live config may have drifted since 05/26).

## Publishing
`is_published` is left as-is in both files. After PATCHing, **publish the
agent/LLM version in the Retell dashboard** (or via the publish API) and confirm
the phone number points at the published version — a draft won't take live calls.

## Apply
```
PATCH /update-retell-llm/llm_2cad4da643f2beb4d07dd0b311d1   (body: llm.json mutable fields)
PATCH /update-agent/agent_7b7a5f6c21c9968ee88afd3bac        (body: agent.json mutable fields)
```

## Rollback
Re-apply the prior live state:
```
deploy/retell-snapshots/20260529-bella-v3-live/llm-post.json
deploy/retell-snapshots/20260526-194440-audit-c/agent-post.json
```
