# Mazcina production — greeting drops the AI phrase; Bella stops inventing "fully booked"

**Date:** 31 August 2026
**Agent:** `agent_b6b6488af08b82d80e8f4d270a` (Mazcina Resto-Bar (production))
**LLM:** `llm_5f642f051bb83c28d02cea4e1cbc` — one PATCH, two fields
**Pre-snapshot:** `../20260831-mazcina-greeting-pre/`

Both changes are text-only, on the LLM object, and independently observable by ear.

---

## 1. Greeting — "an AI assistant" removed, recording disclosure kept

Requested by the venue owner. **Only the AI half was removed.**

```
before: Thanks for calling {{restaurant_name}} — this is Bella, an AI assistant.
        This call's recorded so I can take your booking. How can I help?
after:  Thanks for calling {{restaurant_name}} — this is Bella.
        This call's recorded so I can take your booking. How can I help?
```

The two halves are not equivalent. **Recording** carries statutory weight — NSW
Surveillance Devices Act 2007, the subject of `deploy/runbooks/legal-brief-call-recording.md`
— so it stays, and there is no per-line waiver for it. **AI disclosure** has no Australian
statutory mandate today.

Checked before applying: **Mazcina has zero rows in `agreement_acceptances`**, so there is no
signed certification that an AI announcement is made. A venue that *has* signed must not get
this waiver without re-papering that clause first.

⚠️ **Still open:** the legal brief was sent 3 Aug 2026 and none of its six questions has a
recorded answer in this repo — including Q3 (is the certification model salvageable, given
only we control the greeting) and Q5 (the "regulars won't know she's AI" marketing claim).
This change makes Q5 more live, not less.

### The check was made narrower, not looser

`assert-agent.mjs` asserted AI and recording as one production gate. Rather than leave check
14 permanently red — a red check nobody can fix is one everyone stops reading, and
`voice-line-health.yml` runs hourly — the two are now asserted separately:

- recording: required on every production line, no waiver
- AI: waivable **per line**, declared as `greeting_ai_disclosure: false` in
  `deploy/voice-lines.json`, plumbed through as `ALLOW_NO_AI_DISCLOSURE`

Verified narrow: Cuban Corner declares no waiver, still carries the phrase, still passes —
and would now fail if it were removed there.

---

## 2. Prompt — never invent a reason a time is unavailable

Call `call_60c0dbaab2ca19b4cb145bdf307` (31 Aug, 14:35 Sydney), party of two at 8 PM:

> **Agent:** looks like eight o'clock is fully booked tonight…
> **User:** Why is eight PM booked? Can you give me the reason?
> **Agent:** it just means all the tables are already reserved for eight o'clock tonight

**There were zero reservations.** Ten active tables, none booked.

The real cause is arithmetic: `booking_duration_minutes` is 90, Monday closes at 21:00, so a
sitting from 20:00 ends 21:30 and `isWithinOpeningHours` rejects it. Every offset the caller
was offered (19:30, 19:00, 18:30, 18:00) is exactly the set that fits. The backend was right;
`availabilityService.ts` returned `no_availability` with alternatives and **no stated reason** —
and the agent filled the gap with a confident, false one.

The prompt already warned about this for closed *days* ("would leave the caller thinking we're
full rather than shut"). It said nothing about the last-seating case. Step 3 of **Taking a
booking** now does: she may offer the alternatives, must not name a cause, and if asked why
must say she cannot see the reason.

**Not fixed here, deliberately:** the backend still cannot distinguish "genuinely full" from
"past last seating". Giving it a distinct reason so Bella can say *"a 90-minute sitting
wouldn't finish before we close at 9"* is the better fix and was deferred to keep this
shippable today without a deploy. Whether 20:00 should be bookable at all is the owner's
call, not a bug.

---

## Read-back (from `get-retell-llm`, not the write response)

```
✓ greeting no longer discloses AI
✓ greeting STILL discloses recording (legal)
✓ greeting still de-venued
✓ prompt forbids "fully booked"
✓ prompt states she cannot know the reason
✓ no venue name in prose
```

`assert-line.mjs +61468202846 --strict` → **All checks passed** (17/17).

## Rollback

One PATCH restoring both fields from the pre-snapshot:

```
PATCH /update-retell-llm/llm_5f642f051bb83c28d02cea4e1cbc
      begin_message + general_prompt from ../20260831-mazcina-greeting-pre/llm.json
```

Then drop `greeting_ai_disclosure` from the Mazcina line in `deploy/voice-lines.json`.

## Unproven

No call has been placed since either change. Both need an ear test — and the line is also
awaiting its first call since the AU1→US1 trunk cutover earlier the same day.
