---
name: restaurant-voice-agent-reliability
description: The canonical framework for building, hardening and operating restaurant voice agents that take bookings, orders and payments over the phone. Use when designing or reviewing any part of a phone-ordering agent — payment confirmation, order state, menu lookup, price presentation, cancellations, confirmations, idempotency, concurrency — and whenever an agent misbehaves in production: it quoted a wrong price, invented a policy or a rule the business does not have, substituted a different dish, told a guest their payment had not arrived when it had, announced the same thing twice, refused something it should allow, promised an action it never took, or ended a call leaving state unresolved, sounded robotic, repeated itself, or talked in long-winded checklists. Also use before launching a new restaurant, when writing tests for agent behaviour, when deciding what to log, when an agent works in one environment but not another, and when an incident needs a rule that prevents recurrence rather than a one-off patch. Every rule here was paid for by a real call, a real payment or a real outage — read it before designing, not after the incident.
---

# Restaurant Voice Agent Reliability Framework

A phone agent that takes money is a distributed system with a human on hold in the middle of it.
Everything here was learned by getting one wrong in production.

**Scope.** This framework owns everything *above* the voice engine: payments, orders, menu and
price contracts, hallucination control, conversation obligations, observability, testing and
deployment. Voice-engine tuning — endpointing, interruption sensitivity, latency knobs, telephony —
belongs to your voice-platform skill. See **Boundaries**.

---

## The doctrine

Ten principles. Each exists because its absence caused a specific failure.

### 1. State over prompts
An instruction to the model is a **request**. A database constraint is a **guarantee**.

Anything that must happen exactly once — announcing a payment, placing an order, sending a link —
is decided by the datastore, not by asking the model nicely. *A guest heard a payment confirmed
twice because "say it once" lived in a prompt; it became correct only when the announcement was an
atomic claim that cannot be won twice.*

**Test:** can you make the model misbehave and still get the right outcome? If not, it is a prompt
rule pretending to be a guarantee.

### 2. Database truth over model assumption
Prices, availability, opening hours and order contents are read from the system of record at the
moment they are used. The model may **relay** them; it may never **derive, recall or compute** them.

*An agent handed a price in minor units read the integer aloud — quoting a $1.50 item at fifteen
cents. It converted correctly most of the time, which is worse than never: an arithmetic step the
model can skip is one it eventually will.*

### 3. Never let the model do work the system can do
Every computation you hand the model is a coin flip you have chosen to run on every call. Format
the price. Resolve the date. Decide the match. Give the model the finished sentence.

### 4. Deterministic behaviour over agent reasoning
Where a rule exists, encode it. The model improvises whenever the procedure is missing — and
improvisation is not a strategy, it is the absence of one, so it fails at the worst moment rather
than a random one. *An agent with no defined pickup flow improvised a booking three times (which
worked) and a fabricated policy once (which turned a customer away).*

### 5. Idempotency keyed on what the transport controls
Replay keys come from values the **transport** owns — a call id, a provider event id — never from
values the **model** supplies. *A guard keyed on an identifier the model could not know was dead on
the only path that needed it: a retried tool call booked a second table for one caller, and the
constraint could not catch it because the second booking did not overlap the first.*

### 6. Fail safe, and fail loud
An unresolvable request gets **no context**, never a default. *An unmapped inbound number that
falls back to a default tenant books a stranger's restaurant.* Silence is an honest outcome for a
misconfiguration; another venue's greeting is not.

### 7. Observability first — you cannot see what you do not emit
*A counter stuck at 1 made a safety ceiling unreachable. Two live calls looked perfectly healthy.
Every symptom of a stuck counter is invisible unless you read the counter.*

Emit state transitions, not just errors. If a rule has a limit, log the count.

### 8. A document may only claim what a read-back printed
Write the configuration, then **read it back and assert it**. Never trust the write response.
*A change record said "applied to both agents" when it had reached one; the correction was itself
wrong because it was read with the wrong credentials. Two false verdicts in one file.*

A register records **intent**. Only a probe records **reality**.

### 9. One lever per change, and never claim a win without a measurement
Change one thing, measure, then decide. *Three simultaneous changes made a latency regression
unattributable until they were separated; the cause turned out to be one setting worth ~35% of
response time.*

### 10. Progress over confirmation
Every turn either gathers something missing, answers a question, or advances toward completion. **A
turn that restates what both parties already know has spent the caller's time to buy nothing.**

*A caller interrupted with "you don't have to repeat again and again" — the same details had been
stated five times, by five separate prompt instructions each individually defensible.* Agents fail
here while remaining perfectly correct, which is why it needs a principle rather than a style note.

---

## Failure taxonomy — the index

Every class below actually happened. Follow the link for the architecture, the failure modes and
the tests.

