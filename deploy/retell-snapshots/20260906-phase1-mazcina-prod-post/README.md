# 2026-09-06 — Mazcina production: confirm once, never repeat (issue #389, Phase 1)

**Agent:** `agent_b6b6488af08b82d80e8f4d270a` (Mazcina Resto-Bar (production)) — untouched.
**LLM:** `llm_5f642f051bb83c28d02cea4e1cbc` — two PATCHes (`general_tools`, then `general_prompt`).
**Pre-snapshot:** `../20260906-phase1-mazcina-prod-pre/` (live prompt was byte-identical to
`../20260903-mazcina-recommend-prod-post/`, checked before editing).
**Applied by:** Sam's laptop with the production key from `bp-voxtable-prod` Secret Manager, after
release 1.2.1 (`0495055`) was live on `voxtable-prod-api-00013-5sl` — the prompt's step 7 reads the
short `confirmation_message` that PR #390's backend returns, so the order mattered.

## Why

Staging received these five edits on 5 Sep (`../20260905-staging-confirm-once-post/README.md`) and
the graded case `one-recap-not-five` went from FAIL to PASS ×3. Two real staging phone calls on
6 Sep (`call_9f5a760148d60504c…`, `call_d0bc236816005064…`) each spoke one recap and one goodbye.
This applies the same mechanism to production. The edits were made **to the production prompt**,
not by copying staging's: this prompt carries Mazcina-specific sections staging lacks.

## What changed

**Tools** (PATCH 1/2/4 of the staging record): `execution_message_description` = the contentless
three-to-six-word aside on `check_availability`, `create_booking`, `modify_booking`, `menu_lookup`,
`create_order`; `end_call.speak_after_execution` `true → false` with the same-turn description.

**Prompt** (PATCH 3/5), 12,614 → 13,616 chars:
- Deleted the "keep the line alive with ONE short aside" bullet (the tools carry it now) and "Never
  say goodbye more than once" (the end_call flag enforces it); first-name-only rule in its place.
- Booking step 1: no full date read-back — only an ambiguous date is checked, alone.
- Step 4: two words at most before asking the name. Step 5: confirm ONCE with "shall I lock it in?",
  then STOP; `create_booking` only in the turn AFTER the yes, even when front-loaded.
- Step 7: read `confirmation_message` word for word; step 8: never say date/time/party again.
- "Seating preferences" → "Seating and dietary notes" with the allergy rule (never adjudicate; pass
  words as `notes`; venue confirms; still take the booking).
- `modify_booking`: read its `confirmation_message` (names only what changed).
- Ending: one closing with no date or time, `end_call` in the same turn, pull-back only for an
  agreed-but-uncommitted booking, never re-pitch after "I'll call back".

**The prompt got longer (+1,002 chars), against the skill's ratchet.** Staging's got shorter because
it had duplicate prose to delete; this prompt did not. The growth is three rules production lacked
(allergy ≈ +230, first-name ≈ +100, the explicit confirm-once/read-verbatim steps ≈ +670), not
symptom patching. Recorded rather than hidden.

## Read-back (pasted from the run, not summarised)

```
PATCH general_tools (asides + end_call): 200
PATCH general_prompt: 200
✓ prompt equals intended text
✓ model unchanged
✓ begin_message unchanged
✓ end_call speak_after_execution=false
✓ end_call description applied
✓ check_availability aside + during/after true
✓ create_booking aside + during/after true
✓ modify_booking aside + during/after true
✓ menu_lookup aside + during/after true
✓ create_order aside + during/after true
✓ tool count unchanged
✓ tool URLs all production
ALL READ-BACK CHECKS PASSED
```

## Rollback

Re-apply the pre snapshot, one PATCH per object:
`PATCH /update-retell-llm/llm_5f642f051bb83c28d02cea4e1cbc` with `general_prompt` and
`general_tools` from `../20260906-phase1-mazcina-prod-pre/llm.json`. The agent was not changed.

## Not done here

The number's inbound webhook stays unhooked (Bella paused on 5 Sep). Re-hooking is a production
activation decision, not part of this PATCH.
