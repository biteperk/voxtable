# Observability

You cannot see what you do not emit. Every incident in this framework was found either by a human
on a call or by a log line — and the ones found by logs were cheaper.

## Contents
- [Event naming](#event-naming)
- [Required events](#required-events)
- [Severity](#severity)
- [What must never be logged](#what-must-never-be-logged)
- [Correlation](#correlation)
- [Metrics and alerts](#metrics-and-alerts)
- [Required tests](#required-tests)

---

## Event naming

`<domain>_<subject>_<outcome>`, snake_case, with structured fields alongside — never interpolated
into the message.

**Outcome vocabulary.** A closed set, so logs are greppable and alerts can key on suffixes:

| Suffix | Meaning |
|---|---|
| `_started` / `_starting` | Lifecycle begin |
| `_failed` | Failed, retryable |
| `_permanent` | Failed, will never succeed — stop retrying, tell a human |
| `_skipped_<reason>` | Deliberately not done; the reason is part of the name |
| `_ignored` | Received, not applicable to us |
| `_noop` | Applied, changed nothing (a correct replay) |
| `_refused` | Declined by a business rule |
| `_unmatched` / `_unresolved` | Could not attribute — **always needs eyes** |
| `_dead_lettered` | Retry budget exhausted |
| `_disabled` | Kill switch closed |

The distinction between `_failed` and `_permanent` is what stops a retry loop burning a budget on
something that cannot succeed. The distinction between `_noop` and `_ignored` is what tells you
whether a replay was *yours and harmless* or *not yours at all*.

---

## Required events

### Payment — the full lifecycle, not just errors
| Event | When | Must carry |
|---|---|---|
| `payment_link_created` | Attempt created | attempt id, amount |
| `payment_watch_started` | Watching begins | order, call |
| `payment_check` | **Every** check | state, **check count** |
| `payment_state_changed` | Observed state differs from last | from, to |
| `payment_announced` | The one announcement | order, call |
| `payment_watch_unresolved` | Call ended, outstanding | last state |
| `payment_amount_mismatch` | Settled at a stale total | expected, received |
| `payment_after_cancellation` | Settled for a cancelled order | attempt |
| `payment_disputed` | Dispute raised | attempt |
| `payment_reconciler_resolved` | Backstop settled it | how |

> **`payment_check` must carry the count.** *A counter stuck at 1 made a safety ceiling unreachable
> and two live calls looked healthy. Every symptom of a stuck counter is invisible unless the
> counter is in the log.* **If a rule has a limit, the limit's counter is logged.**

### Ordering
`order_created`, `order_status_changed`, `order_item_refused` (with the reason: unavailable,
restricted, out-of-window), `booking_created`, `booking_modified`, `booking_cancelled`,
`capacity_ceiling_refused` (distinct from a time refusal).

### Agent / call
`call_started`, `call_ended` (with disconnect reason), `tool_call` (name, outcome),
`tenant_unresolved` — **error**, `agent_unbound` — **error**, `caller_id_withheld`,
`capability_disabled_refusal`.

### Notifications
`notification_enqueued`, `notification_failed` (retryable), `notification_permanent`,
`notification_worker_started` / `_disabled` — *the "disabled" line is how you discover a channel was
never configured, rather than discovering it from a guest who got no message.*

### Workers
`<worker>_tick`, `<worker>_tick_failed`, `<worker>_started` / `_disabled`. A worker that no-ops
because a flag is off must **say so at startup**; silent no-ops are indistinguishable from working.

---

## Severity

| Level | Meaning | Examples |
|---|---|---|
| **error** | A human must look | Money settled against a cancelled order, amount mismatch, dispute, unattributable event, no agent bound, unhandled failure |
| **warn** | Degraded but handled | Retryable failure, fallback taken, rate limited, permission refused |
| **info** | Normal transitions | Every event above not listed as error/warn |

**Rule:** if nobody would act on it at 3am, it is not an error. Errors that nobody acts on train
people to ignore errors — the same way a permanently red check trains people to scroll past it.

---

## What must never be logged

- **Guest phone numbers, names, addresses** — log the record id and look it up.
- **Payment URLs** — a link in a log is a payable link.
- **Card data, tokens, API keys, signatures** — redact by key pattern *and* by value pattern.
- **Full message bodies** — log the template name and the recipient's id.

Redaction belongs in the **logger**, not at call sites. A call site that must remember is a call
site that eventually forgets.

---

## Correlation

Every log line in a call carries the **call identifier**, propagated automatically — not passed by
hand. *Before this existed, "which call did that error belong to?" had no answer.*

Also carry: tenant id on every tenant-scoped line, order/attempt id on every money line, and a
request id across process boundaries.

---

## Metrics and alerts

| Metric | Alert when | Why |
|---|---|---|
| Unresolved payment watchers | > 0 sustained | Guests left mid-payment |
| Amount mismatches | any | Money and order disagree |
| Settlements after cancellation | any | Manual refund owed |
| Attempts stuck in flight | age > expiry + grace | Missed events |
| Disputes | any | Time-limited response window |
| Refused-as-unavailable rate | spike | The menu is out of date |
| No-match rate on item search | spike | Matching or the menu is wrong |
| Agent-unbound events | any | A venue's calls are unanswerable |
| Tenant-unresolved events | any | Calls landing nowhere |
| Notification permanent failures | spike | Bad contact data or a sender problem |
| Turn latency (p50/p90) | p50 over budget | Slow reads as robotic — a correctness concern |
| Deploy: created ≠ ready revision | any | **A new version failed to boot while the old one keeps serving** |

> That last one is the highest-value single deployment signal. A platform that keeps serving the
> previous version on a failed rollout makes a broken release **look like health**.

**Run the important checks off-laptop, on a schedule.** A check that only runs when someone
remembers is a check that finds the problem after the customer does.

---

## Required tests

| # | Objective | Execution | Expected | Failure signal |
|---|---|---|---|---|
| 1 | Counters logged | Complete a bounded flow | Each event carries its count, incrementing | Count static |
| 2 | Lifecycle complete | One payment end to end | Started → check(s) → changed → announced | Gaps |
| 3 | No PII | Grep logs from a full call | No numbers, names, URLs | Any present |
| 4 | Correlation | Any call | Every line carries the call id | Orphan lines |
| 5 | Severity honest | Trigger a handled retry | `warn`, not `error` | Alert fatigue |
| 6 | Disabled announced | Start with a flag off | Startup says disabled | Silent no-op |
| 7 | Unresolved fires | Abandon mid-payment | `payment_watch_unresolved` | Nothing logged |