| Class | Symptom the human sees | Owner |
|---|---|---|
| Stale payment read | "You haven't paid" seconds after they paid | [payment-monitoring](references/payment-monitoring.md) |
| Two-state payment model | An in-flight payment reported as failed → guest pays twice | [payment-monitoring](references/payment-monitoring.md) |
| Duplicate announcement | The same good news twice | [payment-monitoring](references/payment-monitoring.md) |
| Unreachable safety ceiling | Agent polls forever | [payment-monitoring](references/payment-monitoring.md) |
| Abandoned mid-payment | Call ends, nobody knows a payment was in flight | [payment-monitoring](references/payment-monitoring.md) |
| Silent substitution | Ordered one dish, charged for a cheaper one | [menu-and-pricing](references/menu-and-pricing.md) |
| Nonsense match | Asked for X, offered an unrelated Y | [menu-and-pricing](references/menu-and-pricing.md) |
| Internal representation spoken | Price read as raw minor units | [menu-and-pricing](references/menu-and-pricing.md) |
| Retry duplication | One request, two bookings or two orders | [ordering-workflows](references/ordering-workflows.md) |
| Missing flow → improvisation | Correct refusal, invented reason | [anti-hallucination](references/anti-hallucination.md) |
| Invented policy | Agent states a business rule that does not exist | [anti-hallucination](references/anti-hallucination.md) |
| Premature promise | "I've noted that" for something the system rejected | [anti-hallucination](references/anti-hallucination.md) |
| Fact spoken before its tool ran | Availability confirmed before it was checked — right by luck | [anti-hallucination](references/anti-hallucination.md) |
| Safety adjudicated | Agent tells a caller a dish is safe for their allergy | [anti-hallucination](references/anti-hallucination.md) |
| Promise then silence | "One moment…" followed by dead air | [conversation-contract](references/conversation-contract.md) |
| Unresolved ending | Call ends with state neither confirmed nor declined | [conversation-contract](references/conversation-contract.md) |
| Card number spoken aloud | Payment data lands in a recording, transcript and logs | [conversation-contract](references/conversation-contract.md) |
| Repetition | "You don't have to repeat again and again" | [conversational-quality](references/conversational-quality.md) |
| Checklist cadence | Correct, thorough, and exhausting to talk to | [conversational-quality](references/conversational-quality.md) |
| Stalled momentum | A turn that asks nothing and advances nothing | [conversational-quality](references/conversational-quality.md) |
| Cross-environment leak | Works in one environment, silently wrong in another | [deployment](references/deployment.md) |

---

## Definition of done

A restaurant agent is not ready until **all** of these hold.

**Machine-checkable**
- [ ] Every money-affecting read comes from the primary system of record, never a replica.
- [ ] Payment state has at least three values: not started, in flight, settled. Two is a bug.
- [ ] Every exactly-once action is enforced by an atomic claim, not by prompt text.
- [ ] Every replay key derives from a transport-controlled identifier.
- [ ] Unavailable items are visible to the matcher and **refused**, never substituted.
- [ ] No internal representation (minor units, enums, ids, URLs) is reachable by the model.
- [ ] Every limit is counted, and the counter is asserted by a test that fails without it.
- [ ] Every new state key has a retention sweep registered in the same change.
- [ ] Ending a call reconciles outstanding state **server-side**, not only by prompt rule.
- [ ] Transcripts are scanned for long digit runs; a hit is treated as a payment-data incident.

**Behavioural — requires real calls**
- [ ] Order something switched off → refused with the real reason, never swapped.
- [ ] Ask for something not on the menu → told plainly, not offered an unrelated item.
- [ ] Ask for a price → spoken as money.
- [ ] Ask for something outside policy → the true constraint, never an invented one.
- [ ] Every availability or price claim **follows** the tool that established it — checked by
      transcript ordering, not by whether the answer was right.
- [ ] Ask whether a dish is safe for an allergy → recorded and escalated, never adjudicated.
- [ ] Begin reading a card number → interrupted before it completes, no digits repeated.
- [ ] Pay while silent → noticed unprompted, announced once.
- [ ] Never pay → bounded checks, then a graceful alternative, then it stops.
- [ ] Hang up mid-payment → the record shows it, without the model's help.
- [ ] Complete a full order → each fact stated in full **once**, at the commit point.
- [ ] Change a detail late → the change **is** confirmed. Terse must not become unreliable.

---

## How to use this framework

**Building a new restaurant:** start with [assets/new-restaurant-intake.md](assets/new-restaurant-intake.md).
Five inputs — menu, hours, ordering rules, payment rules, policies. Everything else comes from here.

**Diagnosing an incident:** find the class in the taxonomy, read that reference, and apply the rule
*and* its test. A fix without a test is a fix that returns.

**Reviewing a design:** walk the Definition of done. Anything unchecked is a known future incident.

---

## Boundaries

- **Voice-engine behaviour** — endpointing, interruption sensitivity, turn-taking latency, speech
  speed, filler and backchannel settings, audio quality, call forensics, telephony routing — belongs
  to your voice-platform skill, which holds the measured knob values for the engine you run. This
  framework deliberately names no vendor field, because the reliability rules outlive the vendor.
- **What this framework keeps from that world** is only the *method*: one lever per change, measure
  before claiming, and the perception law that **a slower agent reads as more robotic, not warmer** —
  so latency is a correctness concern, not a polish concern.
- **Legal obligations** — recording disclosure, payment regulation, data residency — are
  jurisdictional. This framework tells you *where* a disclosure must sit in the flow; your counsel
  tells you what it must say.

## References

- [payment-monitoring.md](references/payment-monitoring.md) — watcher state machine, push-vs-poll, twelve payment failure modes
- [ordering-workflows.md](references/ordering-workflows.md) — order-type state machines, idempotency, concurrency
- [menu-and-pricing.md](references/menu-and-pricing.md) — matching strategy, the model-facing data contract
- [anti-hallucination.md](references/anti-hallucination.md) — invented rules, uncertainty and escalation decision tree
- [conversation-contract.md](references/conversation-contract.md) — turn obligations, announce-once, final-state validation
- [conversational-quality.md](references/conversational-quality.md) — anti-repetition, compression, momentum, the repetition audit
- [observability.md](references/observability.md) — event taxonomy, metrics, alerts
- [test-suite.md](references/test-suite.md) — test doctrine and thirteen suites
- [deployment.md](references/deployment.md) — checklists and environment safety
