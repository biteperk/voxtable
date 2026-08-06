# Resiliency backlog — fallback mechanisms per service

**Status: BACKLOG. Nothing here is scheduled until the happy path is ready** (staging
end-to-end green and the production promotion done) — per review on PR #105. This document
answers "what is the fallback mechanism for each of the services", records which fallbacks
already exist, and parks the designs for the gaps.

## The fallback matrix

| Service / dependency | Failure mode | Fallback today | Gap / backlog item |
|---|---|---|---|
| **Voice booking** (Retell tools → Postgres) | Postgres unreachable mid-call | None — the tool call fails, Bella apologises, the booking is lost | **The one real gap.** Capture-and-reconcile design below (Appendix A) — parked here until the happy path is ready |
| **Voice booking** (agent misbehaving) | Prompt regression / corrupted flow | `VOICE_BOOKING_ENABLED` kill switch (PR #99): spoken refusal, zero writes, webhooks stay live | — |
| **Cal.com mirror** | Cal.com down / rate-limited | Transactional outbox + exponential backoff + dead-letter ceiling; circuit breaker (survives restarts, PR #102); inbound reconcile with loop guard. Voice path never blocks on Cal.com | — |
| **Notifications** (SendGrid/ZeptoMail/Twilio SMS) | Provider down, worker crash mid-send | Outbox with claim lease (PR #101 — no double-send), retry with backoff, permanent-failure alert | — |
| **Provisioning** (Twilio buy + Retell agent create) | Vendor 429/5xx, worker crash mid-step | Idempotent step saga with per-step payload, transient-vs-permanent classification, 10-min stuck-job reaper, paid-customer alert | Admin re-enqueue UI (backlog, low — direct SQL works) |
| **Stripe webhooks** | Delivery failure, out-of-order events | Stripe retries; idempotent event log; unattributed-event alert | — |
| **KDS** | Tablet offline / wifi down | Poll-based (no push dependency); DB-backed heartbeats + staleness alert (PR #104) | — |
| **Database** | Data loss / corruption | VM: nightly pg_dump → GCS + restore runbook (PR #103). Cloud SQL (staging now, prod at cutover): automated backups + PITR | Post-cutover: retire the VM chain; run a timed PITR drill |
| **Deploy** | Bad revision reaches traffic | Cloud Run refuses boot-crashed revisions; post-deploy verification + automatic traffic rollback (PR #100) | Two staging drills once staging boots |
| **Whole worker process** | The process that alerts is dead | `OPS_HEARTBEAT_URL` dead-man's switch (PR #104) — external service alerts when pings stop | Point it at a real healthchecks.io check |

Everything below is **Appendix A**: the parked design for the one real gap.

---

# Appendix A — Degraded mode: capture-and-reconcile (parked)

**Status: PARKED in this backlog until the happy path is ready. Not scheduled.**
**Decision on record (Sam, 2 Aug):** during an outage Bella keeps taking the booking;
on recovery, conflicts send the guest an SMS with alternatives **and** raise a staff task.
**Depends on:** the notification-lease fix (PR #101) for reliable SMS delivery, and the
durable breaker (PR #102) as one of the trigger signals.

## Problem

When Postgres is unreachable mid-call, every `/retell/tools/*` call today throws, Bella
apologises, and the booking is lost — the caller rings the next restaurant. The voice
path is the product; a database blip should cost us a reconciliation, not a customer.

## The hard constraint: where does the capture live?

The obvious answers are all wrong:

| Store | Why not |
|---|---|
| Postgres | It's the thing that's down. |
| Local disk journal | Cloud Run filesystems are ephemeral and per-instance; the instance that captured may be gone at recovery, or be one of several. |
| A queue (Pub/Sub) | Doesn't exist yet — that's deliberate Block 8 platform work, not something to rush in via a disaster path. |
| Firestore / secondary DB | Workable (ADC auth already present for Firebase), but adds a second stateful vendor dependency inside the money path, with its own outage modes, for data Retell already holds. |

## Proposal: Retell already holds the capture

Every call's transcript and analysis lives at Retell regardless of what our backend does.
`call_analyzed` webhooks carry `custom_analysis_data.{intent, booking_outcome, ...}`, and
the REST API can list calls with their analysis after the fact. So the design leans on
that instead of inventing a store:

1. **During the outage** (`DEGRADED_CAPTURE_ENABLED=true`, default **off**, and the tool
   handler catches a DB-unavailable error — connection refused/timeout, not a constraint
   violation):
   - `create_booking` returns a **tentative** spoken confirmation with distinct wording:
     "I've noted your booking request for <details>. You'll receive a text message
     confirming it shortly." No availability promise is made — nothing could check one.
   - `check_availability` in degraded mode answers "I can take your details and confirm
     by text" rather than inventing availability.
   - The agent's post-call analysis fields (already configured: `intent`,
     `booking_outcome`, `special_requests`) plus the transcript carry the structured
     intent. **Open question for the Retell config:** add a `requested_date/time/party`
     custom-analysis field so reconstruction never parses free text.
2. **`/retell/webhook` returns 5xx while the DB is down** (it already does — the write
   fails), and Retell retries webhook delivery with backoff. That alone is not enough —
   retry windows are finite (**open question: confirm Retell's exact retry policy**) —
   so it is a bonus path, not the mechanism.
3. **On recovery**, a reconcile pass (new tick in the existing worker, gated on the same
   flag) runs when the DB is back AND a degraded window was recorded (`ops_state` row
   `degraded-window`, written best-effort with the outage start/end — if even ops_state
   was down, the window falls back to "since the last successful webhook"):
   - Lists Retell calls in the window via the REST API (`RETELL_API_KEY` already in env).
   - For each call whose analysis says a booking was requested and that has **no
     matching reservation and no matching call_log booking outcome**, replays through
     the REAL `createBooking` — the advisory lock and the migration-025 overlap
     constraint are never bypassed.
   - Replay outcome **booked** → confirmation SMS to the caller (via the
     notifications outbox — at-least-once, now double-send-safe).
   - Replay outcome **conflict** (slot gone) → SMS with the nearest alternatives
     (`availabilityService` already computes them) + a staff task: a row in
     `support_requests` (migration 026) so the dashboard surfaces it; the venue calls
     the guest back. This is the exact behaviour Sam picked on 2 Aug.
   - Idempotency: replay keys on `provider_call_id` — a crash mid-reconcile re-runs
     safely because `createBooking`'s call-idempotency and the outbox dedupe both hold.

## Trigger and scope

- Flag: `DEGRADED_CAPTURE_ENABLED` (boolFlag, ships **off**; staging soak before prod).
- Enter degraded per-request: the tool handler catches only *unavailability* errors.
  No global mode toggle to get stuck in — each request degrades or doesn't.
- Cap: if the outage exceeds `DEGRADED_CAPTURE_MAX_HOURS` (default 6), Bella stops
  promising texts and falls back to today's apology — a promise queue nobody is
  reconciling for a whole service is worse than honesty.

## What this deliberately does not do

- No new datastore, no queue, no cross-service call in the voice path.
- No replay of `modify`/`cancel` intents in v1 — rarer, riskier (acting on stale state),
  and the staff task covers them: degraded modify/cancel answers get the same
  "we'll text you" treatment but always raise a staff task rather than auto-replaying.
- No attempt to hold table inventory during the outage. Tentative means tentative.

## Verification (before the flag turns on anywhere)

- `smoke:degraded-capture` in CI: inject a failing DB client into the tool path →
  tentative response, nothing written; then replay a captured payload through
  `createBooking` against the double-booking fixtures → clean slot books + SMS row
  enqueued; occupied slot → no reservation, alternatives SMS row + support_request row.
- Staging drill: stop Cloud SQL (or revoke the connector), place a real test call,
  restore, watch the booking land and the SMS send.

## Questions for review

1. Retell webhook retry policy — how long, how many attempts? (Determines how much the
   webhook bonus path covers before the REST reconcile matters.)
2. Comfortable adding the structured `requested_date/time/party_size` post-call analysis
   fields to the live agent config? (Snapshot + rollback via deploy/retell-snapshots.)
3. SMS sender: the venue's Twilio number is the natural from-number — any objection?
4. Is `support_requests` the right staff-task surface, or does Manage Tables want its
   own inbox?
