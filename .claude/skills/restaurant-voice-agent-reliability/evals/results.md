# Evaluation results

Scored against `rubric.md`, which was written and committed before any run.

## ⚠️ Methodological caveat, stated up front

The baseline agents made **zero tool calls** — they answered from general knowledge *plus this
project's `CLAUDE.md`*, which already documents the architecture, the exclusion constraint, the
smoke-test suite and several hard-won rules. The baseline is therefore **not naive**.

This makes the comparison **"existing project docs" vs "existing project docs + skill"**, which is
the right question for this repo and a **lower bound** for a fresh deployment where no such
documentation exists. Every measured gain would be larger at restaurant #2.

---

## S1 · Payment confirmation design

| # | Criterion | Baseline | Skill |
|---|---|---|---|
| 1 | Primary, not replica | ✗ | ✓ |
| 2 | Three states incl. in-flight | ✓ | ✓ |
| 3 | Announce-once via datastore claim | ✓ | ✓ |
| 4 | Most-recent attempt, not "the active one" | ✗ | ✓ |
| 5 | Bounded ceiling + graceful alternative | ✓ | ✓ |
| 6 | Server-side reconciliation on call end | ✓ | ✓ |
| 7 | Check counter logged **and asserted** | ✗ | ✓ |
| 8 | Refund path before real money | ✓ | ✓ |
| | **Total** | **5/8** | **8/8** |

**The finding that matters.** The three the baseline missed — replica read, attempt-row selection,
the unasserted counter — are *precisely the three that shipped as real bugs and had to be fixed in
production*. The baseline produced a genuinely good design and missed exactly the failures that only
a live call surfaces.

**Baseline strengths the skill lacks** (gaps to fix, not noise):
- A **blocking/long-poll tool** (server-side `LISTEN` with a ~6 s wait) so the model makes one call
  instead of deciding when to poll. Better than the skill's turn-based rule where the platform allows it.
- **Provider read-through fallback** — a bounded direct API read when the webhook is late and the
  guest insists they have paid.
- **Handle both `session.completed` and `payment_intent.succeeded`**, first wins.
- **SMS delivery tracking** → a `link_undelivered` state, so an undeliverable link is not silence.
- **Double-success detection** with automatic refund of the later charge.
- **A scripted transcript harness in CI** asserting the agent never confirms while state is waiting.

## S3 · Takeaway / pickup flow design

| # | Criterion | Baseline | Skill |
|---|---|---|---|
| 1 | Pickup consumes no table capacity | ✓ | — |
| 2 | Dine-in duration must not apply | ✓ | — |
| 3 | Party size is not a pickup field | ✓ | — |
| 4 | "Now" validated against hours, real reason | ✓ | — |
| 5 | Explicit procedure, no improvisation gap | ✓ | — |
| 6 | Ready-by derived from prep time | ✓ | — |
| | **Total** | **6/6** | **6/6** |

**Honest result: the baseline scored full marks.** The pickup-is-not-a-table lesson is evidently
derivable from a good architectural description — `CLAUDE.md` describes the reservation model and
its constraint, and a competent designer reasons the rest. The skill cannot claim credit for
teaching this one.

It went further than the framework in places: per-window pickup capacity, a queue-pressure step
table for prep time, PCI handling if a caller reads out a card number, and refusing to let the model
adjudicate allergens. **The allergen and card-number rules are genuine gaps in the framework.**

## S2 · Diagnosing a real "sounds robotic" transcript

Both were given the same anonymised 171-second call, told only that the owner said it sounded
robotic. Both correctly identified repetition as the dominant fault and both found the caller's
objection at 65.9 s.

| # | Criterion | Baseline | Skill |
|---|---|---|---|
| 1 | Names repetition as the dominant fault | ✓ | ✓ |
| 2 | Counts the recitals rather than asserting | ✓ (4) | ✓ (6, tabulated) |
| 3 | Root-causes it to **several existing instructions**, not a missing rule | ~ | ✓ |
| 4 | Prescribes **deleting** instructions; predicts a shorter prompt | ✗ | ✓ |
| 5 | Finds the talk-over / turn-length coupling | ✓ | ✓ |
| 6 | Proposes a transcript-computed regression audit with thresholds | ✓ | ✓ |
| | **Total** | **4.5/6** | **6/6** |

**Where they diverge is the whole point of the framework.** The baseline's Priority 2 is *"add an
explicit no-repetition rule."* The skill states the opposite and says why: *"Adding 'be concise'
puts one instruction against six live ones and loses… Expect the prompt to get shorter. That is
the tell that you fixed the cause and not the symptom."* That is exactly what happened on the real
call — deleting four recaps and merging one fixed it; a "don't repeat" rule would not have.

**⚠️ The baseline found a correctness bug the skill missed.** At 26.3 s the agent said *"Yep,
tomorrow works"* — **before** the availability tool ran at 49.9 s. It happened to be available. The
treatment run, focused through the conversational-quality lens, did not flag it. A framework that
sharpens attention on one axis can dull it on another; that is a real cost, not a rounding error.

The baseline also produced three metrics the skill's audit lacks: **time-to-first-substantive-answer**
(80 s on this call), **turns-to-complete-booking**, and **agent talk ratio**.

---

## Aggregate

| Scenario | Baseline | Skill |
|---|---|---|
| S1 · payment design | 5/8 | 8/8 |
| S2 · transcript diagnosis | 4.5/6 | 6/6 |
| S3 · takeaway design | 6/6 | 6/6 |
| **Total** | **15.5/20** | **20/20** |

## What this does and does not prove

**Supported by the evidence:**
- The framework **prevents the specific failures that actually shipped as bugs** — every one of the
  four the baseline missed (replica read, attempt-row selection, unasserted counter, add-a-rule
  reflex) cost a real fix on a real call.
- It **reduces repetition** by correctly attributing it to instruction count rather than a missing
  rule — the counter-intuitive answer, and the one that worked.
- It **prevents hallucination** consistently, but so did the baseline; no measured advantage.

**Not supported:**
- **No advantage on pickup modelling.** The baseline scored 6/6 unaided. The skill's claim that
  pickup-as-booking is "the most expensive modelling error" is true of what happened here, but it
  is evidently *derivable*, not *unteachable*.
- **No behavioural evidence.** Every score is a design-quality judgement by one grader against a
  rubric that grader wrote. No agent was reconfigured and no call was placed. The framework's own
  doctrine — *"'enabled' is not 'works'; only a real call proves a path"* — applies to this
  evaluation itself.
- **Two axes regressed.** The skill run missed a correctness bug the baseline caught, and produced
  fewer conversation metrics.

## Gaps to close, ranked

1. **Confirm-before-check** — add to `conversation-contract.md`: never state availability, price or
   a held slot before the tool that establishes it returns. Caught by the baseline, missed by us.
2. **Allergen non-adjudication** — the agent records and escalates; it never rules on safety.
   Absent from the framework entirely. Legal exposure, not just quality.
3. **Spoken card numbers** — a caller reading a PAN into a recorded call is an incident. No rule exists.
4. **Long-poll / blocking tool** as the preferred payment-check transport where the platform supports it.
5. **Provider read-through fallback** when the webhook is late and the guest insists.
6. **SMS delivery tracking** → an undeliverable-link state.
7. **Three metrics** for the repetition audit: time-to-first-substantive-answer, turns-to-complete,
   talk ratio.
