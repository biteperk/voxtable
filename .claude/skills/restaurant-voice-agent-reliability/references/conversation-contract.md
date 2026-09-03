# Conversation Contract

Obligations the agent owes the caller, independent of voice engine. Engine-level turn-taking —
endpointing, interruption sensitivity, latency knobs — belongs to your voice-platform skill.

## Contents
- [The obligations](#the-obligations)
- [Ending a call](#ending-a-call)
- [Failure modes](#failure-modes)
- [Required tests](#required-tests)

---

## The obligations

### 1 · Never promise an action you are not taking
> An agent said "one moment…" and then ran nothing — **25 seconds of silence** before it spoke
> again. The caller had no way to know whether the line was dead.

Say the filler **only as you actually call the tool**. If there is nothing to run, ask the next
question instead. Silence after a promise is the worst thing a phone line can do, because the caller
cannot tell it from a dropped call.

Corollary: **a tool that returns must produce speech.** If your platform can run a tool without
generating a response afterwards, that setting is a dead-air bug waiting to happen — verify it on
every tool, and re-verify on any agent copied from another.

### 2 · Bounded lists, always
Name **two or three** things, stop, and ask. *A nine-item recital ran 23 seconds while the caller
tried three times to say what they wanted.* A caller cannot hold a long list, and while it is being
read they are trying to answer — so a long turn is also an interruption bug.

Put the bound in the tool description as well as the prompt. Brevity as a general habit is
[conversational-quality](conversational-quality.md#3--human-conversation--brevity-confidence-forward-progress).

### 3 · Their answer beats your sentence
If the caller says what they want **while the agent is talking**, stop and take it. Finishing the
sentence is never worth making someone repeat themselves — they repeated it three times in the
incident above.

### 4 · Say the difference when there is one
If the system returns something **different** from what was just confirmed — another time, a changed
detail, an older record returned by a replay — say the difference. Never read the original back as
though nothing moved.

This is the safety half of saying things once. The experience half — how often to restate what has
**not** changed — is [conversational-quality](conversational-quality.md#1--anti-repetition--collect-progressively-confirm-once),
which owns it so the rule lives in one place.

### 5 · Announce good news once
Enforced by [an atomic claim](payment-monitoring.md#f3--duplicate-announcement), not by prompt text.
Later checks re-confirm briefly rather than re-announcing.

### 6 · Never take card details by voice
**Interrupt the caller.** If someone begins reading a card number, cut in — politely, immediately,
before the digits are out — and route them to the link, the counter, or a callback.

This is the one place where obligation 3 is inverted: normally the caller's speech wins, but here
letting them finish is the harm. Say something that stops them without embarrassing them:

> *"Sorry — don't read me the card, I'm not able to take numbers over the phone. I'll text you a
> secure link instead."*

**Why it is a hard rule and not a preference.** Calls are recorded and transcribed. A card number
spoken aloud lands in an audio file, a transcript, a model context and very likely a log — none of
which are built to hold it. That is a payment-data incident with mandatory obligations attached,
and it is caused by *listening*, not by anything the agent says.

Three consequences worth building for:

- **Never ask a question whose natural answer is a card number.** "How would you like to pay?" is
  safe only when the offered options are named: link, or on arrival.
- **The agent must never repeat digits back**, in any framing, including a clarifying question.
- **Detect it after the fact too.** Scan transcripts for long digit runs; a hit means the interrupt
  came too late, and the recording needs handling regardless of what the agent did next.

Cardholder-data obligations are jurisdictional and contractual — see **Boundaries**. The rule above
is the floor, not the compliance programme.

---

## Ending a call

**Both halves are required. Neither substitutes for the other.**

```
Agent-initiated close
  └── outstanding state? ──yes──► resolve it, say the true outcome, then close
                          └─no──► one short close

Caller hangs up  ──────────────►  NO PROMPT RUNS AT ALL
  └── server-side reconciliation on the call-ended event
      ├── outstanding payment?  log unresolved, clear the watcher
      ├── partial order?        log it
      └── nothing outstanding?  no-op
```

> The prompt makes the **caller's experience** right. Only the server makes the **record** right.
> Anything that depends on the agent reaching the end of the call is not a guarantee — a hang-up
> reaches nothing.

**One goodbye.** Say it, then end. Do not say it twice, and do not reopen after saying it.

**A goodbye before the business is finished** gets a gentle pull-back — *"before you go, just
confirming…"* — but **only when the business is genuinely unfinished**. After confirmation, a
goodbye is a goodbye.

---

## Failure modes

### F1 · Promise then silence
Obligation 1. Detected by gap analysis on the transcript: a promise followed by no tool call and no
speech.

### F2 · Monologue
Obligation 2. Detected by the length of a single agent turn.

### F3 · Talking over the caller
Partly engine tuning (your voice skill), partly obligation 3 — but note the interaction:
**a long turn creates the opportunity.** A monologue and interruption problems are one incident.

### F4 · Repetition
Owned by [conversational-quality](conversational-quality.md#the-repetition-audit), which carries the
audit and its thresholds.

### F5 · Unresolved ending
See [Ending a call](#ending-a-call). Detected by reconciliation logs, never by the transcript —
which is exactly why the server-side half exists.

### F6 · Reminder turns wasted
Most platforms hand the agent a turn after caller silence. Spending it on "are you still there?"
wastes the one moment something useful could happen — see
[payment monitoring](payment-monitoring.md#push-or-poll-the-decision).

### F7 · Card number spoken aloud
Obligation 6. **Detected by** a digit-run scan over transcripts, not by listening. A hit is an
incident to handle, not only a rule to tighten — the data already exists in the recording.

---

## Required tests

| # | Objective | Setup | Execution | Expected | Failure signal |
|---|---|---|---|---|---|
| 1 | No dead air | Any tool-using flow | Review transcript timing | No gap >3s after a promise | A silent gap |
| 2 | Bounded lists | Menu with many sections | Ask what's available | ≤3 named, then a question | Long recital |
| 3 | Yields to the caller | — | Answer while it speaks | Stops, takes the answer | Finishes, caller repeats |
| 4 | Details once | Full booking flow | Count occurrences | Exactly one full statement | Multiple recaps |
| 5 | Discrepancy spoken | System returns a different value | Complete the flow | Difference stated | Original repeated |
| 6 | One goodbye | — | Close | One close, then ends | Repeated farewells |
| 7 | Resolve before close | Payment outstanding | Let the agent close | Resolved first, true outcome | Ends ambiguous |
| 8 | Hang-up reconciled | Payment outstanding | **Hang up** | Server logs unresolved, state cleared | Nothing recorded |
| 9 | Card details refused | — | Begin reading a card number | Interrupts before the number completes, offers link or counter; **no digits repeated** | Any digit run in the transcript |
