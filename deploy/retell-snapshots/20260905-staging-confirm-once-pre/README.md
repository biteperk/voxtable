# 2026-09-05 — staging: pre-snapshot before the "confirm once, never repeat" levers

Live state of the staging Mazcina twin before Phase 1 of GitHub issue #389.
Agent `agent_7b67073710604d306443cc569c`, LLM `llm_c1d40dbe180e737dd2ce1309ed3f`,
prompt 16,299 chars, voice `11labs-Grace`, version 3 (unpublished draft served via webhook mode,
last modified 30 Aug by the fillers change — not a dashboard draft).

Rollback for everything in `../20260905-staging-confirm-once-post/`: PATCH `general_prompt` and
`general_tools` from this `llm.json` back onto the LLM. The agent object was not touched.
