# Call recording & data inventory — prepared for legal review (Track L)

**Purpose.** Sam has put the recording-disclosure question on hold pending legal advice.
This document is the factual inventory that advice needs: what VoxTable records, where it
goes, who processes it, what the signed agreement promises, and what the code actually does.
It changes no behaviour. Prepared 3 Aug 2026 from the codebase (`integration` branch),
migration history, and the Retell configuration snapshots in `deploy/retell-snapshots/`.

**Question for the lawyer, stated plainly:** every call Bella answers is recorded and
transcribed. She does not announce that she is an AI, and does not announce recording.
The signed customer agreement has the *restaurant* certify that she announces both.
The marketing site sells the opposite ("your regulars won't know she's AI"). Australian
law context: NSW (Surveillance Devices Act 2007) — all venues are currently in NSW.

---

## 1. What is collected, per call

| Data | Where it lands | Notes |
|---|---|---|
| Full call audio recording | Retell's storage; URL stored as `call_logs.recording_url` | Recording performed by Retell, not by us; we keep the pointer |
| Full transcript (verbatim, both sides) | `call_logs.transcript` (Postgres, TEXT) | Whatever the caller says — names, phone numbers, health mentions, anything |
| Caller phone number | `call_logs.caller_phone`, `customers.phone` | E.164; also held by Twilio (carrier records) and Retell |
| Caller name | `customers` + `call_logs` (caller-name column added in migration 016) | Collected conversationally by the agent |
| Call summary (AI-generated) | `call_logs.summary` | Derived from the transcript |
| Booking details | `reservations` (+ mirrored to Cal.com) | Date, time, party size, special requests |
| Call metadata | `call_logs` (provider_call_id, timestamps, latency, transfer flag) | |

Schema source: `apps/backend/db/migrations/001_initial_schema.sql` (call_logs at ~:61),
`016_call_log_caller_name.sql`.

### 1a. Backup copies — added 3 Aug 2026

The inventory above describes the *live* store. Transcripts and caller phone numbers also
exist in **database backups**, which is material to any retention or deletion question:

| Location | Contents | Retention |
|---|---|---|
| `gs://vocotable-backups-497209/` (GCS, australia-southeast1 / Sydney) | Nightly `pg_dump` of the whole database, including `call_logs.transcript`, `call_logs.caller_phone` and `customers` | ~30 daily snapshots on a rolling window |
| `/opt/vocotable/backups/` on `core-central-vm` | Second, local-only nightly dump of the same data | Local pruning |

Verified 3 Aug 2026: 31 objects, newest `db-20260803-062501.sql.gz`, schema identical to
the live database. Data residency is Australian (Sydney region) for the offsite copy.

**Implication for deletion:** "delete the corpus" is not a single action. It means
Postgres *and* Retell's storage *and* up to 30 days of rolling backups, both offsite and
on-VM. A deletion instruction that stops at the live database leaves recoverable copies
for a further 30 days.

## 2. Who processes it (subprocessors actually in the data path)

| Processor | Role | What they hold |
|---|---|---|
| **Retell AI** | Voice agent platform | Call audio, recordings, transcripts, LLM prompts/outputs; their LLM subprocessors see transcript content |
| **Twilio** | Telephony / SIP | Caller + called numbers, call metadata, SIP media transit |
| **Postgres (self-hosted, GCP VM `core-central-vm`)** | Primary store | Transcripts, summaries, phone numbers, names, bookings |
| **Cal.com** | Booking mirror | Customer name, booking time; synthetic email |
| **Google/Firebase** | Dashboard auth only | Staff/owner identities, not caller data |
| **Slack (ops webhook)** | Alerting | Aggregate counts only; logger redacts PII (`apps/backend/src/utils/logger.ts`) |
| **Stripe** | Billing | Restaurant billing data, not caller data |
| **Sentry** | Error tracking | Scaffolding present; `SENTRY_DSN` unset in production today → inactive |
| **Google Cloud Storage** (`vocotable-backups-497209`, Sydney) | Backup storage | Full nightly database dumps — transcripts, caller phone numbers, names. See §1a |

