# Biteperk — call recording and disclosure: brief for legal review

**Prepared:** 3 August 2026
**Prepared by:** Sam Kalaliya, Biteperk
**Subject:** AI voice agent taking restaurant bookings by phone; recording and
transcription occur without disclosure to the caller. All venues currently in NSW.

---

## 1. What the product does

Biteperk operates an AI voice agent ("Bella") that answers a restaurant's phone line and
takes table bookings. When a customer calls the restaurant, the agent answers, converses,
and creates the booking.

Every such call is **recorded and transcribed in full**.

The agent does **not** announce that it is an AI, and does **not** announce that the call
is being recorded.

---

## 2. The specific question

We would like advice on disclosure obligations under the **Surveillance Devices Act 2007
(NSW)**, and any adjacent obligations (Privacy Act / APPs) that apply, given:

1. Calls are recorded and transcribed without an announcement to the caller.
2. The signed customer agreement has the **restaurant certify** that the agent announces
   both that it is an AI and that the call is recorded — a certification that does not
   match what the software does.
3. Our marketing materials state the opposite of disclosure — that a restaurant's
   "regulars won't know she's AI."

We have paused on this pending advice, rather than shipping a disclosure line we have
guessed at.

---

## 3. What is collected, per call

| Data | Where it is stored |
|---|---|
| Full call audio recording | Retell AI's storage; we retain the URL |
| Full verbatim transcript, both sides | Our production Cloud SQL database in Sydney |
| Caller phone number | Our database; also held by Twilio as carrier records |
| Caller name | Our database — collected conversationally by the agent |
| AI-generated call summary | Our database |
| Booking details | Our database, mirrored to Cal.com |

Transcripts are unfiltered: whatever the caller says is stored verbatim, which can include
names, phone numbers, and incidental personal or health information.

---

## 4. Who else processes the data

| Processor | Role | What they hold |
|---|---|---|
| **Retell AI** | Voice agent platform | Audio, recordings, transcripts, LLM prompts and outputs. Their own LLM subprocessors see transcript content |
| **Twilio** | Telephony / SIP | Calling and called numbers, call metadata, media in transit |
| **Cloud SQL** (`voxtable-prod-postgres`) | Primary production store | Transcripts, summaries, phone numbers, names, bookings |
| **Google Cloud Storage** (Sydney) | Nightly database backups | Full copies of the above, ~30-day rolling window |
| **Cal.com** | Booking mirror | Customer name, booking time |
| **Google / Firebase** | Dashboard sign-in only | Staff identities — not caller data |
| **Stripe** | Billing | Restaurant billing data — not caller data |

---

## 5. Volume of affected data

Measured against production on 3 August 2026:

| Measure | Value |
|---|---|
| Total calls handled | **41** |
| Calls with a stored transcript | **22** |
| Calls with a stored recording | **22** |
| Earliest call | **25 May 2026** |

The affected corpus is **22 recorded and transcribed calls** over approximately ten weeks.
The remaining 19 rows hold neither transcript nor recording, consistent with calls that
ended before the agent engaged.

We raise the small size deliberately: if the advice is that the existing corpus should be
deleted, that is entirely practical for us to do. We would rather know that than assume
deletion is disproportionate.

---

## 6. Gap between what the agreement promises and what the system does

Two elections are offered to restaurants at onboarding and stored against their account:

- **Retention period** — 30 or 90 days.
- **PII redaction** — store everything except personal information.

Both values are recorded in our database. **Neither is enforced by any code.** No process
deletes call data on a schedule, and no redaction is applied at the voice platform. In
practice, call recordings and transcripts are currently **retained indefinitely**,
irrespective of what a restaurant elected.

We are treating this as a factual disclosure to you rather than characterising it
ourselves. Whether it constitutes a breach of the signed agreement is one of the questions
below.

Note also that "deleting" call data is not a single step: it must reach Retell's storage,
our database, and up to 30 days of rolling backups.

---

## 7. What we can implement quickly, once advised

- **A disclosure announcement** — a change to the agent's greeting, deployable within an
  hour of sign-off. We control the greeting; the restaurant does not.
- **Deletion of the existing corpus** — Retell exposes delete APIs; the database rows are
  ours; backups age out on a 30-day window.
- **Retention enforcement** — not currently built, but implementable. We have deliberately
  not started it pending advice on what the retention period should actually be.

---

## 8. Questions

1. **Disclosure wording and placement.** What must be announced, and where — in the
   greeting, or as a preamble before the agent engages — to satisfy the NSW SDA 2007?
2. **The existing corpus.** Must the 22 recordings made without disclosure be deleted, and
   on what timeline?
3. **The certification model.** The agreement has the restaurant certify that an
   announcement is made, when only we control the greeting. Is that model salvageable, or
   must the platform make the announcement itself?
4. **Retention non-enforcement.** Does storing but not enforcing the elected retention
   period breach the agreements already signed, and how urgently must that be remediated?
5. **Marketing.** Our public claim that callers "won't know she's AI" sits against any
   disclosure obligation. What needs to change?
6. **Expansion.** All venues are currently in NSW. If we take on venues in other states,
   which jurisdictions change the answer to question 1?

---

## 9. Attachments available on request

- Full technical inventory with code and schema references.
- Retell agent configuration snapshots, including the live prompt.
- The signed customer agreement and onboarding wizard copy.
- Retell and Twilio DPAs and subprocessor lists.
