# Ordering Workflows

Six order shapes, one state machine each. The failures below came from treating them as one shape.

## Contents
- [The six shapes](#the-six-shapes)
- [Required data per shape](#required-data-per-shape)
- [The order state machine](#the-order-state-machine)
- [Idempotency](#idempotency)
- [Concurrency](#concurrency)
- [Failure modes](#failure-modes)
- [Required tests](#required-tests)

---

## The six shapes

| Shape | Occupies capacity? | Needs a time? | Payment |
|---|---|---|---|
| **Dine-in booking** | Yes, for a duration | Yes, start time | Optional, usually at venue |
| **Dine-in pre-order** | Rides an existing booking | Inherits it | Optional |
| **Takeaway / pickup, now** | **No** | Ready-by, derived from prep time | Either |
| **Takeaway / pickup, later** | **No** | Yes, pickup time | Either |
| **Future order** | Depends on the above | Yes, plus a date | Usually required |
| **Payment-required order** | Any | Any | Must settle before fulfilment |

> ⚠️ **The most expensive modelling error in this framework: a pickup is not a table.**
> Where takeaway is implemented as a booking with a party of one, it inherits the *dine-in
> duration* — so a pickup shortly before closing is refused because a table would still be
> occupied after close, though nobody occupies anything to collect a bag. It also inherits
> capacity accounting it should never touch.
> **Give pickup its own record with a ready-by time and no duration.** If you must overlay it on
> bookings as an interim, mark it explicitly and exclude it from capacity and duration checks —
> and record it as debt, because it *will* surface as a confusing refusal.

---

## Required data per shape

| Field | Dine-in | Pickup | Notes |
|---|---|---|---|
| Contact number | Required | Required | From the call when available; asked digit-by-digit only when withheld |
| Name | Required | Required | Always ask explicitly — a name mentioned in passing may be someone else |
| Party size | Required | **Not applicable** | Asking for it on a pickup is how the table model leaks into the dialogue |
| Time | Start | Ready-by | Both validated against opening hours |
| Items | Optional | Required | An empty pickup is not an order |

**Withheld caller ID:** if the platform hands you a placeholder string, the agent must receive an
**empty value**, never the placeholder. *An agent given the literal word for "withheld" passed it
straight into a booking as a phone number.* The raw value stays in the call log — for forensics, a
withheld number is information.

---

## The order state machine

```
   DRAFT ──build items──► VALIDATED ──persist──► CONFIRMED
     │                        │                     │
     │                        │                     ├── payment optional ──► FULFILLABLE
     │                        │                     │
     │                        │                     └── payment required ──► AWAITING PAYMENT
     │                        │                                                │
     │                   ┌────┴────┐                                    settled │  expired
     │                   │ refused │                                            ▼      ▼
     │                   └─────────┘                                     FULFILLABLE  CANCELLED
     │                unavailable item,
     │                closed, capacity,          CONFIRMED ──caller changes mind──► AMENDED
     └── abandoned      out-of-window                          (re-validate, re-price,
                                                                supersede any live payment link)
```

**Transitions are one-way where money is involved.** Settled may still move to refunded or
disputed; nothing else terminal moves. A late event arriving out of order is a **no-op**, never a
downgrade and never a resurrection.

---

## Idempotency

Two different things must be told apart, and the naïve key conflates them:

| Situation | Correct outcome |
|---|---|
| The **same** request retried (platform double-fire, network retry) | Return the original — never a second order |
| A **second, genuine** order in the same call | Create it |

**Key = transport identifier + content fingerprint + attempt sequence.**

- **Transport identifier**, never a model-supplied one. *A guard keyed on an id the model could not
  know was always absent, so it never ran: the retry found different capacity and committed a
  second booking. An overlap constraint cannot catch that — the two do not overlap.*
- **Content fingerprint**, or one call can only ever place one order. *A guest added a drink, heard
  it confirmed, and it was never made or billed.* Sort deterministically by code point — a
  fingerprint must be identical on every machine.
- **Attempt sequence**, or resends replay a dead link. *Payment providers cache idempotency keys far
  longer than links stay valid; without a sequence, every resend replayed the original expired
  session.*

**Check the key after acquiring the lock, not before.** Two concurrent retries both pass a pre-lock
check and race the insert, surfacing a constraint violation as a raw error on a live call.

---

## Concurrency

**Lock the day, not the slot.** A booking at one time and another 30 minutes later on the same
table conflict, but per-slot keys put them in different locks — so both commit. Bookings overlap
across start times, so the lock must span the period they can overlap in.

**The lock is politeness; the constraint is the guarantee.** Enforce non-overlap in the schema. The
lock reduces contention and lets you return a friendly message instead of a constraint error.

**Only the destination needs locking** when moving a booking — vacating a slot can only free
capacity, never create an overlap.

**Guard the arithmetic.** *A duration added to a late start wrapped past midnight and produced an
end time earlier than the start, so every overlap test returned false and the system double-booked
every single time — no concurrency required.*

**Snapshot the duration onto the record.** Otherwise changing the venue's default retroactively
lengthens existing bookings and silently opens or closes overlap windows against them.

**Re-read prices inside the transaction, under a shared lock**, so a concurrent menu edit cannot
change what is being charged mid-order. Snapshot name and price onto the line — order history must
stay true when the menu changes later.

**Bound the order.** A maximum item count stops an unbounded order from a confused model or a
malicious client.

---

## Failure modes

### F1 · Silent substitution
See [menu-and-pricing](menu-and-pricing.md#f1--silent-substitution). Ordering's half of the fix:
resolve items against **all** items including unavailable ones, then refuse by name.

### F2 · Retry duplication
Covered under [Idempotency](#idempotency). Symptom: one caller holding two reservations, with the
dashboard showing one because the later write overwrote the link.

### F3 · Capacity refusal reported as a time problem
**What broke:** a party larger than any table was told the *time* was unavailable and offered
alternative times, none of which could ever help.
**Rule:** distinguish "busy now" from "never possible". The second offers a callback, not a slot.

### F4 · Party-of-one refused
**What broke:** a minimum-capacity preference was applied as a hard filter, so a single diner could
not book an empty restaurant.
**Rule:** seating preferences rank; they do not exclude.

### F5 · Partial mutation across connections
**What broke:** an amendment updated two tables on two connections; the first committed, the second
failed, leaving a visibly half-changed booking.
**Rule:** one logical change, one transaction.

### F6 · Rollback masking the real error
**What broke:** the rollback itself threw on a dead connection, replacing a clean, friendly
"just taken" conflict with an opaque server error mid-call.
**Rule:** guard cleanup so it cannot overwrite the original error.

### F7 · Requiring a reservation for a pickup
**What broke:** the order path demanded a booking, making phone pickup impossible — the caller was
offered a table they never asked for.
**Rule:** every shape in [the six](#the-six-shapes) has its own path.

---

## Required tests

| # | Objective | Setup | Execution | Expected | Failure signal |
|---|---|---|---|---|---|
| 1 | Retry cannot duplicate | **Two** free tables | Same request twice, same transport id | One booking, same id returned | Two bookings |
| 2 | Concurrent retries | Two free tables | Two simultaneous identical requests | Exactly one booking | Two commit |
| 3 | Second genuine order | Confirmed order | Different items, same call | Two orders | Second silently dropped |
| 4 | Overlap impossible | One table | Two overlapping times | Second refused, friendly message | Both commit |
| 5 | Late-night arithmetic | Booking near closing | Compute the window | End after start | Every overlap test false |
| 6 | Resend after expiry | Expired attempt | Request again | Fresh link | Dead link replayed |
| 7 | Capacity ceiling | Party > largest table | Request | "Cannot seat", callback offered | Alternative times offered |
| 8 | Solo diner | All tables prefer 2+ | Party of one | Seated | Refused |
| 9 | Pickup near closing | Ready-by shortly before close | Request | Accepted | Refused on dine-in duration |
| 10 | Withheld number | Caller ID suppressed | Take an order | Agent asks for a number | Placeholder stored as phone |
| 11 | Price immutability | Order placed, menu price changed | Read the order | Original price | History mutates |

> **Test-design note:** test 1 needs **two** free tables. With one, the overlap constraint masks the
> bug and the test passes while proving nothing.
