# ACMA SMS Sender ID Register — registering `BitePerk`

**Status as of 18 Aug 2026: ✅ APPROVED — `BitePerk` is registered with the ACMA.** Both decisions
landed together at **16:00 AEST on 18 Aug 2026**, seven days after lodgement. Registration is done,
and **the code side shipped 18 Aug 2026** (§6.2). What remains is **console-side only** (§6.1) —
**the sender ID is not in use yet, and nothing sends as `BitePerk` until someone adds it to the
Messaging Service sender pool.**

### Approval record (18 Aug 2026)

Two separate ACMA decisions, both required, both now granted:

| Decision | Outcome | Evidence |
|---|---|---|
| **Participation** — is Biteperk Pty Ltd allowed on the register at all | ✅ Approved | `asic/04-correspondence/2026-08-18_ACMA_SenderID_Participation_Approved.pdf` |
| **Sender ID registration** — is the string `BitePerk` registered to us | ✅ Approved | `asic/04-correspondence/2026-08-18_ACMA_SenderID_BitePerk_Registered.pdf` |

Both notices were issued to `sam@biteperk.com.au` from `no-reply@digital.acma.gov.au`, addressed to
Sameer Kalaliya, and record the application as **submitted by Twilio Inc. on behalf of Biteperk Pty
Ltd** — which is what the "Certified telco submits for you" route in §3 looks like when it works.

Both state: *"This decision has been made by the operation of computer programs."* Automated
decisions, so treat the outcome as data-driven rather than discretionary — if a future amendment is
refused, the fix is almost always the submitted data, not an argument.

**Appeal window — 28 days (expires ~15 Sep 2026).** Under s558(1) of the *Telecommunications Act
1997* a reconsideration must be applied for in writing within 28 days of being informed, then the
Administrative Review Tribunal. Irrelevant while approved; relevant if a later amendment or renewal
is refused. Contact for anything register-related: `senderIDregister@acma.gov.au`.

⚠️ **ACMA registration ≠ Twilio provisioning.** ACMA has registered the *company and the string*.
Twilio still binds the sender ID **per Account SID** (§5), and our code still sends from a phone
number (§6). Approval alone changes nothing on a handset.

**No fee was requested.** The lodgement note below flagged a possible post-approval payment step;
neither approval email asked for one. Treat the "possible fee" caveat as closed unless Twilio
invoices separately.

### Lodgement record (11 Aug 2026 — historical)

| | |
|---|---|
| Sender ID | `BitePerk` — country **AU**, use case **TRANSACTIONAL**, business identity **DIRECT** |
| Business name as submitted | `Biteperk Pty Ltd` |
| Account SID | `ACd423bd09e9649e552a0b6d19a9eed338` (**Biteperk-production**) |
| **Sender ID Bundle SID** | **`BUce1fa0ad6053c4444f3faca4c7957f25`** |
| Twilio ticket | `28926493` — encoded `MM5M2N-YGJRK`, `help.twilio.com/tickets/28926493` |
| Correspondence | from `senderid@twilio.com` → `sam@biteperk.com.au` (reply to that thread to amend) |
| Track status | `console.twilio.com/us1/develop/phone-numbers/sender-ids` |

> ⚠️ **Two different Bundle SIDs — do not conflate them.** The sender ID application has its own
> bundle (`BUce1fa0…`), which is **not** the approved Primary Customer Profile bundle
> (`BU975db7eebfb0b5525d6762f3d77e2087`) recorded elsewhere in this runbook and in `CLAUDE.md`.
> The customer profile is the identity evidence; the sender ID bundle is this application. Quote
> `BUce1fa0…` when chasing or correcting *this* registration.

**Review path (as it actually ran):** lodged 11 Aug → Twilio internal review → ACMA →
**both approvals 18 Aug**. Seven calendar days end to end against a stated "up to 3 days" for
Twilio's leg alone. Budget a week, not three days, for the next one.