## 3. What the signed agreement promises vs what the system does

| Promise (agreement / onboarding wizard) | Reality in code / config |
|---|---|
| Restaurant certifies the agent **announces it is an AI** | No such announcement in the live prompt (see `deploy/retell-snapshots/*/llm-*.json`) |
| Restaurant certifies the agent **announces recording** | No such announcement |
| `retention_days` election (30 or 90 — Schedule B §8); migration comment: "Provisioning fails closed on NULL — 'keep forever' must be impossible" (`db/migrations/018_legal_layer.sql:24-26`) | **Enforced by no code.** The value is written to `restaurants.retention_days` (`src/repositories/agreements.ts:63`) and read by nothing. No Retell API call sets a retention/data-storage setting; no cleanup job deletes `call_logs` rows, transcripts, or recordings. The cleanup worker's 30-day retention applies only to internal queue tables (`src/workers/cleanupWorker.ts:27,40-66`) |
| `pii_redaction` election (`storage_tier: everything_except_pii`) | Stored (`agreements.ts:65`), applied nowhere; the live Retell agent runs with no redaction |
| Marketing site: "your regulars won't know she's AI" | Direct tension with the certification above — flagging for the lawyer, not for us to resolve |

Net: **call data is currently retained indefinitely** on Retell and in Postgres,
regardless of what the restaurant elected.

## 4. Volumes — measured 3 Aug 2026

Run against production (read-only):

```sql
SELECT count(*) AS total_calls,
       count(*) FILTER (WHERE transcript IS NOT NULL) AS with_transcript,
       count(*) FILTER (WHERE recording_url IS NOT NULL) AS with_recording,
       min(started_at) AS earliest_call
FROM call_logs;
```

| Measure | Value |
|---|---|
| Total calls | **41** |
| With stored transcript | **22** |
| With stored recording URL | **22** |
| Earliest call | **2026-05-25 02:25:52 UTC** |

Read: the affected corpus is **22 recorded-and-transcribed calls** over roughly ten
weeks. The 19 remaining rows have neither a transcript nor a recording — consistent with
calls that ended before the agent engaged.

**This materially changes question 2 below.** Deleting or remediating 22 recordings is a
different proposition from deleting thousands; whatever the lawyer advises, the corpus is
small enough that the most conservative option remains cheap to execute. That is worth
saying out loud in the meeting, because it widens the range of advice that is practical.

Retell dashboard (Sam): confirm the agent's current data-storage/retention setting and
whether recordings are downloadable/deletable via their API; export their DPA/subprocessor
list.

## 5. What can be prepared without pre-empting advice

- This inventory (done).
- A deletion capability inventory: Retell exposes delete-call APIs; Postgres rows are ours;
  Twilio call records have their own retention. **Not built** — listed so the lawyer knows
  a retention fix is implementable if advised.
- The disclosure line itself is a one-line prompt change + snapshot, deployable within an
  hour of legal sign-off (`deploy/retell-snapshots/README.md` documents the process).

## 6. Open questions for the lawyer

1. Disclosure wording and placement (greeting vs IVR-style preamble) for NSW SDA 2007
   compliance, given all current venues are NSW.
2. Whether the existing corpus of undisclosed recordings must be deleted, and on what
   timeline. Corpus is **22 recorded calls** (§4). Note that deletion must reach Retell's
   storage, Postgres, and up to 30 days of rolling backups (§1a) to be complete.
3. Whether the agreement's restaurant-certifies model is salvageable, or whether the
   platform must make the announcement itself (we control the greeting; the restaurant
   does not).
4. Whether `retention_days` non-enforcement constitutes a breach of the already-signed
   agreement, and the remediation priority that implies for the enforcement work.
5. The marketing claim ("won't know she's AI") against the disclosure obligation.
