# Mazcina production — pre-snapshot before the recommend / menu-status / party-cap prompt

> Historical snapshot only. The VM credential provenance below is obsolete and is not a current
> production procedure. Production credentials come from `bp-voxtable-prod` Secret Manager.

**Date:** 3 September 2026
**Agent:** `agent_b6b6488af08b82d80e8f4d270a` (Mazcina Resto-Bar (production))
**LLM:** `llm_5f642f051bb83c28d02cea4e1cbc` — prompt 11,889 chars at snapshot time
**Credentials:** read from `core-central-vm:/opt/vocotable/.env` via `line-credentials.mjs`
(the repo's local `.env` is the legacy workspace and cannot see this agent).

This is the live production config immediately before runbook
`deploy/runbooks/mazcina-production-recommendations.md` §7 — the prompt half of PR #337's
rollout. Data (§4, 10 ranked dishes) and flags (§6) were applied on 3 Sep during the 1.1.0
promotion; this prompt is the only piece the caller has not yet heard.

Signed probe before the PATCH (`probe-inbound.mjs +61468202846`, `PROBE OK`):

```
override_agent_id: agent_b6b6488af08b82d80e8f4d270a
owner_name: Camilo
today_status: OPEN today (Thursday), 12 PM to 9:30 PM.
menu_status:                      ← "" — Mazcina's menu is unwindowed, so empty is correct
menu_highlights: Quick to make, good while mains cook: Cocktail Empanadas ($5), Sopaipillas ($1.50).
```

`menu_highlights` is populated, so the prompt may reference it (a missing `{{name}}` renders
literally to the caller).

## What the following PATCH changes (`../20260903-mazcina-recommend-prod-post/`)

The staging wording proven on 2 Sep (`../20260902-mazcina-recommend-staging-post/README.md`),
reused verbatim, `general_prompt` only:

1. **Menu questions** gains the recommending line driven by `{{menu_highlights}}` — one dish,
   then stop and ask.
2. A **"What's on the menu right now"** section carrying `{{menu_status}}` — what check [14]
   of `assert-line.mjs` enforces now that the backend serves the variable.
3. **Edge cases**: the hardcoded "Parties of 7 or more … seats six" bullet is replaced by the
   reactive `check_availability → reason: "party_too_large"` bullet handing off via
   `{{owner_name}}`. With `VOICE_AUTOBOOK_MAX_PARTY=4` live since 3 Sep, the old text
   contradicted the backend: Bella promised tables the tool then refused.

## Rollback

One PATCH restoring `general_prompt` from this directory's `llm.json`:

```
PATCH /update-retell-llm/llm_5f642f051bb83c28d02cea4e1cbc   {"general_prompt": <llm.json .general_prompt>}
```
