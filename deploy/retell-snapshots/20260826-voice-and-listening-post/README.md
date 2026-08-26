# 2026-08-26 — staging: new voice, and she listens now

Sam's verdict on `call_1aee86956b7bf11b642bf41784d`: "the agent is shit… very dumb…
it did not listen me when I was saying that I need fish and chips." All of it is
visible in the transcript, and none of it was the model being stupid.

## What the call actually showed

| Time | What happened |
|---|---|
| 67.0–90.0s | A **23-second monologue** listing nine menu sections then five dishes |
| 74.5 / 82.1 / 89.0s | The caller says "fish and chips" **three times** — she talks over all three |
| 123.6–148.5s | **25 seconds of dead air**: she said "One moment…" and then ran no tool |
| 159s | Ordered **Chips ($9)** while saying "fish and chips" — the substitution bug, fixed in code |
| 275.8s | "I actually can't see payment status on my end" — true; there was no tool |

## What changed

**Agent** (`PATCH /update-agent`):
- `voice_id`: `retell-Cimo` → **`retell-Willa`**. ⚠️ Retell has exactly two Australian
  voices and **both are male** — there is no AU female voice in the catalogue. British
  reads far closer to Australian ears than American; Willa is a platform voice, so it
  keeps Expressive-Mode support and multi-provider fallback.
- `interruption_sensitivity`: 0.6 → **0.8**. Higher = she yields sooner. The old
  "0.7 self-interrupts" note came from a build **with `ambient_sound`**, which was
  removed long ago (the coffee-shop track was being transcribed as caller speech).
  `assert-agent.mjs` updated to match, with the revert trigger recorded.
- `reminder_trigger_ms`: 18000 → **10000**, `reminder_max_count`: 1 → **2**. The 25-second
  silence was one 18s reminder arriving far too late.

**LLM** (`PATCH /update-retell-llm`, 12,476 → 13,257 chars):
- **Never list more than three things.** Name two or three, stop, ask.
- **If they answer while you're talking, stop and take it** — their answer beats
  finishing the sentence.
- **Say the tool aside only as you actually call the tool.** Never announce "one moment"
  and then wait; if there's nothing to run, ask the next question.
- **`check_payment_status` registered** (8 tools now) — she can answer "did that go
  through?" instead of saying she can't see it.

## Read-back evidence (pasted, not summarised)

```
READ-BACK OK
  voice_id           = retell-Willa
  interruption_sens  = 0.8 (was 0.6 — she talked over the caller 3x)
  reminder_trigger   = 10000 ms x 2 (was 18000 x1 — 25s of dead air)
  invariants: speed 0.92 | fillers False | stt fast | backchannel ['yeah','right','no worries']

READ-BACK: prompt 13257 chars | 8 tools | check_payment_status registered
  ok: no-monologue rule / listen-over-me rule / no-dead-air rule / payment-status rule
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

## Voice is a taste decision — alternatives to audition

| voice_id | accent | age | preview |
|---|---|---|---|
| `retell-Willa` ← applied | British | Middle Aged | minimax-Willa.mp3 |
| `retell-Maren` | British | Young | minimax-Maren.mp3 |
| `11labs-Dorothy` | British | Young | Dorothy.mp3 |
| `11labs-Amy` | British | Young | Amy.mp3 |

(all under `https://retell-utils-public.s3.us-west-2.amazonaws.com/`)

## Verification still owed

A call that: hears Willa; gets interrupted mid-list and stops; has no silence after an
aside; and answers "has my payment gone through?" from the tool.

## Rollback

Re-apply `../20260826-voice-and-listening-pre/` — one PATCH per object.
