# 2026-08-26 — staging: one-recap prompt wave (stage 4, final tuning stage)

Grounded in two reviewed calls:
- `call_16b57060…` (08:42): booking details stated FIVE times; the caller said
  "you don't have to repeat again and again."
- `call_6fb61542…` (10:05): Bella asked for the caller's number digit-by-digit while
  `{{caller_phone}}` was set (caller: "you already got my phone"); promised an off-menu
  "fries" request was noted, then `create_order` 400'd and she walked it back.

## What changed (`PATCH /update-retell-llm/llm_c1d40dbe180e737dd2ce1309ed3f`, prompt only)

`general_prompt` 10,574 → 11,498 chars. Agent object untouched.

1. **One full recap per call**, at the confirm step ("shall I lock it in?"). Date read-back
   only for relative/ambiguous dates. Post-create_booking = one short sentence with no
   details — "You're all set, [NAME] — confirmation text on its way." — with an escape
   hatch: if the tool result differs from what was confirmed, say the difference.
2. **Never restate booking details after create_booking** (asides, pre-order offer, goodbye)
   unless a detail changes; then confirm only the changed value.
3. **Asides are contentless**: 3–6 words, never repeating booking details.
4. **Caller-phone rule**: digit-by-digit ask only when `{{caller_phone}}` is empty; when set,
   never ask — "I'll text the number you're calling from."
5. **Proactive SMS mention**: the post-booking sentence names the confirmation text (the
   booking SMS shipped today; first delivery proven 10:07 on the 10:05 call).
6. **No premature order promises**: off-menu requests get the real options; an order exists
   only once `create_order` confirms.
7. Opener swap: "Mm-hm" / "Mm, let me have a look." → "Too easy —" / "One sec, let me have
   a look." (last "mm" source; backchannel words were narrowed separately this morning).

Kept verbatim: the AI/recording honesty line, "Open or closed?" hours gate,
"be honest, never fake it", the resolved-date safety rule, pre-order-ONCE, all tool contracts.

## Read-back evidence (pasted, not summarised)

```
READ-BACK: prompt 11498 chars | model gpt-4.1 | temp 0.2 | ddv {}
  ok: one-recap rule / no-restate rule / caller-phone rule / proactive text /
      no premature order promise / contentless asides / openers swapped (no Mm-hm) /
      date-safety rule kept
begin_message unchanged: True
tools: ['check_availability', 'create_booking', 'modify_booking', 'end_call', 'menu_lookup', 'create_order']
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

## Verification still owed

Acceptance call per the plan: full details spoken exactly once; no "mm"; no number ask when
caller ID present; text mentioned unprompted; off-menu ask gets real options; e2e p50 ≤ 1.7 s.

## Rollback

Re-apply `../20260826-prompt-onerecap-pre/llm.json`'s `general_prompt` in one PATCH.
