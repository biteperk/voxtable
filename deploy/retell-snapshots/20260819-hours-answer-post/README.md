# Mazcina staging LLM — after the open/closed answer fix, 19 Aug 2026

`llm_c1d40dbe180e737dd2ce1309ed3f` after the PATCH (read back from the API).
Two prompt changes, nothing else:

1. Edge cases: hours/parking now answer ONLY from the venue answers section —
   the "common restaurant knowledge" instruction is gone.
2. New section "Open or closed? Check BEFORE you answer": resolve the asked-about
   day, check it against the Hours entry in {{venue_faq}} silently FIRST, lead
   with the conclusion, offer the nearest open day, and never suggest times on a
   closed day.
3. (Same day, later) `menu_lookup` tool description rewritten: a general "what's
   on the menu?" ask must call with NO query — the no-query path returns a real
   category overview — and query is only for a named dish/drink/ingredient. The
   agent had been passing query:"menu", which can never match an item name and
   fell into the zero-match reply (whose hardcoded fixture categories are fixed
   separately in menuService.ts).

Rollback: re-apply the sibling `20260819-hours-answer-pre/llm.json` general_prompt
via `PATCH /update-retell-llm/llm_c1d40dbe180e737dd2ce1309ed3f`.
