# Conversational Quality & Human Interaction Patterns

Most restaurant agents fail here. Not by taking the order wrong — by taking it *correctly* while
sounding like a form being read aloud. An experienced staff member captures information once,
acknowledges it briefly, and moves on. This file is how to get that.

This is the **experience** file. The **safety** obligations — never promise an action you are not
taking, yield when the caller answers, announce good news once, disclose discrepancies — live in
[conversation-contract](conversation-contract.md) and are not negotiable for the sake of style.

## Contents
- [First: repetition is caused by rules, not missing rules](#first-repetition-is-caused-by-rules-not-missing-rules)
- [The prompt budget](#the-prompt-budget)
- [The seven patterns](#the-seven-patterns)
- [The repetition audit](#the-repetition-audit)
- [Required tests](#required-tests)

---

## First: repetition is caused by rules, not missing rules

The instinct is to add *"do not repeat yourself"*. It does not work, and it makes the agent slower.

> A caller interrupted with **"you don't have to repeat again and again."** The booking details had
> been stated **five times** in one call. The cause was **five separate prompt instructions each
> asking for a recap** — at the name step, after the availability check, at the formal confirmation,
> inside a tool aside, and again after the booking landed. Every one was individually defensible.
>
> The fix **deleted four and merged one**. The prompt got *shorter*. A "do not repeat" rule added on
> top would have been arguing with five live instructions, and lost.

**Diagnose before prescribing.** When an agent repeats itself, find the instructions telling it to.
There are usually several, added at different times, each solving a real problem in isolation.

---

## The prompt budget

Every rule costs tokens on every turn, and prompt length is a latency lever — so a quality section
that only adds rules makes the agent slower in order to make it sound faster.

**Rule: each pattern must name what it replaces. The section is net-neutral or negative.**

Four techniques, cheapest first:

| # | Technique | Cost | Example |
|---|---|---|---|
| 1 | **Delete the instruction causing the behaviour** | *Negative* | Five recap instructions → one |
| 2 | **Move behaviour into tool responses** | Zero | A tool returning a short acknowledgement plus structured data gives the model nothing to recite; one returning a full recap *invites* one |
| 3 | **Put it in the tool description** | Zero prompt | The model reads those too — list bounds belong in both |
| 4 | **One principle replacing several rules** | Small net saving | "State the details once, at the confirm step" subsumes five |

> **Technique 2 is the one people skip.** The model recites what it is handed. Prompt restraint asks
> it to ignore something in front of it; response design means there is nothing to ignore. The
> announce-once guarantee became reliable only when the *tool* returned a flag — the prompt version
> had been asking politely and losing.

---

## The seven patterns

Each: the rule · the evidence · what it **replaces** · the transcript signature that detects it.

### 1 · Anti-repetition — collect progressively, confirm once
**Rule.** Do not restate order contents, names, booking details, payment status or pickup times once
captured. Three exceptions, and only three: **it changed**, **they asked**, or **it is the single
pre-commit confirmation**.

**Evidence.** *Direct* — the five-recap call above.

**Replaces.** Every mid-flow recap instruction. Keep exactly one, at the commit point.

**Signature.** The same fact stated in full in more than one turn.

### 2 · Information compression — acknowledge, store, move on
**Rule.** On capture, acknowledge in a few words and carry on. The conversation state holds it; the
caller does not need it read back to know they said it.

*"Got it." · "Perfect." · "Thanks, I've got that."* — not the full order after every item.

**Evidence.** *Direct* — tool asides restated the entire booking mid-call; the fix capped asides at
a few contentless words.

**Replaces.** Read-back-after-each-item instructions. Also a **tool-response** change: return
acknowledgement plus structured data, not prose to recite.

**Signature.** Agent turns that end with a summary nobody asked for.

### 3 · Human conversation — brevity, confidence, forward progress
**Rule.** One or two short sentences per turn, then stop. Sound like someone who does this all day:
decisive, unfussy, not checking a form.

**Evidence.** *Direct* — a **23-second monologue** listing nine sections then five dishes, during
which the caller tried three times to say what they wanted and was talked over each time.

**Replaces.** Nothing to add — this is the bound already in
[menu-and-pricing](menu-and-pricing.md#the-lookup-contract) and
[conversation-contract](conversation-contract.md#2--bounded-lists-always), stated once as a
principle rather than repeated per surface.

**Signature.** Any single agent turn over roughly ten seconds of speech.

> **A long turn is also an interruption bug.** While the agent talks, the caller is answering. The
> monologue and the talking-over were one incident, not two.

### 4 · Conversation momentum — every turn advances
**Rule.** Every turn does one of: gather something missing · answer a question · move toward
completing the order, booking or payment. A turn doing none of these has spent the caller's time to
buy nothing.

**Evidence.** *Direct*, two kinds:
- **Asking for a field the flow does not have** — party size requested for a pickup, because the
  pickup path was borrowing a dine-in shape. See
  [ordering-workflows](ordering-workflows.md#the-six-shapes).
- **A turn spent on "are you still there?"** while the caller was paying — the one moment something
  useful could have happened. See
  [payment-monitoring](payment-monitoring.md#push-or-poll-the-decision).

**Replaces.** Filler-turn instructions. A silence turn should *do* something.

**Signature.** A turn that asks for a field the order shape does not have, or re-asks something
already captured.

### 5 · Final confirmation — one summary, at the commit point
**Rule.** The full summary happens **once**, immediately before the irreversible step: submitting
the order, committing the booking, or taking payment. Not before, not after.

**Evidence.** *Direct* — the availability read-back and the formal confirmation were separate
recitals of the same facts; merging them into one sentence removed a whole recap without losing the
check.

**Replaces.** Post-tool re-confirmations and pre-confirmation warm-ups.

**Signature.** A full summary that is not immediately followed by the commit.

### 6 · Escalating confidence — confirmations fall as certainty rises
**Rule.** Early, when the audio is unfamiliar and nothing is established, verify: *"two of those,
was it?"* Later, when the caller has been clear and the facts are held, acknowledge: *"Perfect."*
Confirmation frequency should **fall** through the call, never stay flat and never rise.

**Evidence.** ⚠️ *Derived* — generalised from patterns 1 and 5 rather than its own incident. Labelled
honestly: this framework's value rests on its claims being traceable, and one invented incident would
spend that.

**Replaces.** Uniform per-step confirmation instructions — the flat cadence that reads as a checklist.

**Signature.** Confirmation density constant or rising across the call; *"just confirming again"*.

### 7 · Measurable, not aspirational
Everything above is testable from a transcript. See [the repetition audit](#the-repetition-audit).
A quality rule nobody measures is a preference.

---

## The repetition audit

Automatable from any transcript, so these become regression tests rather than opinions.

**Method.** For each fact class, count the **turns in which the fact is stated in full** (a passing
mention is not a restatement). Then subtract the legitimate reasons:

- the caller changed it
- the caller asked for it
- the system returned something different from what was confirmed
- it is the single pre-commit confirmation

| Audit | Counts | Pass |
|---|---|---|
| repeated-order | Full item-list statements | 1 |
| repeated-name | Name echoed back in full | <=1 after capture |
| repeated-price | Totals or per-item prices stated | 1, at confirmation |
| repeated-payment | Payment status announced **as news** | Exactly 1 |
| repeated-booking-summary | Full date + time + party recitals | 1 |
| momentum | Turns that neither gather, answer, nor advance | 0 |
| turn-length | Longest single agent turn | Under ~10s of speech |
| acknowledgement-length | Median non-question agent turn | Short — a long median *is* checklist cadence |

> **Guard against the cure becoming the disease.** An agent that never repeats anything has moved
> the failure, not fixed it. When a caller **changes** a detail, the change must be confirmed — that
> is a required test, not an exception.

---

## Required tests

| # | Objective | Setup | Execution | Expected | Failure signal |
|---|---|---|---|---|---|
| 1 | repeated-order | Multi-item order | Complete it | Items stated in full once | Recap after each item |
| 2 | repeated-name | Any booking | Give a name | Echoed at most once | Name in every turn |
| 3 | repeated-price | Priced items | Ask once | Stated at confirmation | Repeated per item |
| 4 | repeated-payment | Pay mid-call | Complete | Announced once, then brief re-confirms | Repeated announcements |
| 5 | repeated-booking-summary | Full booking | Complete | One full summary, at commit | Multiple recitals |
| 6 | momentum | Any flow | Audit every turn | Each gathers, answers or advances | A turn doing none |
| 7 | no wrong-shape fields | Pickup order | Complete | Party size never requested | Dine-in field leaking |
| 8 | escalating confidence | Long clear call | Measure density | Falls across the call | Flat or rising |
| 9 | **change is confirmed** | Change a detail late | State the change | Confirmed once | Silently accepted |
| 10 | brevity | Ask what's available | — | No turn over ~10s | Monologue |
| 11 | prompt budget | Before/after the quality work | Compare prompt length | Net-neutral or shorter | Section added length |

**Test 9 is the counterweight.** Tests 1–8 push toward saying less; without 9 they push an agent past
terse into unreliable.
