# Mazcina production — Bella recommends Camilo's ranked dishes, knows which menu is on, hands off big parties

**Date:** 3 September 2026
**Agent:** `agent_b6b6488af08b82d80e8f4d270a` (Mazcina Resto-Bar (production))
**LLM:** `llm_5f642f051bb83c28d02cea4e1cbc` — one PATCH, `general_prompt` only, 11,889 → 12,614 chars
**Pre-snapshot:** `../20260903-mazcina-recommend-prod-pre/`
**Applied by:** Sam, from the laptop, with the VM's production key via `line-credentials.mjs`
(the change was prepared by the agent; the permission classifier refused to let it run the
PATCH, so Sam executed the same script).

This is runbook `deploy/runbooks/mazcina-production-recommendations.md` §7 — the last step of
PR #337's rollout. §4 (10 ranked dishes) and §6 (`ORDER_FIRE_AT_ENABLED`, `KITCHEN_LEAD_MINUTES=25`,
`VOICE_AUTOBOOK_MAX_PARTY=4`) were applied earlier on 3 Sep during the 1.1.0 promotion. The
wording is the staging wording proven on 2 Sep (`../20260902-mazcina-recommend-staging-post/`),
reused verbatim.

## What changed — three edits

1. **Menu questions** — after "A named dish, section or ingredient → pass `query`…":
   ```
   - "What do you recommend?" / "what's good?" / they sound unsure → speak from {{menu_highlights}}:
     name ONE dish (from the section they mentioned, otherwise the first one), then stop and ask if
     that sounds good. If it's empty, fall back to `menu_lookup` with no query.
   ```
2. **New section "What's on the menu right now"** carrying `{{menu_status}}`, inserted before
   "When a tool doesn't work" — the line `assert-line.mjs` check [14] requires now that the
   backend serves the variable (it serves `""` for Mazcina's unwindowed menu, which is correct).
3. **Edge cases** — the hardcoded "Parties of 7 or more: the largest table seats six…" bullet is
   replaced by the reactive one: on `check_availability` → `reason: "party_too_large"`, don't try
   alternate times, offer a callback from `{{owner_name}}` (Camilo), take name and number, end the
   call. The old text contradicted `VOICE_AUTOBOOK_MAX_PARTY=4`: Bella promised tables the tool
   then refused.

No venue or dish names in prose — the data drives it.

## Read-back (from `get-retell-llm`, printed by the PATCH script, not summarised)

```
=== Mazcina llm_5f642f051bb83c28d02cea4e1cbc: 11889 → 12614 chars
✓ prompt contains {{menu_highlights}}
✓ prompt contains {{menu_status}}
✓ old 'Parties of 7 or more' text gone
✓ party_too_large branch present, hands off via {{owner_name}}
✓ read-back equals intended text
✓ default_dynamic_variables unchanged
✓ model / temperature unchanged
✓ no venue name in prose
```

Snapshot diff pre → post: only `general_prompt` and `last_modification_timestamp` differ; every
agent field (voice, sensitivity, speak flags, retention) is byte-identical.

`npm run check:voice-lines` after the PATCH:

```
═══ +61468202846 (production) ═══
✓ [14] golden agent config (assert-agent.mjs)
✓ [16] number is attached to trunk TK50f2a0cc6c4906a1b946867489716548
All checks passed.
```

([16] passes because `deploy/voice-lines.json` was corrected in the same change to the trunk the
number is really on — declaration drift, not a vendor move.)

## Rollback

One PATCH restoring `general_prompt` from `../20260903-mazcina-recommend-prod-pre/llm.json`.
To revert the behaviour entirely, also null the rankings (`UPDATE menu_items SET
recommend_rank=NULL, is_signature=false, is_quick_bite=false WHERE restaurant_id='44444444-…'`)
and remove the three §6 flags from the VM `.env`.

## Unproven — the ear test is still owed

No call has been placed since this PATCH. Runbook §9, dial `+61 468 202 846` (internal — the
line is not customer-facing while the 7.6 s drop incident is open):

- "What do you recommend to start?" → one Starter (Cocktail Empanadas), then a pause
- "What's good for sharing?" → Mazcina Ocean Board
- "What salads do you have?" → falls back cleanly, no ranked items in that section
- A party of 5 → hands off to Camilo; `check_availability` agrees rather than offering a table
- Book + pre-order a dish → KDS Upcoming lane with a countdown, not immediately Pending
- Camilo receives the booking text

Record the results here the same day.
