# Payment Monitoring

The guest pays on their phone while still on the call. The agent must notice — without being asked,
without saying it twice, and without ever telling someone who has paid that they have not.

## Contents
- [The architecture](#the-architecture)
- [Push or poll: the decision](#push-or-poll-the-decision)
- [The watcher state machine](#the-watcher-state-machine)
- [Failure modes](#failure-modes)
- [Required tests](#required-tests)

---

## The architecture

Four components. Each exists because omitting it caused a failure.

| Component | Responsibility | Why it is separate |
|---|---|---|
| **Payment record** | The lifecycle of one attempt: created → sent → in flight → settled/expired/failed/refunded/disputed | Survives the call. A link outlives the conversation that created it |
| **Order record** | Whether the *order* is paid | An attempt can settle while the order must stay unpaid — see [amount mismatch](#f6-amount-mismatch) |
| **Watcher** | Per-call state: how many times checked, what was last seen, whether announced | The agent has no memory between turns; this is its memory |
| **Reconciler** | Closes out watchers when the call ends, whatever the model did | A caller who hangs up never reaches any prompt rule |

**Rule:** the payment record and the order record are **separate states that can legitimately
disagree**. Collapsing them into one field is the origin of two distinct production failures.

---

## Push or poll: the decision

```
Can your voice platform inject a message into a live call?
├── YES, natively ──────────► Push. Webhook → inject confirmation. Simplest.
├── ONLY by self-hosting the model loop
│   └── Do NOT take that trade for one confirmation line.
│       You lose the platform's turn-taking, barge-in and every tuned knob.
│       ────────────────────► Poll on the agent's own turns.
└── NO ─────────────────────► Poll on the agent's own turns.
```

**Polling well is not a consolation prize.** The trick is choosing the clock:

> **The caller's silence is the trigger.** Someone paying on their phone goes quiet. Most voice
> platforms hand the agent a turn after N seconds of silence — and that turn is otherwise spent
> asking "are you still there?", which is worthless. Spend it checking.

Express the rule as **state, not time**: *"while a payment is outstanding, begin any turn by
checking."* Not *"check after ten seconds."* Then call pacing, engine settings and the caller
speaking instead all change nothing.

*Observed: two silences on one call each produced an agent turn, both wasted on "are you still
there?" — the exact moments the guest was paying.*

---

## The watcher state machine

```
                    ┌──────────────────────────────────────┐
   link sent ──────►│ WATCHING (checks=0, announced=false) │
                    └──────────────┬───────────────────────┘
                                   │ agent takes any turn
                                   ▼
                    ┌──────────────────────────┐
                    │ read state from PRIMARY  │
                    └──────────────┬───────────┘
        ┌──────────────┬───────────┼───────────────┬──────────────┐
        ▼              ▼           ▼               ▼              ▼
    NOT STARTED    IN FLIGHT    SETTLED        REFUNDED      NOT FOUND
        │              │           │               │              │
   checks+1       "it's        claim announce   say so,       refuse,
   ≤ LIMIT?       processing"  ├─ won: announce  hand off      re-take order
    │      │      (never        └─ lost: brief
   yes    no       "failed")       re-confirm
    │      │           │              │
  brief  offer     keep watching   wrap up
  line   alternative
         and STOP
                                   ▲
   call ends ──► RECONCILE ────────┘  (server-side; no model involvement)
```

**LIMIT is mandatory and must be reachable.** Three checks is a reasonable default. A guest whose
bank is slow must not be interrogated; after the limit, offer the alternative and stop.

**Announcement is a claim, not a decision.** The first check that sees a settled payment *claims*
the right to announce, atomically. Every later check sees the claim and re-confirms briefly instead
of breaking the news again. The claim is per (call, order) so a guest who rings back is told again.

---

## Failure modes

### F1 · Reading a replica
**What broke:** the guest paid, the webhook committed to the primary, the agent read a replica that
had not caught up, and told them it had not arrived.
**Why it is the worst case:** this is the one moment where staleness is maximally damaging — money
has moved and the system says otherwise.
**Rule:** payment state is read from the **primary**, always. Replica lag is acceptable everywhere
except here.

### F2 · Two-state payment model
**What broke:** an in-flight payment looked identical to one never started, so the agent implied
failure — and a guest told their payment failed pays again.
**Rule:** at least three states — **not started / in flight / settled**. In flight is neither
success nor failure and must be spoken as neither.

### F3 · Duplicate announcement
**What broke:** the "say it once" rule lived in the prompt, and overlapping checks both believed
they were first.
**Root cause:** read-then-write is a race against an unconditional upsert.
**Rule:** claim atomically — an insert that can only succeed once. The datastore arbitrates, not the
model, not the application.

### F4 · Selecting the wrong attempt row
**What broke:** the code joined "the active attempt", but the index defining *active* excludes
settled attempts — so a paid order matched nothing. A resend also leaves an older superseded row.
**Rule:** take the **most recent** attempt; let the order's own status win for settled and refunded.

### F5 · Unreachable ceiling
**What broke:** the counter read a property that did not exist on the returned object, so every
check believed it was the first. The three-check ceiling could never fire.
**How it hid:** two live calls looked perfectly healthy — the agent answered correctly both times.
The bug was in a number nobody spoke aloud.
**Rule:** if a limit exists, **log the count and assert it in a test**. And test the round trip the
*caller* performs, not just the store's own behaviour: the store was correct throughout.

### F6 · Amount mismatch
**What broke:** the order was edited after the link was sent; the guest paid the old total.
**Rule:** record the money on the attempt, leave the **order unpaid**, alert a human. Never
auto-resolve. Staff must see the truth. The bounded checks in the state machine are what stop the
agent looping on this forever.

### F7 · Settled after cancellation
**Rule:** the money is real; the order is not. Record it, alert, never produce the goods. Requires a
manual refund path — see F9.

### F8 · Abandoned mid-payment
**What broke:** the "check before ending" rule was prompt-enforced, and a caller who hangs up never
reaches the end-of-call step at all.
**Rule:** reconcile **server-side** on the call-ended event, which fires for abandoned calls too.
The prompt makes the *caller's experience* right; only the server makes the *record* right.

### F9 · No refund path
**What broke:** refunds were observed but never initiated. A refund issued from the vendor console
took money from the platform while the venue kept its transfer.
**Rule:** never take real money in production without an implemented refund path, or at minimum a
written manual procedure that reverses **both** legs.

### F10 · Message encoding silently doubling cost
**What broke:** one character outside the basic alphabet re-encoded the whole message, halving
segment size and billing 2–3× per link.
**Rule:** transactional messages use the restricted alphabet only, asserted by a test.

### F11 · Unbounded watcher state
**What broke:** per-call state accumulated permanently because the retention sweep worked from an
explicit list and nobody added the new key.
**Rule:** a new state key registers its retention in the **same change**.

### F12 · Acknowledging an event you could not apply
**What broke:** returning success for a webhook whose target row had not committed yet consumed the
event permanently.
**Rule:** **never acknowledge an event you could not apply.** Fail, and let the provider retry —
the retry loop is the tool for "ours, but not ready yet".

---

## Required tests

Run every integration and behaviour test below in staging. Pure, credential-free
unit checks may run in CI. Never use Stripe live mode or production orders,
calls, payments, fixtures or webhooks.

| # | Objective | Setup | Execution | Expected | Failure signal |
|---|---|---|---|---|---|
| 1 | No stale read | Order marked settled on the primary | Read state immediately | Settled | "Not paid" right after payment |
| 2 | Three states | Attempt in flight, order unpaid | Read state | In flight — not paid, not unpaid | Guest told it failed |
| 3 | Announce once | Settled order | Two **concurrent** checks | Exactly one claims | Both announce |
| 4 | Announce once, sequential | Settled order | Three checks in series | First announces, rest re-confirm | Repeated news |
| 5 | Per-call scope | Same order, new call | Check | Announces again | Returning guest told nothing |
| 6 | Newest attempt wins | Superseded attempt + newer settled one | Read state | Settled | Paid order reads unpaid |
| 7 | **Counter advances** | Watcher at count 1 | Check | Count 2 | Ceiling unreachable |
| 8 | Ceiling fires | Never settle | Check limit+1 times | Alternative offered, checks stop | Infinite polling |
| 9 | Amount mismatch | Attempt settles at a stale total | Reconcile | Attempt settled, **order unpaid**, alert raised | Order marked paid |
| 10 | Abandoned call | Watcher open, no announcement | Fire call-ended | Unresolved event logged, watcher cleared | Silent loss |
| 11 | Tenant isolation | Order from venue A | Read as venue B | Not found | Cross-tenant leak |
| 12 | Retention | Watcher keys older than the window | Run the sweep | Removed | Unbounded growth |
| 13 | Encoding | Longest plausible inputs | Build the message | Restricted alphabet, one segment | Double billing |

**Doctrine:** each of these must **fail against the implementation it replaced**. A test that passes
both before and after documents behaviour; it does not verify it.
