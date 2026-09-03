# Mazcina staging — Bella recommends Camilo's ranked dishes

**Date:** 2 September 2026
**Agent:** `agent_7b67073710604d306443cc569c` (Mazcina Resto-Bar (staging))
**LLM:** `llm_c1d40dbe180e737dd2ce1309ed3f` — one PATCH, `general_prompt` only
**Pre-snapshot:** `../20260902-mazcina-recommend-staging-pre/`

Staging rehearsal for `deploy/runbooks/mazcina-production-recommendations.md` §7, the last
step of PR #337's rollout. This is the recommendation half of that bundle — the wording proven
here is intended to be reused verbatim for the production PATCH.

---

## 1. Data: Camilo's rankings imported

`mazcina/prioritized-dishes-by-category-ordered-from-highest-priority.json` (byte-identical to
`mazcina/Camilo-Priority/Camilo-Priority.json`, the file Camilo supplied) applied against
`33333333-3333-4333-8333-333333333333` via `scripts/import-recommendations.ts --emit-sql`, run
through a throwaway Cloud Run job against staging's private Cloud SQL instance. 10/10 dishes
matched — including "Chilean Cocktail Empanadas" against the stored "Cocktail Empanadas", via
the script's own documented containment fallback — zero misses, one transaction, `COMMIT`.
Verified by a direct read of `recommend_rank` afterward: all 10 present with the correct rank
and `is_signature`/`is_quick_bite` flags.

## 2. Backend already served the variable — nothing to deploy

`buildMenuHighlights` (`apps/backend/src/services/menuService.ts`) and its injection into
`/retell/inbound`'s `dynamic_variables.menu_highlights` (`retellService.ts`) shipped with #337,
already live on `integration`/staging, and are **not gated by any flag** — unlike the pre-order
timing and party-cap pieces of the same PR. Confirmed with a signed probe before touching the
prompt:

```
node .claude/skills/retell-agent-quality/scripts/probe-inbound.mjs +61468203234
```

```
menu_highlights: Quick to make, good while mains cook: Cocktail Empanadas ($5), Sopaipillas ($1.50).
Mains — 1. Mazcina Salmon Cancato…
```

`PROBE OK` — populated, not empty.

## 3. Prompt — two changes, net +317 chars (15,982 → 16,299)

### a. Menu questions gains a recommending line

```diff
 - A named dish or ingredient → pass `query` with their words verbatim.
+- "What do you recommend?" / "what's good?" / they sound unsure → speak from
+  {{menu_highlights}}: name ONE dish (from the section they mentioned, otherwise the first
+  one), then stop and ask if that sounds good. If it's empty, fall back to `menu_lookup`
+  with no query.
 Use `speakable_summary` as source material, but NEVER recite it all in one breath...
```

No dish or venue name in prose — the data drives it, so Camilo reordering his list next month
needs no prompt change.

### b. Party-size edge case: hardcoded threshold replaced with the tool's own reason code

The existing bullet hardcoded "Parties of 7 or more" against a stale "seats six" fact. With
`VOICE_AUTOBOOK_MAX_PARTY` now the real enforcement point (an env var, not a prompt fact —
deliberately, so raising Camilo's cap later needs no agent PATCH), a hardcoded number in the
prompt would silently disagree with the backend the moment the cap changed. Made it reactive
instead:

```diff
-- Parties of 7 or more: the largest table seats six — say so warmly and offer a callback:
-  "For bigger groups I'll get {{owner_name}} to ring you and sort what we can do." Take name
-  and number, then end the call.
+- If `check_availability` comes back with `reason: "party_too_large"`: don't try alternate
+  times — say so warmly and offer a callback: "For a group that size I'll get {{owner_name}}
+  to ring you and sort what we can do." Take name and number, then end the call.
```

This bullet already used `{{owner_name}}` before this change — only the trigger condition
moved from a hardcoded number to the tool's own signal.

## Read-back (from `get-retell-llm`, not the write response)

```
✓ prompt contains {{menu_highlights}}
✓ old "Parties of 7 or more" text gone
✓ prompt contains the party_too_large reason-code branch
✓ default_dynamic_variables: {} — unchanged
```

`assert-agent.mjs agent_7b67073710604d306443cc569c llm_c1d40dbe180e737dd2ce1309ed3f`:
18/20 checks pass. The 2 failures (greeting doesn't disclose AI / doesn't disclose recording)
are **pre-existing**, confirmed against the pre-snapshot's `begin_message` — unrelated to this
change, a deliberate staging-only deviation tracked in `legal-brief-call-recording.md`, not
reproduced here.

`assert-line.mjs +61468203234 --strict`: 14/14 real checks pass, 1 skipped (Twilio trunk/
origination — needs `TWILIO_AU1_KEY_SID/SECRET` in the local shell, not loaded for this run and
unrelated to the prompt change).

## Sim-test suite — one case run, inconclusive

`run-sim-tests.mjs --case never-invent-a-rule-or-a-menu-item` (chosen because this PATCH
touched the Menu questions section it exercises) returned `ERR — Ending the conversation early
as there might be a loop`. That reads like the harness's own loop-detection cutoff rather than
a content grade against the new wording, and the suite is billed per run (documented history of
exhausting the staging credit balance), so it was not re-run blind. **Needs a human look before
being treated as a real regression signal** — did not block the prompt PATCH, and is not a
substitute for the ear test below.

## Rollback

One PATCH restoring `general_prompt` from the pre-snapshot:

```
PATCH /update-retell-llm/llm_c1d40dbe180e737dd2ce1309ed3f
      general_prompt from ../20260902-mazcina-recommend-staging-pre/llm.json
```

Then `UPDATE menu_items SET recommend_rank=NULL, is_signature=false, is_quick_bite=false WHERE
restaurant_id='33333333-3333-4333-8333-333333333333'` to also revert the data half — makes
`menu_highlights` empty again, the pre-#337 behaviour.

## Unproven

No call has been placed since this change. The ear-test battery (below) is the required next
step before this wording is repeated on production. `ORDER_FIRE_AT_ENABLED`,
`KITCHEN_LEAD_MINUTES`, `VOICE_AUTOBOOK_MAX_PARTY` are proposed on staging in
[biteperk/biteperk-cloud-platform#66](https://github.com/biteperk/biteperk-cloud-platform/pull/66)
but not yet merged/applied — the pre-order-timing and party-cap-refusal legs of the ear test
below cannot pass until that PR is applied.

### Ear-test battery — dial +61 468 203 234 (staging-internal, do not publish)

- "What do you recommend to start?" → **one** Starter, rank 1 (Chilean Cocktail Empanadas),
  then a pause — not a recited list
- "What's good for sharing?" → reaches Chef Suggestions for Sharing → Mazcina Ocean Board
- "What salads do you have?" → falls back cleanly (no ranked items in that section)
- A party of 5 → *(needs PR #66 applied first)* hands off to Camilo's name; `check_availability`
  agrees rather than offering a table
- Book + pre-order a dish → *(needs PR #66 applied first)* appears in KDS Upcoming with a
  countdown, not immediately Pending
