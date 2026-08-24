# Production Mazcina prompt: venue facts move from prose to per-call data

**24 Aug 2026**, after the 0.2.0 VM deploy. One field: `general_prompt` on
`llm_5f642f051bb83c28d02cea4e1cbc` (workspace **Biteperk**, key from the VM).

The backend now serves `venue_faq` and `today_status` on every call (verified by the signed
probe: `today_status: "OPEN today (Monday), 12 PM to 9 PM."`), so the temporary hardcoded
"This venue's details" section — flagged "delete once the backend serves venue_faq" in
`20260819-prod-mazcina-post/` — is replaced by `{{venue_faq}}`, and the open/closed section
gains the precomputed `**Today: {{today_status}}**` line.

Deliberately KEPT (production is ahead of staging here): the `{{now_local}}` time anchor and
the CLOCK-questions section from #240. Staging's prompt lacks both; do not "sync" them away.

Data change that made this safe: the one fact the FAQ lacked — largest table seats six —
was added to `restaurant_settings.faq_json` first and confirmed served before the trim.

Applied output:
```
prompt: 11773 -> 11281 chars
read-back matches: true
begin_message unchanged: true
✓ [14] golden agent config (assert-agent.mjs)
```

The agent may now be cloned for other venues (no venue facts in prose). Rollback: PATCH
`general_prompt` from `../20260824-prod-mazcina-devenue-pre/llm.json`.
