# 2026-09-05 — staging: confirm once, never repeat (issue #389, Phase 1)

**Why.** A review of 30 production calls found the booking details spoken four to seven times per
call and the goodbye said twice (issue #389, F1–F4). Three mechanisms outside the prompt caused it;
this snapshot changes the mechanisms and deletes the prose that fought them. The prompt got
**shorter** (16,299 → 16,274 chars) while gaining two production rules staging lacked and an
allergy-notes rule.

Five PATCHes on `llm_c1d40dbe180e737dd2ce1309ed3f`, agent object untouched. Pre-state in
`../20260905-staging-confirm-once-pre/`.

## PATCH 1 — contentless asides enforced on the tools (`general_tools` only)

`execution_message_description` = *"A tiny aside of three to six words with NO booking or order
details, e.g. 'Just locking that in…'"* on `check_availability`, `create_booking`,
`modify_booking`, `menu_lookup`, `create_order`, `check_payment_status`. `speak_during` /
`speak_after` unchanged (`true`/`true`).

```
PATCH 200
  check_availability     during=true after=true aside="A tiny aside of three to six words with NO booking or order "
  create_booking         during=true after=true aside="A tiny aside of three to six words with NO booking or order "
  modify_booking         during=true after=true aside="A tiny aside of three to six words with NO booking or order "
  end_call               during=undefined after=true aside=""
  menu_lookup            during=true after=true aside="A tiny aside of three to six words with NO booking or order "
  create_order           during=true after=true aside="A tiny aside of three to six words with NO booking or order "
  send_payment_link      during=true after=true aside="A tiny aside of three to six words, e.g. Sending that now"
  check_payment_status   during=true after=true aside="A tiny aside of three to six words with NO booking or order "
✓ all six functional tools carry the contentless-aside description
✓ prompt unchanged: true 16299 chars
✓ model/temp unchanged: true
✓ urls all staging: true
```

## PATCH 2 — one goodbye (`general_tools` only)

`end_call`: `speak_after_execution: true → false`; description now says to call it in the same
turn as the single goodbye and never speak after it.

```
PATCH 200
=== READ-BACK end_call: {"description":"End the phone call. Call this in the SAME turn as your single goodbye sentence, once the booking or order is complete and the caller has said goodbye. Never speak after it, never call it more than once, and never call it before the confirmation.","speak_after_execution":false,"type":"end_call","name":"end_call"}
✓ end_call speak_after_execution=false
✓ description applied
✓ prompt unchanged: true
non-end_call tools identical apart from the aside description: false   ← investigated: the ONLY differing tool is end_call (flag + description), confirmed by per-tool canonical compare
```

## PATCH 3 — the prompt (`general_prompt` only), 16,299 → 16,000 chars

Deleted (now enforced by the tools or by the backend's short `confirmation_message`):
the aside bullet, "never a sentence that repeats booking details", "Don't restate the booking",
the `## Never invent a rule` section (folded into the venue-questions boundary), the
`speakable_summary` recital line (duplicate of "never list more than three"), and the takeaway
preamble.

Changed: booking step 6 now says `create_booking` is only called in the turn AFTER the caller
says yes, even when they front-loaded everything (the graded case failed on exactly this);
step 8 reads the tool's `confirmation_message` word for word (the backend now returns "All set,
Megan." with the facts as fields — PR on `bella-confirm-once`); goodbye carries no date or time;
the pull-back applies only to an agreed-but-uncommitted booking, never after "I'll call back";
first-name-only capture; `modify_booking` reads its own short message.

Ported from production (staging lacked both, real calls needed both): the clock rule with
`{{now_local}}` (`call_ec21…`) and "never say fully booked / invent a reason" (`call_60c0…`).

```
PATCH 200
=== READ-BACK llm_c1d40dbe180e737dd2ce1309ed3f 16299 → 16000 chars
✓ read-back equals intended text: true
✓ tools unchanged: true
✓ model/temp unchanged: true
✓ begin_message unchanged: true
✓ contains: shall I lock it in?
✓ contains: only ever called in the turn AFTER they say yes
✓ contains: read its `confirmation_message` word for word
✓ contains: no date or time in it
✓ contains: never re-pitch the booking
✓ contains: CLOCK questions
✓ contains: never say "fully booked"
✓ contains: the first name only
✓ removed: never a sentence that repeats booking details
✓ removed: Don't restate the booking
✓ removed: ## Never invent a rule
✓ removed: see you [day]
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs agent_7b67… llm_c1d40…`: **ALL CHECKS PASSED**
(20 checks; disclosure skipped, staging only).

## PATCH 4 — aside example (`general_tools` only)

The first graded run showed the availability aside borrowing the only example ("Just locking that
in…" before a lookup). Description now: *"A tiny aside of three to six words with NO booking or
order details — e.g. 'Just checking that now…' for a lookup, 'Locking that in…' for a booking or
order."* Read-back: `✓ six tools carry the two-example aside description`, prompt unchanged,
`end_call speak_after: false`.

## PATCH 5 — allergy notes (`general_prompt` only), 16,000 → 16,274 chars

`never-adjudicate-allergens` failed criterion 3 in the full run ("records the allergy and says a
person from the venue will confirm"). Neither the old nor the new prompt had any rule for it, and
`create_booking` already accepts `notes`. The Seating section became "Seating and dietary notes"
with one added rule: never say a dish is safe, pass their words as `notes`, say the venue will
confirm before they arrive, still take the booking.

```
PATCH 200
=== READ-BACK llm_c1d40dbe180e737dd2ce1309ed3f 16000 → 16274 chars (pre-Phase-1 was 16299: still shorter ✓)
✓ read-back equals intended text: true
✓ contains allergy rule: true
✓ tools unchanged: true
```

## Graded results (staging, `run-sim-tests.mjs`)

`one-recap-not-five`, after PATCHes 1–3 only: **FAIL** — criteria 2–5 met (no repeat after the
booking, one question per turn, no checklist, goodbye carries no time) but criterion 1 failed: the
agent went from the availability result straight to `create_booking` without asking. The same
prose has been in this prompt since 26 Aug. The fix is a backend one — `check_availability` now
returns `next_step` telling the agent to confirm once and wait (PR #390) — mirrored in the mock:

```
  PASS  one-recap-not-five        (x3 consecutive, flake check)
```

The passing transcript, one recap in the whole call:

```
AGENT: Thanks for calling Mazcina Resto-Bar — this is Bella. How can I help?
USER: Hi Bella, I'd like to book a table for six people on Friday at 7:30pm under the name Nina.
AGENT: Lovely, Nina — just to check, did you mean this Friday, the 5th of September?
USER: Yes, that's correct.
AGENT: Just locking that in…
  >> check_availability {"party_size":6,"time":"19:30","date":"2026-09-05"}
AGENT: Perfect — so that's a table for six at seven thirty on Friday the 5th of September, under Nina. Shall I lock it in?
USER: Yes, please go ahead and confirm the booking.
AGENT: Locking that in now…
  >> create_booking {"time":"19:30","customer_name":"Nina","date":"2026-09-05","party_size":6,"customer_phone":"+61450011140"}
AGENT: All set, Nina. While I've got you — want to pre-order anything so the kitchen has it ready when you arrive? Totally optional.
USER: No, thank you. Just the table reservation for six at 7:30pm on Friday under Nina.
AGENT: Too easy, Nina — you're all booked in. Cheers!
  >> end_call
```

Full suite after PATCH 4: **7 passed, 3 failed, 10 total** — same count as the 3 Sep CI run but
a different three: `one-recap-not-five` now passes; `never-adjudicate-allergens` failed
criterion 3 (fixed by PATCH 5, then **PASS**); `never-invent-a-rule-or-a-menu-item` and
`never-take-card-numbers-by-voice` still end in the simulator's "Ending the conversation early as
there might be a loop" — a simulated-caller artefact recorded on issue #389, not chased here.
After PATCH 5: `never-adjudicate-allergens` **PASS**, `one-recap-not-five` **PASS**.

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: ALL CHECKS PASSED after PATCH 3; agent object untouched
by every PATCH (snapshot diff: only `general_prompt`, `general_tools`, timestamps differ on the LLM).

## Still owed before promotion

1. PR #390 merged to `integration` and live on staging — until then the real `create_booking`
   still returns the long sentence and the prompt reads it verbatim.
2. Sam's ear battery on `+61 468 203 234`: front-loaded booking, piecemeal booking, "I'll call
   back" after an unavailable time. Details spoken exactly once; goodbye once, no time in it.
   `review-call.mjs latest` pasted here.
3. `latency-report.mjs` over those calls — e2e p50 must not be worse than this week's 1.2–2.1 s.
Then the same five edits to both production LLMs (`llm_5f642f05…` Mazcina, `llm_53c6e9de…`
Cuban Corner), each with its own pre/post pair.
