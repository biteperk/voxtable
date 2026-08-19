# Mazcina staging — before the humanize pass, 19 Aug 2026 (~14:00)

Live state of `agent_7b67073710604d306443cc569c` / `llm_c1d40dbe180e737dd2ce1309ed3f`
immediately before the greeting/prompt/expressive changes. Captured fresh because the
dashboard had drifted from the earlier snapshots: Sam had switched the voice to
`retell-Cimo` (American) in the dashboard, replacing the custom AU ElevenLabs voice.

State here: 16-second disclosure greeting; 12,723-char prompt (with the same-day
open/closed + menu-mode fixes, WITHOUT the humanize rewrite); Expressive Mode OFF.

Rollback target for the sibling `20260819-humanize-post/` change:
`PATCH /update-retell-llm/<id>` with this `begin_message` + `general_prompt`, and
`PATCH /update-agent/<id>` with `enable_expressive_mode: false`.
