# 2026-09-06 — Cuban Corner production: confirm once, never repeat (issue #389, Phase 1)

**Agent:** `agent_2892d65ceace4e68d8a3f3e80c` (Cuban Corner Parramatta (VoxTable)) — untouched.
**LLM:** `llm_53c6e9de9aac3b60270ffdd6bcba` — two PATCHes (`general_tools`, then `general_prompt`).
**Pre-snapshot:** `../20260906-phase1-cuban-prod-pre/` (live prompt was byte-identical to
`../20260903-cuban-corner-menu-status-post/`, checked before editing).
**Applied by:** Sam's laptop with the production key from `bp-voxtable-prod` Secret Manager, after
release 1.2.1 (`0495055`) was live on `voxtable-prod-api-00013-5sl`, immediately after the Mazcina
PATCH (`../20260906-phase1-mazcina-prod-post/`). Same mechanism, same reasons — read that README.

## What changed here specifically

**Tools:** identical to Mazcina — contentless aside on the five functional tools,
`end_call.speak_after_execution` `true → false` with the same-turn description.

**Prompt**, 19,771 → 20,517 chars:
- Deleted the aside bullet and "Never say goodbye more than once"; first-name-only rule in its place.
- Time anchor now carries `{{now_local}}` — the clock rule below it already read that variable.
- Booking step 2: no full date read-back; ambiguous dates checked alone. Step 4: two words at most
  before asking the name. Step 5: confirm ONCE, "shall I lock it in?", STOP, `create_booking` only
  in the turn after the yes. Step 7: read `confirmation_message` verbatim. Step 8: never say
  date/time/party again.
- Seating: the allergy rule added as a bullet.
- `modify_booking`: read its `confirmation_message`.
- "How to end the call": five lines (two closing examples with "see you [day]", the pull-back with
  the booking details, the repeated-bye paragraph) replaced by the one-closing rule with no date or
  time, `end_call` in the same turn, never re-pitch.
- Edge case: `check_availability` false → say only what the tool said, never "fully booked" — the
  production rule from `call_60c0…` that this prompt never had.

**+746 chars against the ratchet**, for the same reason as Mazcina: the ending got shorter, but the
allergy, first-name and fully-booked rules are new here. Recorded, not hidden.

## Read-back (pasted from the run)

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

`PATCH /update-retell-llm/llm_53c6e9de9aac3b60270ffdd6bcba` with `general_prompt` and
`general_tools` from `../20260906-phase1-cuban-prod-pre/llm.json`. The agent was not changed.
