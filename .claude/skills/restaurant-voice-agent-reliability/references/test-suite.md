# Production Test Suite

## Contents
- [Doctrine](#doctrine)
- [The thirteen suites](#the-thirteen-suites)
- [Voice tests: the battery](#voice-tests-the-battery)

---

## Doctrine

Six rules. Each was learned by having a test that gave false confidence.

### 1 · A new test must fail against the code it replaces
Run it against the old implementation first and watch it go red. A test that passes before and after
**documents** behaviour; it does not **verify** it.

### 2 · A checker nobody has seen fail is a green light, not a check
Prove your checkers can fail: corrupt the input deliberately and require the failure. An assertion
that has only ever passed is indistinguishable from one that always passes.

### 3 · Test the round trip the caller performs
> A store's own tests passed while the code using it was broken — a property read that did not
> exist. Two live calls looked healthy. **The unit was right and the wiring was wrong.**

Test through the boundary the production code actually crosses.

### 4 · Test the wiring, not the arithmetic
Pure functions get unit tests. What is rarely covered — and where incidents live — is whether the
**flow consults them and acts on the answer**.

### 5 · Every test builds and destroys its own world
No shared fixtures, no dependence on seed data. A real venue's data must never carry test fixtures,
and coverage must not evaporate when someone tidies the seeds.

### 6 · Design the fixture so the bug cannot hide
> A duplicate-booking test with **one** table passes even when broken, because the overlap
> constraint catches what the logic missed. It needs **two** — then the retry can find different
> capacity and commit, which is the actual bug.

Ask: *what fixture would let this bug survive?* Then avoid it.

**Credential-free by construction.** Swap external gateways for counting fixtures. Then replay,
idempotency and state-machine guarantees are provable offline, in CI, on every commit.

---

## The thirteen suites

Each entry: **objective · setup · execution · expected · failure signal**.

### 1 · Payment
See [payment-monitoring](payment-monitoring.md#required-tests) — 13 tests. Non-negotiable:
source-of-truth read, three states, concurrent announce-once, **counter advances**, ceiling fires,
amount mismatch, abandoned call.

### 2 · Ordering
See [ordering-workflows](ordering-workflows.md#required-tests) — 11 tests. Non-negotiable: retry
cannot duplicate (two-table fixture), concurrent retries, second genuine order, overlap impossible.

### 3 · Takeaway / pickup
- **Accepted while open** · venue open, ready-by soon · place a pickup order · accepted, no capacity
  consumed · *refused, or a table consumed*
- **Near closing** · ready-by shortly before close · place it · accepted · *refused on dine-in duration*
- **While closed** · outside hours · request now · declined **citing hours**, next opening offered ·
  *invented reason, or accepted*
- **No party size asked** · — · complete a pickup · never asked · *dine-in model leaking*

### 4 · Booking
Overlap, capacity ceiling vs busy, solo diner, modification re-validation, cancellation idempotency,
duration snapshot, late-night arithmetic.

### 5 · Menu
See [menu-and-pricing](menu-and-pricing.md#required-tests) — 12 tests. Non-negotiable: unavailable
refused not swapped, unavailable not offered, nonsense rejected, near-miss kept, prices speakable.

### 6 · Hallucination
See [anti-hallucination](anti-hallucination.md#required-tests) — 11 tests. Mostly **live-call
tests**; they cannot be automated, so they belong in the pre-launch battery.

Two exceptions that **are** automatable from a transcript, and should run on every call rather than
once before launch:
- **No fact before its tool** — assert every availability or price claim carries a later timestamp
  than the tool call establishing it. Ordering, not correctness: a right answer spoken early still
  fails.
- **Safety never adjudicated** — assert no assurance pattern ("is gluten free", "that's safe",
  "no nuts in that") appears in any agent turn.

### 7 · Latency
- **Budget** · normal flow · measure per-turn response · p50 within budget · *over budget*
- **Attribution** · one change at a time · measure after each · the mover is identified · *three
  changes, cause unknowable*
- **Tool cost** · flows with and without a tool call · compare · the difference is the tool's cost ·
  *unmeasured*

Method: measure **before and after every change**, one lever at a time. Never claim an improvement
without a measurement.

### 8 · Voice
See [the battery](#voice-tests-the-battery). Human-judged, not automatable.

### 9 · Concurrency
- Two simultaneous identical tool calls → one effect
- Two callers, same last slot → one wins, the other gets a friendly message
- Two announcements racing → exactly one
- Cancel racing settlement → recorded, alerted, never fulfilled
- Retry during a lock wait → blocks, then sees the committed result

### 10 · Webhooks
- **Replay** · deliver the same event twice · applied once · *double application*
- **Out of order** · a late "settled" after a refund · no-op · *resurrection*
- **Not ready** · event before its row commits · **fail so it retries** · *acknowledged and lost*
- **Not ours** · a foreign event · ignored, acknowledged · *error, or misapplied*
- **Bad signature** · tampered · rejected · *accepted*
- **Unattributable** · valid, no matching record · logged for eyes · *dropped*

### 11 · Failure recovery
- External provider down at link creation → spoken fallback, no crash
- Provider down mid-call → agent offers the human path
- Datastore unavailable → fail safe, nothing half-written
- Worker crash mid-batch → resumes, no duplicates, no lost rows
- Missed webhook → reconciler settles it within its window
- Retry budget exhausted → dead-lettered and alerted, not looping

### 12 · Conversational quality
See [conversational-quality](conversational-quality.md#required-tests) — 11 tests, all runnable
against a transcript. Non-negotiable: the five repeated-X audits, momentum, and **test 9 (a changed
detail is confirmed)**, which is the counterweight stopping terse from becoming unreliable.

Also the **prompt budget** check: the quality work must leave the prompt the same length or shorter.
Repetition is caused by instructions, so the fix is usually deletion.

### 13 · End of call
See [conversation-contract](conversation-contract.md#required-tests) — 9 tests. Non-negotiable:
resolve before close, and **hang-up reconciled server-side**.

Run the **digit-run scan** over every transcript as part of this suite: a run of 13–19 digits means
a card number reached the recording. That is an incident to handle, not merely a test to fail.

---

## Voice tests: the battery

Human-judged, run before any launch and after any agent change. Ten minutes.

| # | Scenario | Pass |
|---|---|---|
| 1 | Greeting | Answers promptly; required disclosures present |
| 2 | Simple question answerable from data | Answered immediately, **no tool call** |
| 3 | Closed-day request | Refused instantly with the real reason and the next opening |
| 4 | Happy-path booking | Details spoken **once**, correctly |
| 5 | Interrupt mid-sentence | Stops, takes the answer |
| 6 | Ask what's available | Two or three named, then a question |
| 7 | Order something switched off | Refused **by name**, alternative offered |
| 8 | Ask a price | Spoken as money |
| 9 | Ask for something not on the menu | Told plainly, no unrelated suggestion |
| 10 | Ask something with no policy | Offers a callback, invents nothing |
| 11 | Pay, then **stay silent** | Notices unprompted, announces once |
| 12 | Take a link, never pay | Bounded checks, alternative, **stops** |
| 13 | Ask twice "did it go through?" | Announces once, then re-confirms |
| 14 | Ask it to read the link aloud | Refuses |
| 15 | Withhold caller ID | Asks for a number digit by digit |
| 16 | Hang up mid-payment | *(silent)* reconciliation logged |
| 17 | Goodbye | One close, then ends |

**Record the results.** An empty battery table is not a pass — it is an untested agent. Treat
"machine checks green" and "the battery has rows" as two separate gates.
