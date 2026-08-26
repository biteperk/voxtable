# 2026-08-26 — staging: Bella watches the payment land

Sam, after paying on `call_1aee86956b7bf11b642bf41784d`: *"can you see if it's been paid or
not?"* — and she said no. She was right; there was no tool. `check_payment_status` was added
an hour earlier, but as a **pull**: she only knew if she thought to ask. This makes her watch.

## Why it is a poll, not a push

Retell's `agent_interrupt` — the only thing that makes an agent speak on command mid-call — is
**exclusively for self-hosted LLM WebSockets**. We use Retell's built-in LLM, and there is no
REST endpoint for injecting a message into a live call. True push would mean running the whole
LLM loop ourselves and losing every knob in the golden config.

The mechanism that works instead was already visible in the transcript: when the caller goes
silent, Retell gives the agent a turn, and both silences on that call were spent asking
*"are you still there?"*. **Someone paying on their phone is quiet.** That silence is the cue.

The rule is written state-driven, not time-driven: *"while a payment link is outstanding, start
any turn by checking"*. The 10-second reminder only creates turns — changing it, or the caller
simply speaking, changes nothing.

## What changed

**Backend** (voxtable PR #291):
- `getOrderPaymentSnapshot` — reads the **primary**, not the replica. The Stripe webhook writes
  the primary, so a replica read produced the worst possible answer: guest pays, webhook
  commits, Bella says it has not arrived. Also resolves **three** states — `processing` is
  invisible from `orders.payment_status` (only unpaid/paid/refunded) and lives on the
  `order_payments` row. An in-flight payment reported as failed sends a guest to pay twice.
- The payment row is the **most recent**, not the "active" one: `idx_order_payments_active`
  covers only created/sent/processing, so a row stops being active the instant it succeeds, and
  a resend leaves an older cancelled row behind it.
- `claimOpsStateKey` — `INSERT … ON CONFLICT DO NOTHING`. Announce-once is decided by Postgres.
  `setOpsState` is an unconditional upsert, so the obvious read-then-write would let two
  overlapping checks both "win" and the guest hear it twice.
- **Call-end backstop** in `persistRetellCall`: the pre-`end_call` check is prompt-enforced, and
  a caller who hangs up never reaches `end_call` at all. The `call_analyzed` webhook fires for
  those calls too, so an unresolved watcher is logged (`payment_watch_unresolved`) and cleared
  there — the record is right regardless of what the model did.
- Lifecycle logging: `payment_watch_started`, `payment_check`, `payment_state_changed`,
  `payment_announced`, `payment_watch_unresolved`.
- `cleanupWorker` registers both new `ops_state` prefixes (7 days). The purge list is explicit;
  an unregistered prefix is never swept, so this would otherwise have grown one or two permanent
  rows per paid phone order, forever.

**LLM** (13,257 → 14,125 chars): the turn rule above, the three spoken outcomes, a **three-check
ceiling** (a slow bank is not the caller's fault), and a final check before ending a call where
a link went unconfirmed.

## Read-back evidence (pasted, not summarised)

```
  ok: turn-driven, not time-driven / silence is the cue / processing handled /
      nag ceiling / no duplicate announce / final gate
READ-BACK: prompt 14125 chars | 8 tools
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

`npm run smoke:payment-watch` — 8/8, including two concurrent claims where exactly one wins.
That assertion fails against the design this replaced.

## Verification still owed

A call where the caller **goes silent instead of speaking** after taking the link: she should
check unprompted and announce once when it lands. Then a call where the link is ignored: three
checks, then pay-on-arrival, and `payment_watch_unresolved` in the logs if they hang up mid-pay.

## Rollback

Re-apply `../20260826-payment-watch-pre/llm.json`'s `general_prompt` in one PATCH. The backend
side is behind no flag but is additive — the old tool shape simply had fewer fields.
