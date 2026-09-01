# New Restaurant Intake

Five inputs. Everything else is inherited from the framework — do not re-derive it per venue.

> **Rule:** if answering a question here requires reading another venue's configuration, the answer
> belongs in the framework, not in this form.

---

## 1 · Menu

| Field | Notes |
|---|---|
| Sections, in the order they should be offered | The agent names two or three, never the whole list |
| Items per section: name, price, description | Prices in the venue's currency — the system formats them |
| Availability windows | Items sold only at certain times |
| Restricted items | Age-restricted or otherwise not sellable by phone, with the refusal wording |
| Required choices per item | Size, side, preparation — with the **exact allowed options** |
| Common caller words → item names | "the pasta", "a burger"; feeds matching |
| Section synonyms | What callers call a group that the section names do not contain |

⚠️ Required-choice options must be **exact**. The agent reads them verbatim; anything it infers is a
promise the kitchen never made.

## 2 · Hours

| Field | Notes |
|---|---|
| Opening hours per day | Multiple windows per day supported |
| Kitchen hours, if different | Last orders may precede closing |
| Preparation time | How long before a pickup is ready — drives "now" requests |
| Closed dates | Holidays, closures |
| Time zone | Explicit; never inferred |

## 3 · Ordering rules

| Field | Notes |
|---|---|
| Order types accepted by phone | Dine-in booking · pre-order · pickup · future |
| Booking duration | Dine-in only — **never** applied to pickup |
| Largest party seatable | Above this, the agent offers a callback, not a time |
| Tables: labels and capacities | Preferences rank, they do not exclude |
| Minimum notice per order type | |
| Maximum days ahead | |
| Large-group procedure | Usually a callback |

## 4 · Payment rules

| Field | Notes |
|---|---|
| Is phone payment offered? | If no, the rest is skipped and the agent must never imply otherwise |
| Required or optional? | Required blocks fulfilment until settled |
| Which order types | |
| Link validity | The agent states this aloud |
| Refund procedure | **Must exist before launch** |
| Who bears fees and disputes | A commercial decision; make it explicitly |

## 5 · Policies

| Field | Notes |
|---|---|
| Deposits, cancellations, no-shows | |
| Dietary and allergen handling | Usually escalate — never let the agent adjudicate allergens |
| Accessibility | |
| Anything the agent must **refuse** | With the exact wording |
| Anything requiring a human | With the escalation path |

> Every question a caller can ask that is **not** answered above needs an explicit "have the team
> confirm" path. A gap here is where the agent will improvise — see
> [anti-hallucination](../references/anti-hallucination.md#the-root-cause-a-missing-procedure).

---

## Sign-off

- [ ] Menu loaded; prices verified against the venue's own list
- [ ] Hours verified, including the time zone
- [ ] Required choices carry exact options
- [ ] Restricted items carry refusal wording
- [ ] Payment decision recorded; refund path exists if payment is on
- [ ] Escalation path defined for everything not covered
- [ ] Acceptance checklist passed
- [ ] Voice battery run, with rows recorded
- [ ] Owner named for the first day of live calls
