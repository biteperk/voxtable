# Cuban Corner production agent reaches the golden config — `[14]` finally passes

**30 Aug 2026.** One PATCH to `llm_53c6e9de9aac3b60270ffdd6bcba` (Biteperk workspace),
closing the three violations `assert-agent.mjs` still reported after the 27–28 Aug passes.
Pre-snapshot: `../20260830-cuban-golden-pre/`.

## What changed

| Field | Before | After |
|---|---|---|
| `begin_message` | "…this is Bella. Your call's recorded…" | "…this is Bella, **an AI assistant**. Your call's recorded…" — the AI half of the disclosure was missing; the owner warrants both halves in the agreement ledger |
| `general_prompt` | 18,319 chars, no honesty section | 19,369 chars — the golden "## When a tool doesn't work — be honest, never fake it" section (taken verbatim from the live Mazcina production prompt) inserted before the closing section |
| `speak_during_execution` on all 5 functional tools | `false` | `true` — the fillers-ON decision (Sam, 29 Aug), recorded at `assert-agent.mjs`; the fillers-off state came from the now-rejected `pipeline-environment-checks` rationale |

## Read-back (pasted, not summarised)

```
readback: begin has AI disclosure: True
readback: honesty section: True
readback: all functional tools during+after true: True
readback: defaults still empty-ish volatile-free: True
```

`assert-agent.mjs` (VENUE_NAMES="cuban corner"): **ALL CHECKS PASSED**.

`assert-line.mjs +61485071140 --strict` with the US1 Twilio key loaded:
**All checks passed** — 17/17, the first full pass for this line. `[14]` was the last holdout.

## Still open, deliberately not changed here

- **Voice is `11labs-Grace`, `en-US`** — an American accent on a Sydney venue. Dashboard-only
  change (a publish can erase API fixes), Sam's ear decides; discard any draft afterwards.
- A real dress-rehearsal call battery is still the go/no-go gate — config proven ≠ line works.

## Rollback

Re-apply `../20260830-cuban-golden-pre/llm.json` via `PATCH /update-retell-llm/llm_53c6…`
(one PATCH; the agent object was not touched).
