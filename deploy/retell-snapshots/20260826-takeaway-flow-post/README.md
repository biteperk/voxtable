# 2026-08-26 — staging: takeaway is a real flow, and no inventing rules

On `call_43a0d74d23b2256b33808eb9ece` (22:44) a caller asked to order and pick up. Bella said:

> "For takeaway orders, you'll need to order and pay at the venue when you arrive. We only take
> pre-orders over the phone for dine-in bookings."

**No such policy exists.** She had taken three takeaway orders by phone earlier the same
evening. She invented a business rule and stated it to a customer with total confidence.

The venue genuinely was closed (22:44; it shuts at 21:30), so declining *right now* was correct.
The reason was fabricated — and a wrong reason that sounds authoritative is worse than a refusal,
because the caller now believes something false about the business and hangs up.

## Root cause: takeaway was never a flow

The prompt's only ordering procedure is `## Pre-ordering food — offer ONCE, after the booking is
confirmed` — a dine-in concept, gated on a reservation. Nothing described taking a pickup order,
so the model improvised each time: three times it improvised a booking with `party_size 1` (which
worked), and once it improvised a policy (which did not). Improvisation is not a strategy; it is
the absence of one, and it fails at the worst moment rather than a random one.

## What changed (`PATCH /update-retell-llm`, prompt only, 14,125 → 15,334 chars)

**`## Takeaway and pickup`** — takeaway is ordinary on this call and must never be refused as a
category; check `{{today_status}}` first and, when closed, say so and offer the next open time;
then the same mechanism the successful calls found by accident — `create_booking` with
`party_size 1`, the pickup time and a takeaway note, then `create_order`, then the payment link.

**`## Never invent a rule`** — if the answer is not in the prompt or the venue answers, offer to
have the team confirm rather than guessing. A made-up rule sounds exactly as confident as a real
one, and the caller has no way to tell them apart.

## Read-back evidence (pasted, not summarised)

```
  ok: takeaway IS supported by phone / closed hours is the real reason /
      no fabricated policy / takeaway mechanism defined / honesty section intact
READ-BACK: prompt 15334 chars | 8 tools
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

## Known wart this does not fix

A pickup is still modelled as a **table booking** (`party_size 1`). That is why an 8:30 pickup was
once refused with a 409: the dine-in booking duration ran past closing, though nobody occupies a
table for 90 minutes to collect a bag. The prompt now makes the behaviour correct; the data model
still says something untrue. Worth a first-class order-without-reservation path later.

## Rollback

Re-apply `../20260826-takeaway-flow-pre/llm.json`'s `general_prompt` in one PATCH.