**The deadline has already passed.** Registration closed to "in time" applicants on
**1 July 2026** — from that date any unregistered alphanumeric sender ID sent to an Australian
mobile is replaced with the word **`Unverified`** and threaded alongside scam messages. The
register did not close; late applications are still accepted. It just means we cannot turn on a
sender ID first and register second. **Register, then flip the config.**

---

## 1. What we are registering

| | |
|---|---|
| Sender ID | **`BitePerk`** |
| Length | 8 characters (ACMA limit: 2–11) ✅ |
| Charset | **ACMA rule — A–Z only**, starts with a letter, no space/underscore at either end ✅ |
| Restricted words | None. The [restricted list](https://www.acma.gov.au/restricted-terms-sender-ids) (`alert`, `info`, `secure`, `verify`, `support`, …) bans IDs made up *only* of those words. `BitePerk` contains none ✅ |
| Valid use case | Exact match to registered company name **BITEPERK PTY LTD** and to the domain **biteperk.com.au** — the strongest evidence class available ✅ |

Registering the company name rather than the product brand is deliberate: `VoxTable` would need
separate business-name, trademark or domain evidence tying it to Biteperk Pty Ltd. Worth doing
later — see §7.

> ⚠️ **Two rule sets apply, and ACMA's is the stricter one.** The table above is ACMA's
> *registration* rule (A–Z only). Twilio's *technical* limit for putting a string in a Messaging
> Service pool is looser — ASCII letters, digits and spaces, up to 11 characters, at least one
> letter (§6.1). A sender ID must satisfy **both**. When picking a future ID such as `VoxTable`,
> design to the ACMA rule: a digit passes Twilio and fails ACMA, which is the slow and expensive
> end of the process to discover it.

---

## 2. Prerequisite that fails most applications — fix this first

> **The ABR record must be current before the application is lodged.**

ACMA verifies authority via the **Australian Business Register**, specifically the *authorised
contact* and *service of notice email address*. It explicitly does **not** check Relationship
Authorisation Manager (RAM). If the ABR email is stale, the verification email never arrives and
the application stalls with no useful error.

> ✅ **All of §2 completed before the 11 Aug lodgement** — the 18 Aug approval is the proof: ACMA's
> identity verification cannot pass on a stale ABR record or without myID. Kept ticked rather than
> deleted because **a second sender ID (`VoxTable`, §7) repeats every step**, and because the ABR
> record needs to stay current for renewals and change requests.

- [x] Log in to [abr.gov.au](https://www.abr.gov.au) for ABN **36 700 831 303**
- [x] Confirm the authorised contact is Sam and the service-of-notice email is a mailbox actively monitored (`hello@biteperk.com.au` or a personal address — not a shared alias nobody reads)
- [x] Update if wrong, then **wait for the change to propagate** before lodging (allow a few business days)
- [x] Confirm the ABN shows as **active** and the entity name reads `BITEPERK PTY LTD`

- [x] Confirm Sam has a **myID** identity (Standard strength or better). ACMA sends a verification step that is completed through myID — set it up now if it doesn't exist, it takes longer than you'd expect.

---

## 3. Registration route — through Twilio, not directly with ACMA

Businesses do not register with ACMA directly. The **telco or message provider registers on your
behalf**, and only providers approved as *participating* or *certified* telcos can do it.

- [x] **Verified 10 Aug 2026 — Twilio is approved, at the highest status.** On ACMA's [approved telcos list](https://www.acma.gov.au/approved-telcos-and-message-providers-sms-sender-id-register): *Twilio Inc.* (ABN 56 811 703 253) is a **Certified telco**; *Twilio Australia Pty Ltd* (ABN 82 618 090 010) is an Originating telco. Certified is the status that can also register on behalf of entities **without** an ABN — relevant if we ever register for international or ABN-less venues.

- [x] ~~🚫 **BLOCKER — the Twilio account is on a trial and cannot register a sender ID.**~~ **Resolved — `Biteperk-production` was upgraded off trial on 10 Aug 2026**, which is what unblocked the whole registration. Kept for the account-identity side finding below, which is what led to discovering there are three Twilio accounts, not two. Verified 10 Aug 2026: account `Biteperk-production` (`ACd423bd09e9649e552a0b6d19a9eed338`) shows *Trial, 26 days left, trial phone number*. Both `/sms/senders/alpha-sender-ids` and `/phone-numbers/regulatory-compliance/bundles` hard-redirect to `/upgrade/v2`. Twilio lists *"Verify your brand for reliable delivery"* as an upgrade-gated feature. **Nothing can be filled in or submitted until the account is upgraded** (requires adding funds).
  - Side finding worth chasing: an account named `Biteperk-production` sitting on a trial with a *trial* number contradicts the production AU number + `algorythmos` SIP trunk described in `CLAUDE.md`. Either production runs under a different Twilio account/login, or the voice path is not where we think it is. **Resolve this before upgrading** — upgrading the wrong account wastes the spend and registers the sender ID against the wrong ACCOUNT SID.
- [x] ~~Once upgraded, open the AU alphanumeric sender ID registration flow.~~ **Done — lodged 11 Aug 2026, approved 18 Aug 2026** (7 calendar days end to end, against the ~2 weeks quoted here).
- [x] **Trust Hub Primary Customer Profile APPROVED 10 Aug 2026.** Notifications to `hello@biteperk.com.au`; no status callback URL set (nothing listening).
  - **Bundle SID `BU975db7eebfb0b5525d6762f3d77e2087`** — Account SID `ACd423bd09e9649e552a0b6d19a9eed338` (also its own Parent Account SID, i.e. not a subaccount). The Bundle SID is what the sender ID registration attaches to; quote it in any Twilio support ticket about this profile.
- **Trust Hub Primary Customer Profile** is the real prerequisite — the sender ID flow redirects into it. Business verification is handled by **Persona** (`inquiry.withpersona.com`), not Twilio directly. Values used (10 Aug 2026): friendly name `BitePerk Pty Ltd`; authorised individual **Sameer Kalaliya**, Director, `hello@biteperk.com.au`, `+61 450 011 140`; legal name `BITEPERK PTY LTD`; ABN `36700831303` (digits, no spaces).
  - **Declared as "Direct Customer", not "ISV Reseller or Partner"** — accurate while we register only BitePerk's own sender ID and notifications are off. **Revisit the moment a venue gets its own Twilio number or sender ID**: that is the ISV pattern (Primary profile for BitePerk + a Secondary Customer Profile per venue), and switching after the fact means restructuring the Trust Hub account. Tied to the multi-tenant decision in §7.
  - Use the individual's **legal given name** (`Sameer`, not `Sam`) — it must match the ID document used for Persona and later for the myID step with ACMA.
- [x] Submit `BitePerk` with supporting evidence (assemble §4 first). **Lodged 11 Aug 2026.**
- [x] Respond to the ACMA verification email when it lands — complete identity verification via myID. **Completed; approval landed 18 Aug 2026.**
- [ ] ⬅️ **The one genuinely open item in §§2–4.** Record the approval reference and approval date in `deploy/runbooks/vendor-accounts.local.md`.

---

## 4. Evidence pack to assemble before lodging

> **What Twilio's ACMA registration step actually demands** (observed in the console 10 Aug 2026,
> at Registration Details → Start). This supersedes the generic list below:
>
> 1. **Business proof** — an up-to-date commercial registration extract showing the business
>    registration number **and company officers**, *or* an up-to-date **screenshot of the ABR
>    contacts page**. The ABR record being current is therefore a hard requirement, not just a
>    downstream risk (see §2).
>    - ⚠️ **`asic/01-register/2026-07-29_ASIC_Certificate_of_Registration_ACN_700831303.pdf` does NOT
>      satisfy this.** A Certificate of Registration proves the company exists but names **no
>      officers** — verified by reading it. Twilio requires the officer name on the document.
>    - ✅ **Current Company Extract purchased 11 Aug 2026** — ASIC Connect, $10.00, receipt
>      `9000009643361513000`, delivered to `sam@biteperk.com.au`. **ASIC's download links expire
>      after 90 days — file the PDF in `asic/01-register/` immediately.** Order it by ACN
>      `700831303` → *Information for purchase* → *Current company information* ($10). Do NOT buy
>      *Current and historical* ($21); the change history is not needed.
>    - Since 02/02/2026 ASIC omits officeholder **addresses** from purchased extracts. Harmless
>      here — the officer *name* still appears, which is what Twilio checks.
> 2. **Sender ID proof** — evidence connecting the brand to the requested sender ID. For
>    `BitePerk` the exact company-name match (`BITEPERK PTY LTD`) plus ownership of
>    `biteperk.com.au` is the strongest available; a trademark certificate is stronger still.
> 3. **Company officer verification** — ID of the Company Officer (recommended), *or* ID of an
>    Authorised Representative plus a signed Letter of Authorisation from the officer. Sam is a
>    Director, so use the officer route; the ID must read **Sameer Kalaliya** to match the profile.
>
> Registration intake already accepted (10 Aug 2026): `globalHqCountry=AU`, `targetCountry=AU`,
> `messagePurpose=TRANSACTIONAL`, `businessIdentity=DIRECT`, `senderId=BitePerk`, friendly name
> *BitePerk AU transactional sender ID*, attached to Bundle `BU975db7eebfb0b5525d6762f3d77e2087`.
> **Transactional, not Promotional** — booking confirmations and reminders; declaring Promotional
> would pull in marketing-consent obligations under the Spam Act.


Pull these into one folder so the submission isn't blocked mid-flight:

> ✅ **Assembled and accepted for the `BitePerk` lodgement (11 Aug 2026).** Ticked because the
> approval is the proof. Retained as the shopping list for **the next registration** — `VoxTable`
> (§7) needs the same pack, plus the trademark certificate that was optional here.

- [x] **ABN/ABR extract** showing `BITEPERK PTY LTD`, ABN `36 700 831 303`, status *active*
- [x] **ASIC company extract** — ACN `700 831 303` — the Current Company Extract purchased 11 Aug 2026, filed in `asic/01-register/`
- [x] **Registered office address** — Level 1, 457–459 Elizabeth Street, Surry Hills NSW 2010
- [x] **Domain ownership evidence** for `biteperk.com.au` (registrar record / Cloudflare zone) — reinforces the brand link
- [x] **Authorised administrator details** — Sam's name, role, and the ABR-matching email
- [ ] **Trademark certificate** — not required for `BitePerk` (the exact company-name match carried it), **mandatory when registering `VoxTable`**. VoxTable cleared trademark review in Jul 2026, so the certificate likely exists; locate it before lodging §7.

Every one of these must be **byte-identical** to the canonical facts in the brand kit. A mismatched
address or a `Biteperk` vs `BITEPERK PTY LTD` discrepancy is a rejection.

---

## 5. Account SID scope — which accounts may send as `BitePerk`

> 📖 See also [`twilio-account-topology.md`](twilio-account-topology.md) for how sender IDs
> sit alongside customer profiles and regulatory bundles. Key point: all three are
> account-scoped, but **only regulatory bundles have a Clone API**. A sender ID cannot be
> cloned — extra accounts must be added to the registration by Twilio support.

> **Source: Ankita Mohanty (Twilio Product Operations), ticket 28926493, 12 Aug 2026.**
> Archived at `Sender ID across multiple Account SIDs.pdf` in the repo root — ⚠️ **local only,
> gitignored by `/*.pdf`**, so it is not in a fresh clone. Ask Sam, or pull it from the ticket.

Twilio stated two rules that change how this interacts with our staging/production split:

1. **The sender ID is bound per Account SID.** *"If you send messages from an Account SID that
   does not have your approved Alphanumeric Sender ID configured, your messages will be delivered
   as 'unverified'."* Approval on one account does **not** cover another.
2. **Additional Account SIDs can be added to this registration** by replying to the ticket, or via
   support later.

### What this breaks if ignored

The registration was lodged against **`ACd423bd09e9649e552a0b6d19a9eed338` (Biteperk-production)**
only. Consequences:

- **The "prove it in staging first" convention cannot be honoured for branded SMS** unless
  `AC8116857da2064ef3251533f3ade56f32` (**Biteperk-staging**) is added to the registration.
  ⚠️ **Corrected 18 Aug 2026 by an actual test — the failure is quieter than predicted.** This
  section used to say a staging send arrives stamped `Unverified`. It does not. With `BitePerk`
  sitting unregistered in the staging pool, the send **delivered from the phone number instead**,
  with no stamp, no error and no log line distinguishing it from a correctly-unbranded send. AU
  sender-selection deprioritises an unregistered ID rather than emit something that would read
  `Unverified`. Measured at 13:50Z — see the delivery test log in §6.4.

  **So the signal you are looking for does not exist.** Do not debug a staging send by hunting for
  an `Unverified` stamp; the observable symptom of "this account is not on the registration" is
  silent fallback to the number, which looks identical to success.
- **§6's staging test step assumes this is resolved.** Do not read "roll out in staging first" as
  achievable until staging's SID is on the registration.
- ✅ **The production-voice account question is resolved** (it was open when this section was
  written): the live AU voice number sits on the **Algorythmos** account
  `AC949756ac8dc4aced25b15b2e0bbb3a61`, and neither BitePerk account carries live calls. SMS from
  `ACd423bd09…` is correct and unaffected. Full map: [`NUMBERS.md`](../../NUMBERS.md). The general
  rule still stands, and is why the account map matters: **send from any account other than
  `ACd423bd09…` and the message is not branded** — silently falling back to that account's number,
  per the correction above.
- **Multi-tenant:** `Parent Account SID: N/A` — this is a standalone account today, not a
  subaccount parent. Whether subaccounts created by `provisioningWorker` would inherit the sender
  ID is **unknown and must not be assumed**; ask before designing per-venue messaging on it.

### Action

⚠️ **Updated 18 Aug 2026 — the cheap window has closed.** The advice below was to add staging's SID
*during* review; the registration is now approved, so this is a support round-trip. Still worth
doing, but it is no longer free.

- [ ] Ask Twilio (ticket 28926493) to add `AC8116857da2064ef3251533f3ade56f32` (staging) to the
      approved `BitePerk` registration
- [ ] Ask in the same message whether additional SIDs affect fee or review time, and whether
      subaccounts inherit the approved sender ID
- [ ] Record the final approved SID list here once confirmed

**Until that lands, `BitePerk` works on production only.** Any branded-SMS test run on staging is
measuring the wrong account and will silently deliver from the number instead — see §6.4.

---

## 6. Turning it on — the actual integration (approval landed 18 Aug 2026)

ACMA has approved, and **the code side shipped 18 Aug 2026** (§6.2). **Nothing sends as `BitePerk`
yet**, because the remaining steps are all console-side — which is deliberate: the deploy went first
so that branding is a console flip with no deploy behind it, and so a failure is attributable to one
change or the other rather than both at once. In dependency order:

### 6.1 Twilio side (console, no deploy)

- [ ] **Confirm the sender ID shows approved in the console** —
      `Numbers & senders → Alphanumeric sender IDs` on `ACd423bd09…`. ACMA's email is not Twilio's
      state; the console is what the API reads.
- [ ] **Enable the account-wide toggle** — `Messaging → Settings → General` →
      **Alphanumeric Sender ID: Enabled**. A registered sender ID is ignored while this is off, and
      the failure is silent.
- [ ] **Check `Messaging → Settings → Geo Permissions` has Australia enabled.** Geo permissions
      cannot be set through the API (error `30649` — console only, Account Owner/Admin), and if AU is
      off every send fails `21408` in a way that looks nothing like a sender-ID problem. Note
      subaccounts **inherit** geo permissions from the parent by default; sender IDs may not, which
      is the open question on ticket 28926493 (§5).
- [ ] **Add `BitePerk` as a sender on `voxtable-prod-notifications`** (`MG7ceaa2aaa3cea6195ea7979d57b78b14`),
      keeping `+61 468 202 846` in the sender pool as fallback. **Removing the number would strip the
      documented fallback** — see §6.2. Exact casing matters: `BitePerk`. **Twilio's** limit for a
      pool entry is 11 characters, ASCII letters/digits/space, at least one letter — looser than
      **ACMA's registration rule** (§1: A–Z only, 2–11). A new sender ID must satisfy both.

### 6.2 Code side — ✅ SHIPPED 18 Aug 2026

**Status: done.** `sendSms` now sends through the Messaging Service. What follows records what was
built and, more importantly, the two traps that were found on the way — neither of which was in the
original recipe here.

`workers/notificationWorker.ts::sendSms` used to call:

```ts
await client.messages.create({ to: row.recipient, from: env.NOTIFICATIONS_SMS_FROM, body: row.body });
```

`from` accepts an alphanumeric string, so the minimum change *would* have been one env var —
`NOTIFICATIONS_SMS_FROM=BitePerk`. We did not do that: a bare alphanumeric `from` has **no
fallback**, and a destination that doesn't support alphanumeric senders fails the send outright.
Twilio's graceful degradation is a property of the Messaging Service, not of the `from` field:

> "For SMS messages sent to a supported country, the Messaging Service sets your alphanumeric sender
> ID as the `From` parameter. If the destination country doesn't support alphanumeric sender IDs,
> Twilio uses a phone number from the Messaging Service instead."

That fallback only holds while a phone number stays in the pool. **Never remove the number when
adding the sender ID.**

#### ⚠️ Trap 1 — passing both parameters silently un-brands everything

Twilio reads `{messagingServiceSid, from}` **together** as "keep the service's features but pin this
`From`", which switches OFF automatic sender selection. Production has `NOTIFICATIONS_SMS_FROM` set
— the boot gate *required* it until Trap 2 below was fixed, and it remains set as the rollback path
— so a naive spread of both would have pinned the phone number permanently, and adding `BitePerk` to
the pool would then have done nothing at all, with no error anywhere to explain why.

`services/notificationService.ts::resolveSmsSender` therefore returns **exactly one** parameter,
Messaging Service first, and `notificationService.test.ts` asserts it never returns both. We
deliberately do not use Twilio's pin behaviour: it makes "are we branded right now?" unanswerable
from env alone.

#### ⚠️ Trap 2 — the boot gate

`config/env.ts` required `NOTIFICATIONS_SMS_FROM` whenever `ORDER_PAYMENTS_ENABLED=true`. Setting
only the Messaging Service SID would have made production **refuse to boot** on the fail-closed
gate — a dead revision, not a degraded one. The gate now accepts *either* sender. The issue is still
reported against `NOTIFICATIONS_SMS_FROM` so the message appears where anyone who has hit it before
will look.

#### What shipped

| File | Change |
|---|---|
| `config/env.ts` | `NOTIFICATIONS_MESSAGING_SERVICE_SID` (`MG` + 32 hex, `blankAsUnset`); order-payments gate accepts either sender |
| `services/notificationService.ts` | `resolveSmsSender` (pure) + `smsSenderParams`; `isSmsEnabled()` accepts either |
| `workers/notificationWorker.ts` | `sendSms` spreads the single resolved sender parameter |
| `scripts/smoke-sms-sender.ts` | `npm run smoke:sms-sender` — see §6.4 |

**Rollback is an env change, no deploy:** unset `NOTIFICATIONS_MESSAGING_SERVICE_SID` and the worker
falls back to `NOTIFICATIONS_SMS_FROM`. Faster still, remove `BitePerk` from the sender pool in the
console — that needs no deploy at all.

**Blast radius is one code path.** SMS is enqueued in exactly one place today —
`orderPaymentService.ts` (voice-order payment links, `channel: "sms"`). Booking confirmations do
not currently send SMS.

### 6.3 Copy compliance — already handled, keep it that way

Alphanumeric SMS is **one-way**: recipients cannot reply and `STOP` does not work, so every message
needs an alternative opt-out and must never invite a reply.

The existing payment-link copy already complies — `orderPaymentService.ts` appends
*"Do not reply to this message."*, and `orderPaymentService.test.ts` asserts the phrase is present.
The negative assertion was **broadened on 18 Aug 2026**: it used to match only
`reply yes|now|to confirm`, which would have waved through "reply STOP to opt out" or "text us
back". It now strips the one sanctioned mention of "reply" and asserts nothing else in the message
asks for a response, plus that `STOP` never appears — offering `STOP` on a one-way sender is a lie,
since it can never be processed. **That test is the guardrail; any new SMS template must be covered
by an equivalent assertion before it ships.**

### 6.4 Verify

`npm run smoke:sms-sender` reads the Messaging Service config **back from the Twilio API** rather
than trusting what was typed into the console, and is **read-only by default** — safe to run against
production. It asserts the service belongs to the configured Account SID (the guard against a
staging SID leaking into a production env map), lists the sender pool, and **fails if an alphanumeric
sender is configured with no phone number behind it**, since that is a pool with no fallback.

```bash
TWILIO_ACCOUNT_SID=AC… TWILIO_AUTH_TOKEN=… \
NOTIFICATIONS_MESSAGING_SERVICE_SID=MG… \
npm run smoke:sms-sender --workspace=@voxtable/backend
```

Send mode is staging-only. It costs money and texts a real handset, so it is behind an explicit
flag and must use staging credentials and a staging Messaging Service. It does **not**
stop at `messages.create` resolving — that returns `queued`, which proves only that Twilio accepted
the request. It polls the Message resource until a terminal status and asserts `delivered`:

```bash
SMS_SEND_TEST=true SMS_TEST_TO=+61… npm run smoke:sms-sender --workspace=@voxtable/backend
```

- [ ] Run read-only against production **before** the console step — confirms the service/account
      binding and the number in the pool while nothing is branded yet.
- [ ] Run read-only **after** the console step — now expecting `BitePerk` *and* the number.
- [ ] Exercise SMS delivery and copy only in staging. If the staging account cannot select the
      registered alpha sender, record that limitation; it does not authorise a production test.
- [ ] In production, stop after the two read-only checks above. Monitor the sender shown on the
      first genuine customer message and alert on `Unverified` or numeric fallback. Do not send
      a test message or create a dummy recipient interaction.

#### Delivery test log

Real send-mode results, newest first. "From" is the sender the handset actually showed, not
what the script requested.

**2026-08-18 — staging** (account `AC8116857da…`, service `voxtable-staging-notifications`
`MG692c54a793f914c2e43c7d691f4cb41e`, to `+61450011140`):

- **13:33Z — delivery mechanics proven.** Pool was number-only. Polled `accepted → sent →
  delivered`; from **`+61 468 203 234`**; no error; message SID `SM9b2e67d767d8ff99ffc36986ab7d7426`.
  Handset received it. This is the real value of a staging send — the Messaging Service path
  delivers end to end.
- **13:50Z — branded send does NOT happen on staging, as designed.** `BitePerk` was added to the
  staging pool (alphanumeric, destination Australia) first, then sent with
  `EXPECTED_ALPHA_SENDER=BitePerk`. Still **delivered from the number `+61 468 203 234`** — it
  landed in the *same* handset thread as the 13:33 message, i.e. **not** as `BitePerk`. Two causes,
  both of which reverse on production: (a) `BitePerk` is **unregistered** on the staging account, so
  AU sender-selection deprioritised it rather than send something that would read `Unverified`; and
  (b) **sticky sender** — the service reuses the sender already bound to a recipient, and the number
  was already bound from 13:33. Confirms §5 empirically: **staging cannot produce a clean branded
  send.** `BitePerk` was deliberately **left in the staging pool** afterwards (not removed).

  ⚠️ **Consequence of leaving it there — staging now carries an unregistered alpha sender.**
  The 13:50Z send was protected by sticky sender: `+61450011140` was already bound to the number
  from 13:33, so selection never had to choose. **A fresh staging recipient has no such
  protection** and is the first realistic chance to see `30042` on this account. That is a
  reasonable thing to want (staging is internal-only, and a real `30042` is useful evidence for
  ticket 28926493), but it must be a decision rather than a surprise — notably for **leg 6 of
  [`staging-call-battery.md`](staging-call-battery.md)**, which now points at this same Messaging
  Service. If leg 6 should measure plain delivery rather than sender selection, either reuse a
  recipient already bound to the number or remove `BitePerk` from the staging pool first.

  **Production monitoring caveat:** sender selection is sticky per recipient. Observe the first
  genuine customer delivery without manufacturing a production test. If an existing recipient is
  already bound to a numeric sender, that observation may continue to show the number.

**Production — no test send is permitted.** Expected genuine delivery: from `BitePerk`, no
`Unverified` stamp. Validate configuration by read-back and validate delivery through monitoring
of genuine customer traffic only.

#### Error codes, and what each actually means

These are indistinguishable from "the code is broken" if you have not seen them before:

| Code | When | Meaning / fix |
|---|---|---|
| `21709` | Adding the sender to the service | Alpha sender invalid, or the account-wide toggle is off. Fix the toggle first — this error *is* the signal. |
| `30042` | Send (carrier) | Sender ID generic or unauthorised for this account. This is what a staging send hits. |
| `30041` | Send | Sender unregistered for the destination country. Also fires on a **case mismatch** — matching is case-sensitive, so `Biteperk` ≠ `BitePerk`. |
| `21657` | Send | `From` not supported for that destination. |
| `21408` | Send | Geo permissions disabled for the destination region — not a sender-ID problem at all. |
| `30649` | Config | Geo permissions cannot be changed via API. Console only, Account Owner/Admin. |

All send-time codes above are 4xx, so `sendSms`'s existing classifier already marks them permanent:
they do not burn retries, and the row lands in `failed` with the code recoverable from the logs.

---

## 7. Downstream decisions to make now, not later

**Multi-tenant is the real problem.** Today one sender ID for BitePerk is fine. The moment a
booking confirmation should read as coming from *the restaurant* rather than from us, each venue
needs its own registration under its own ABN, with its own valid use case and its own ABR
hygiene — a per-tenant onboarding step, not a one-off task. Decide the model before onboarding
scales:

- **BitePerk sends on everyone's behalf** — one registration, done here. Guests see `BitePerk`, which is a brand they don't recognise on a booking confirmation.
- **Each venue registers its own** — better guest experience, but adds a multi-week external dependency to the onboarding wizard and a compliance surface we don't control.

**`VoxTable` as a second sender ID — now actionable.** Multiple IDs are permitted and ACMA has
relaxed the count limit. `VoxTable` is 8 characters and passes the format rules, but needs
business-name, trademark or domain evidence linking it to Biteperk Pty Ltd. VoxTable cleared
trademark review in July 2026, so that evidence likely exists.

With `BitePerk` approved the process is now understood end to end and the participation approval is
already granted — a second ID should only need the registration leg, not the participation leg.
Worth lodging once the first sender ID is actually in production use and we know it behaves.
**Guest-recognition argument:** on a booking confirmation, `VoxTable` is no more recognisable to a
diner than `BitePerk`. Neither solves the naming problem below; only per-venue registration does.

**Ongoing obligations.** Keep register contact details current (stale contacts break renewal and
change requests), and re-check the restricted-terms list periodically — ACMA has said it will add
words as scam tactics shift, which could affect any future ID like `VoxTable Bkg`.

---

## Sources

- [Sending text messages with your business or organisation name — ACMA](https://www.acma.gov.au/sending-text-messages-your-business-or-organisation-name)
- [Register a sender ID if you have an ABN — ACMA](https://www.acma.gov.au/register-sender-id-if-you-have-abn)
- [Restricted terms for sender IDs — ACMA](https://www.acma.gov.au/restricted-terms-sender-ids)
- [Registering sender IDs — ACMA](https://www.acma.gov.au/registering-sender-ids)
- [The SMS sender ID register — ACMA](https://www.acma.gov.au/sms-sender-id-register)
- [What you should know about Australia's new SMS Sender ID Register — Twilio](https://www.twilio.com/en-us/blog/insights/australia-sender-id-register)
- Telecommunications (SMS Sender ID Register) Industry Standard 2025; SMS Sender ID Register (Application, Access and Administration) Determination 2025
