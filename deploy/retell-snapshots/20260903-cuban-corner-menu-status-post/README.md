# Cuban Corner production — Bella knows which menu is on right now

**Date:** 3 September 2026
**Agent:** `agent_2892d65ceace4e68d8a3f3e80c` (Cuban Corner Parramatta (VoxTable))
**LLM:** `llm_53c6e9de9aac3b60270ffdd6bcba` — one PATCH, `general_prompt` only, 19,369 → 19,771 chars
**Pre-snapshot:** `../20260903-cuban-corner-menu-status-pre/`
**Applied by:** Sam, from the laptop, with the VM's production key (same script and run as
`../20260903-mazcina-recommend-prod-post/`).

## What changed — one section

"What's on the menu right now", carrying `{{menu_status}}`, inserted before "When a tool
doesn't work" — the same text staging has run since 30 Aug. Cuban Corner is the venue whose
windowed menu motivated the variable (call_4e871f4bc, 30 Aug: breakfast items offered for a 2 PM
pickup, then refused at order time). The backend already served it per call; the prompt never
read it, which is what check [14] was failing.

`{{menu_highlights}}` was deliberately **not** added: this venue has no ranked dishes, so the
recommend line would only fall through to `menu_lookup`.

## Read-back (printed by the PATCH script)

```
=== Cuban Corner llm_53c6e9de9aac3b60270ffdd6bcba: 19369 → 19771 chars
✓ prompt contains {{menu_status}}
✓ read-back equals intended text
✓ default_dynamic_variables unchanged
✓ model / temperature unchanged
✓ no venue name in prose
```

Snapshot diff pre → post: only `general_prompt` and `last_modification_timestamp` differ.

`npm run check:voice-lines`: `+61485071140 (production) … ✓ [14] … All checks passed.`

## Rollback

One PATCH restoring `general_prompt` from `../20260903-cuban-corner-menu-status-pre/llm.json`.

## Unproven

No call placed since. Ear test: ring `+61 485 071 140` before noon and ask for an all-day item
and a breakfast item; after noon ask for a breakfast item — Bella should name the window it is
served and offer something from the current menu, never start the order.
