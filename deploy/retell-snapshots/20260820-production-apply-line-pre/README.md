# Pre-state of the production Mazcina agent, 20 Aug 2026

Taken automatically by `scripts/apply-line.mjs +61468202846 --apply` before it reconciled the
production line to [`deploy/voice-lines.json`](../../voice-lines.json).

## What this snapshot shows

`agent.json` here is the agent as it had stood since **19 Aug 22:38** — `agent_name` still
`Mazcina (production)`, `pronunciation_dictionary` `null`, `boosted_keywords` without the full
venue name. That is the state the 19 Aug README claimed had been fixed on 20 Aug; see the
correction appended to `../20260819-prod-mazcina-post/README.md`.

## What was applied

| Layer | Change | Read back? |
|---|---|---|
| Retell agent `agent_3bedcbdd77017136e5b4ade412` | `agent_name` → `Mazcina Resto-Bar (production)`; pronunciation `Mazcina` → `mɑˈsinɑ`; `boosted_keywords` += `Mazcina Resto-Bar` | ✅ confirmed |
| Production DB row `44444444-…` | `retell_agent_id` `agent_b6b6488af08b82d80e8f4d270a` (**did not exist**) → `agent_3bedcbdd77017136e5b4ade412` | ✅ `UPDATE 1`, row re-read |
| Retell number import | ❌ **BLOCKED** — see below | — |

No post-snapshot exists because the run halted at the import step. The agent state after the
change is recorded in the read-back inside `assert-line.mjs` output, not here.

## Why there is no import

`POST /import-phone-number` returned **400 `Phone number already exists.`** while
`GET /get-phone-number/+61468202846` returns **404 in this workspace** — and also 404 in the
Staging workspace. Both are true at once: Retell scopes a number to exactly one workspace
account-wide, so `+61 468 202 846` is registered in a workspace neither BitePerk key can see.
Whoever imported it there evicted it from here, which is why the 19 Aug import "vanished".

Until it is released there, nothing on our side can make this number answer. Resolving it needs
a human at the Retell dashboard — check every workspace on the account, and the legacy
Algorythmos workspace (a different login, `NUMBERS.md` §4). Deleting is one-way and a failed
re-import means a 24–48h support ticket (`CLAUDE.md` §D rule 7).

## Rollback

- Agent: `PATCH /update-agent/agent_3bedcbdd77017136e5b4ade412` with the values in `agent.json`.
- DB: set `retell_agent_id` back to `agent_b6b6488af08b82d80e8f4d270a` — **don't**. That id does
  not exist; the pre-state was broken, which is the whole point of this change.
