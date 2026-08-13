# ACMA SMS Sender ID Register — registering `BitePerk`

**Status as of 11 Aug 2026: APPLICATION LODGED — awaiting review.** Still **no live exposure**:
VoxTable sends SMS from the Twilio AU number, not an alphanumeric sender ID, so nothing we send
today is being overstamped. This is a *pre-emptive* registration so we can switch to a branded
sender ID later.

### Lodgement record (11 Aug 2026)

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

**Review path:** Twilio internal review (stated **up to 3 days**) → carrier / regulator (ACMA)
review → approval or rejection notice by email. Rejection comes with correction instructions, so a
reject is a fixable round-trip, not a restart.

**Unconfirmed — a fee may apply.** The confirmation says *"if registration involves payment, once
approved you will be asked for payment details."* Whether AU alphanumeric registration carries a
charge was not stated. Do not assume it is free; expect a possible payment step post-approval.

**Nothing in the repo changes until approval lands.** Do not point the Messaging Service at the
sender ID before the approval notice arrives — an unapproved ID is overstamped `Unverified`, which
is worse than the number we send from today.

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
| Length | 8 characters (limit: 2–11) ✅ |
| Charset | A–Z only, starts with a letter, no space/underscore at either end ✅ |
| Restricted words | None. The [restricted list](https://www.acma.gov.au/restricted-terms-sender-ids) (`alert`, `info`, `secure`, `verify`, `support`, …) bans IDs made up *only* of those words. `BitePerk` contains none ✅ |
| Valid use case | Exact match to registered company name **BITEPERK PTY LTD** and to the domain **biteperk.com.au** — the strongest evidence class available ✅ |

Registering the company name rather than the product brand is deliberate: `VoxTable` would need
separate business-name, trademark or domain evidence tying it to Biteperk Pty Ltd. Worth doing
later — see §6.

---

## 2. Prerequisite that fails most applications — fix this first

> **The ABR record must be current before the application is lodged.**

ACMA verifies authority via the **Australian Business Register**, specifically the *authorised
contact* and *service of notice email address*. It explicitly does **not** check Relationship
Authorisation Manager (RAM). If the ABR email is stale, the verification email never arrives and
the application stalls with no useful error.

- [ ] Log in to [abr.gov.au](https://www.abr.gov.au) for ABN **36 700 831 303**
- [ ] Confirm the authorised contact is Sam and the service-of-notice email is a mailbox actively monitored (`hello@biteperk.com.au` or a personal address — not a shared alias nobody reads)
- [ ] Update if wrong, then **wait for the change to propagate** before lodging (allow a few business days)
- [ ] Confirm the ABN shows as **active** and the entity name reads `BITEPERK PTY LTD`

- [ ] Confirm Sam has a **myID** identity (Standard strength or better). ACMA sends a verification step that is completed through myID — set it up now if it doesn't exist, it takes longer than you'd expect.

---

## 3. Registration route — through Twilio, not directly with ACMA

Businesses do not register with ACMA directly. The **telco or message provider registers on your
behalf**, and only providers approved as *participating* or *certified* telcos can do it.

- [x] **Verified 10 Aug 2026 — Twilio is approved, at the highest status.** On ACMA's [approved telcos list](https://www.acma.gov.au/approved-telcos-and-message-providers-sms-sender-id-register): *Twilio Inc.* (ABN 56 811 703 253) is a **Certified telco**; *Twilio Australia Pty Ltd* (ABN 82 618 090 010) is an Originating telco. Certified is the status that can also register on behalf of entities **without** an ABN — relevant if we ever register for international or ABN-less venues.

- [ ] 🚫 **BLOCKER — the Twilio account is on a trial and cannot register a sender ID.** Verified 10 Aug 2026: account `Biteperk-production` (`ACd423bd09e9649e552a0b6d19a9eed338`) shows *Trial, 26 days left, trial phone number*. Both `/sms/senders/alpha-sender-ids` and `/phone-numbers/regulatory-compliance/bundles` hard-redirect to `/upgrade/v2`. Twilio lists *"Verify your brand for reliable delivery"* as an upgrade-gated feature. **Nothing can be filled in or submitted until the account is upgraded** (requires adding funds).
  - Side finding worth chasing: an account named `Biteperk-production` sitting on a trial with a *trial* number contradicts the production AU number + `algorythmos` SIP trunk described in `CLAUDE.md`. Either production runs under a different Twilio account/login, or the voice path is not where we think it is. **Resolve this before upgrading** — upgrading the wrong account wastes the spend and registers the sender ID against the wrong ACCOUNT SID.
- [ ] Once upgraded, open the AU alphanumeric sender ID registration flow. Twilio quotes roughly **2 weeks** for verification, plus ACMA's own checks on top.
- [x] **Trust Hub Primary Customer Profile APPROVED 10 Aug 2026.** Notifications to `hello@biteperk.com.au`; no status callback URL set (nothing listening).
  - **Bundle SID `BU975db7eebfb0b5525d6762f3d77e2087`** — Account SID `ACd423bd09e9649e552a0b6d19a9eed338` (also its own Parent Account SID, i.e. not a subaccount). The Bundle SID is what the sender ID registration attaches to; quote it in any Twilio support ticket about this profile.
- **Trust Hub Primary Customer Profile** is the real prerequisite — the sender ID flow redirects into it. Business verification is handled by **Persona** (`inquiry.withpersona.com`), not Twilio directly. Values used (10 Aug 2026): friendly name `BitePerk Pty Ltd`; authorised individual **Sameer Kalaliya**, Director, `hello@biteperk.com.au`, `+61 450 011 140`; legal name `BITEPERK PTY LTD`; ABN `36700831303` (digits, no spaces).
  - **Declared as "Direct Customer", not "ISV Reseller or Partner"** — accurate while we register only BitePerk's own sender ID and notifications are off. **Revisit the moment a venue gets its own Twilio number or sender ID**: that is the ISV pattern (Primary profile for BitePerk + a Secondary Customer Profile per venue), and switching after the fact means restructuring the Trust Hub account. Tied to the multi-tenant decision in §6.
  - Use the individual's **legal given name** (`Sameer`, not `Sam`) — it must match the ID document used for Persona and later for the myID step with ACMA.
- [ ] Submit `BitePerk` with supporting evidence (assemble §4 first).
- [ ] Respond to the ACMA verification email when it lands — complete identity verification via myID.
- [ ] Record the approval reference and approval date in `deploy/runbooks/vendor-accounts.local.md`.

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

- [ ] **ABN/ABR extract** showing `BITEPERK PTY LTD`, ABN `36 700 831 303`, status *active*
- [ ] **ASIC company extract** — ACN `700 831 303` (the `asic/` folder in this repo likely already has it)
- [ ] **Registered office address** — Level 1, 457–459 Elizabeth Street, Surry Hills NSW 2010
- [ ] **Domain ownership evidence** for `biteperk.com.au` (registrar record / Cloudflare zone) — reinforces the brand link
- [ ] **Authorised administrator details** — Sam's name, role, and the ABR-matching email
- [ ] **Trademark certificate** if one exists for BitePerk (optional here, mandatory if we later register `VoxTable`)

Every one of these must be **byte-identical** to the canonical facts in the brand kit. A mismatched
address or a `Biteperk` vs `BITEPERK PTY LTD` discrepancy is a rejection.

---

## 5. Account SID scope — which accounts may send as `BitePerk`

> 📖 See also [`twilio-account-topology.md`](twilio-account-topology.md) for how sender IDs
> sit alongside customer profiles and regulatory bundles. Key point: all three are
> account-scoped, but **only regulatory bundles have a Clone API**. A sender ID cannot be
> cloned — extra accounts must be added to the registration by Twilio support.

> **Source: Ankita Mohanty (Twilio Product Operations), ticket 28926493, 12 Aug 2026.**
> Archived at `Sender ID across multiple Account SIDs.pdf` in the repo root.

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
  `AC8116857da2064ef3251533f3ade56f32` (**Biteperk-staging**) is added to the registration. A
  staging test send would come through stamped `Unverified` — and would look exactly like a
  *failed* registration rather than an unconfigured account, which is a genuinely misleading
  signal to debug against.
- **§6's staging test step assumes this is resolved.** Do not read "roll out in staging first" as
  achievable until staging's SID is on the registration.
- ⚠️ **This compounds the unresolved production-voice question.** It is still not confirmed which
  Twilio account carries the live AU voice number behind the `algorythmos` SIP trunk. If SMS ever
  sends from an account other than `ACd423bd09…`, it is stamped `Unverified` regardless of
  approval status. Confirm the account map before relying on the sender ID.
- **Multi-tenant:** `Parent Account SID: N/A` — this is a standalone account today, not a
  subaccount parent. Whether subaccounts created by `provisioningWorker` would inherit the sender
  ID is **unknown and must not be assumed**; ask before designing per-venue messaging on it.

### Action

- [ ] Reply to ticket 28926493 with `AC8116857da2064ef3251533f3ade56f32` (staging) — cheaper during
      review than a support round-trip afterwards
- [ ] Ask in the same reply whether additional SIDs affect fee or review time, and whether
      subaccounts inherit the approved sender ID
- [ ] Record the final approved SID list here once confirmed

---

## 6. Code changes — only after approval lands

Nothing changes in the repo until the sender ID is approved. Then:

- [ ] Set the sender ID on the Twilio Messaging Service used by `notificationWorker` (not per-message) so the fallback behaviour is controlled in one place
- [ ] Keep the AU number configured as **fallback** — Australian carriers can still fail alphanumeric delivery, and SMS from an alphanumeric ID is **one-way** (customers cannot reply). Confirm no notification copy invites a reply before switching
- [ ] Roll out behind `NOTIFICATIONS_ENABLED` in staging first; send a real test to an Australian handset and **visually confirm the header reads `BitePerk`, not `Unverified`** — ⚠️ **blocked until the staging Account SID is on the registration (§5)**, or the test returns a false negative
- [ ] Add the check to the smoke pass — a wrong header is invisible to any assertion that only inspects the API response

---

## 7. Downstream decisions to make now, not later

**Multi-tenant is the real problem.** Today one sender ID for BitePerk is fine. The moment a
booking confirmation should read as coming from *the restaurant* rather than from us, each venue
needs its own registration under its own ABN, with its own valid use case and its own ABR
hygiene — a per-tenant onboarding step, not a one-off task. Decide the model before onboarding
scales:

- **BitePerk sends on everyone's behalf** — one registration, done here. Guests see `BitePerk`, which is a brand they don't recognise on a booking confirmation.
- **Each venue registers its own** — better guest experience, but adds a multi-week external dependency to the onboarding wizard and a compliance surface we don't control.

**`VoxTable` as a second sender ID.** Multiple IDs are permitted and ACMA has relaxed the count
limit. `VoxTable` is 8 characters and passes the format rules, but needs business-name, trademark
or domain evidence linking it to Biteperk Pty Ltd. Since VoxTable cleared trademark review in
July 2026, that evidence may already exist — worth registering as a second ID once `BitePerk` is
approved and the process is understood.

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
