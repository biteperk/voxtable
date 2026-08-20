# Bella learns what time it is — production Mazcina, 20 Aug 2026

| | |
|---|---|
| Agent | `agent_b6b6488af08b82d80e8f4d270a` — Mazcina Resto-Bar (production) |
| LLM | `llm_5f642f051bb83c28d02cea4e1cbc` |
| Workspace | **Biteperk** (production). Key from the VM's `/opt/vocotable/.env` — the repo's local `.env` is the LEGACY workspace and edits the wrong agent |
| Prompt | 11,573 → **11,773** chars |
| Pre-state | `../20260820-prod-time-awareness-pre/` |

## The defect

Call `call_e9c4c7129209d19d1a463c62fd8`, 22:12, 103 s. The venue closed at 21:30. Bella said:

> *"Yep, you can absolutely come now — we're open and have tables from 12 noon."*

and, a minute later, when asked the time outright:

> *"I actually don't have the current time on my end."*

Both were true statements about her situation and the first one would have sent a customer to a
locked door.

**Cause: the prompt reasoned about open/closed at DAY granularity only.** "Are you open now?"
collapsed to "is Thursday a trading day?" → yes → "come now". There was no clock anywhere in
11.5k characters.

**The backend was already serving one.** A signed `/retell/inbound` probe returns
`now_local: 22:16` and has done all along — migration 024 serves it. Nothing read it. No backend
change was needed, which matters because backend promotion is blocked on
`LEGAL_DOCUMENTS_MANIFEST_URL`.

## Applied

1. **Time anchor** now states the clock: *"The time RIGHT NOW is **{{now_local}}**"*.
2. **Open or closed?** gained a clock rule — "now" / "tonight" / "still open?" are compared
   against today's Hours before answering, with distinct scripts for before opening, after
   close, and inside the last 30 minutes. Plus: never take a booking for a time already past.
3. **Unfilled-variable fallback generalised** from `{{today}}` to any date/time variable, and
   tightened. This paid for most of the additions.
4. **Removed a note addressed to human editors** (the "TEMPORARY: venue facts belong in
   `venue_faq`" warning). It was read as tokens on every call and changed nothing a caller
   hears. Recording it here instead: **the venue-details section is temporary; delete it the
   day the backend serves `venue_faq`, and never clone this agent to another venue.**

Net +200 chars for a correctness fix that removes roughly 40 seconds of on-call floundering.

## Read back from the live LLM

```
chars                : 11773
uses {{now_local}}   : True
clock rule present   : True
after-close line     : True
no past-time booking : True
editor note removed  : True
```

`assert-agent.mjs`: **ALL CHECKS PASSED.**

## Latency — measured, not fixed

`latency-report.mjs` on that call: **e2e p50 1789 ms** (gate ≤1700), p90 3519, llm p50 1038,
tts p50 221. It is genuinely slightly slow and the caller noticed.

Both large levers are already pulled — Expressive Mode off, `stt_mode: fast`. Lever 3 is prompt
length, and the remaining fat was three lines; the safety and honesty sections were the only
other candidates and cutting those to save 200 characters is a bad trade. **Lever 4 is a model
swap, which the skill marks last-resort and untested — a deliberate experiment with the full ear
battery, not a late-night default.** So per-turn latency is unchanged and should not be claimed
otherwise. What this change does buy is a much shorter call: the 22:12 call spent ~40 s in a loop
because she could not answer "can I come now".

## ⚠️ Found while doing this: Mazcina has NO AI/recording disclosure in production

| Agent | Greeting discloses? |
|---|---|
| Cuban Corner Parramatta | ✅ |
| Natalia's Bistro | ✅ |
| **Mazcina Resto-Bar** | ❌ *"Thanks for calling {{restaurant_name}} — this is Bella. How can I help?"* |

`NUMBERS.md` claims the disclosure was "restored 20 Aug across all three production agents".
Two of three is the truth — and the claim was written from the legacy workspace, the same
wrong-key error that caused that evening's outage.

**Deliberately not changed here.** The 19 Aug README records omitting it as Sam's explicit
decision, and the skill puts the disclosure under legal sign-off, not style. It is one PATCH
either way. The prompt does still answer honestly if a caller asks whether she is an AI or
recorded; what is missing is proactive disclosure. Gate stands: restore it before this number is
publicised or handed to the venue.

## Rollback

`PATCH /update-retell-llm/llm_5f642f051bb83c28d02cea4e1cbc` with `general_prompt` from
`../20260820-prod-time-awareness-pre/llm.json`. Agent object untouched.
