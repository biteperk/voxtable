# Production Mazcina greeting: the AI + recording disclosure, this time in the right workspace

**23 Aug 2026.** One agent, one field: `begin_message` on `llm_5f642f051bb83c28d02cea4e1cbc`
(agent `agent_b6b6488af08b82d80e8f4d270a`, "Mazcina Resto-Bar (production)", workspace
**Biteperk**, key read from `core-central-vm:/opt/vocotable/.env` via
`deploy/voice-lines.json`).

## Why a second time

`../20260820-prod-disclosure-post/` records this exact change as applied to "all three
production agents". It was applied with the repo's local `.env` key — the **legacy
Algorythmos** workspace — so it reached three agents in another company's estate and never
touched the agent that answers `+61 468 202 846`. Its own README says the production number
"is NOT in this workspace"; that line was the tell, and it was read as a wiring fault rather
than a wrong key (the same error behind the 20 Aug two-hour outage, NUMBERS.md §1).

`assert-line.mjs +61468202846` on 23 Aug, before this change, with the VM's key:

```
✓ [1]–[13]  number, webhook, signed inbound, venue, agent, LLM, pronunciation, keywords
✗ [14] golden agent config (assert-agent.mjs)
     ✗ greeting discloses AI ("an AI assistant")
     ✗ greeting discloses recording ("this call's recorded")
⚠ [15] SKIPPED — no AU1 API key exists for this account
```

Layer 14 only fails because `assert-agent.mjs` gained a greeting check today (PR #244).
Before that it reported ALL CHECKS PASSED on this agent while the greeting carried neither
phrase — the 20 Aug README's "Mazcina ❌ none" row was correct and nothing enforced it.

## Wording

Signed off by Sam on 23 Aug 2026 (the 20 Aug proposal, unchanged):

> "Thanks for calling {{restaurant_name}} — this is Bella, an AI assistant. This call's
> recorded so I can take your booking. How can I help?"

Legal advice on call recording (`deploy/runbooks/legal-brief-call-recording.md`, #133) is
still pending; this is the owner's sign-off on the wording, not a lawyer's.

## Applied — read-back output, not intent

```
environment: production · workspace Biteperk · key from core-central-vm:/opt/vocotable/.env
PRE  begin_message: "Thanks for calling {{restaurant_name}} — this is Bella. How can I help?"
POST begin_message (read back): "Thanks for calling {{restaurant_name}} — this is Bella, an AI assistant. This call's recorded so I can take your booking. How can I help?"
read-back matches: true
LLM otherwise unchanged: true
agent unchanged: true
```

`assert-line.mjs +61468202846` after:

```
✓ [14] golden agent config (assert-agent.mjs)
1 layer(s) unverified — [15] Twilio trunk, no AU1 key (NUMBERS.md §8 item 5a)
```

## Not done here

**The ear test.** No call placed yet. It is leg 1 of the rehearsal battery tomorrow
(`deploy/runbooks/staging-call-battery.md`, run against the production line).

## Rollback

`PATCH /update-retell-llm/llm_5f642f051bb83c28d02cea4e1cbc` with `begin_message` from
`../20260823-prod-mazcina-disclosure-pre/llm.json`. No other field moved.
