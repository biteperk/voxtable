# 2026-09-07 — Mazcina production line repair (pre-apply snapshot)

`+61468202846` (Mazcina Resto-Bar, production Biteperk workspace).

## Why this snapshot exists

Earlier on 7 Sep 2026 the line's `deploy/voice-lines.json` `api_base` was changed to the Cloud
Run service URL and the Retell number's inbound webhook was repointed to match. That broke the
live line: Mazcina's venue row exists only on the sandbox VM, so `/retell/inbound` on Cloud Run
could not resolve `+61468202846`. It returned **200** with `restaurant_unconfigured` and no
`dynamic_variables` (`retell_inbound_unmapped_number`), Retell fell back to the statically bound
`V0 (Draft)` agent, and Bella greeted callers with the literal words "thanks for calling
restaurant name". Detail in issue #415.

Two dashboard attempts to fix it did not stick (unchecking the webhook clears the URL; a Draft
agent got statically bound). `apply-line.mjs --apply` then reconciled the number to the
declaration in one scoped PATCH.

## What this pair holds

`agent.json` / `llm.json` as read back from the Biteperk workspace immediately before the
`--apply` PATCH. The matching `…-post/` directory holds the read-back immediately after.

The PATCH touched only the Retell **number** config (`inbound_webhook_url`, `inbound_agents`);
the agent and LLM already matched the declaration, so those files are identical across pre/post
and are kept for a complete rollback set.

## Rollback

`node .claude/skills/retell-agent-quality/scripts/apply-line.mjs +61468202846 --apply` reconciles
to the declaration. To force the exact pre-apply number config back, re-PATCH the number with the
`inbound_webhook_url` / `inbound_agents` values recorded here.

## Read-back after the apply

`node .claude/skills/retell-agent-quality/scripts/assert-line.mjs +61468202846`, 7 Sep 2026:

```
+61468202846 — declared production, api https://api.biteperk.com.au
workspace Biteperk · credentials from Secret Manager (bp-voxtable-prod/voxtable-prod-retell-api-key)

✓ [1] number is imported in this Retell workspace
✓ [2] inbound_webhook_url is https://api.biteperk.com.au/retell/inbound
✓ [3] no static inbound_agents (webhook-only, per NUMBERS.md §6)
⚠ [4] SKIPPED — signed /retell/inbound probe
⚠ [5] SKIPPED — backend dynamic variables
⚠ [6] SKIPPED — backend agent resolution
⚠ [7] SKIPPED — backend venue resolution
✓ [8] declared agent agent_b6b6488af08b82d80e8f4d270a exists in this workspace
✓ [9] agent name passes the bind guard against "Mazcina Resto-Bar"
✓ [10] agent name is exactly "Mazcina Resto-Bar (production)"
✓ [11] agent runs the declared LLM llm_5f642f051bb83c28d02cea4e1cbc
✓ [12] pronunciation of "Mazcina" is mɑˈsinɑ
✓ [13] boosted_keywords carry the venue's full name
✓ [14] golden agent config (assert-agent.mjs)
⚠ [15] SKIPPED — Twilio number → trunk → origination

All checks passed (5 skipped).
```

`[2]` and `[3]` — the two layers that were broken — are green. The line points at
`api.biteperk.com.au` (the VM), which is correct until Mazcina's row is loaded into Cloud SQL
production (#415); repointing it to Cloud Run before then is exactly what caused this incident.
