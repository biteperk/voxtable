---
name: twilio-au-number-provisioning
description: End-to-end provisioning of an Australian Twilio phone number for VoxTable/BitePerk: regulatory bundle, purchase, AU1 routing, SIP trunk to Retell, trunk hardening, disaster recovery, messaging service, Retell/database binding and verification. Use whenever someone needs a new AU number, is onboarding a venue that needs a line, wants to set up, harden or fix an Elastic SIP Trunk, mentions AU1 vs US1 routing, needs SMS senders, a Messaging Service, geo permissions or an alphanumeric sender ID, hits "number is no longer available" or a greyed-out Buy button or a jammed search form, asks why a number rings out or why /twilio/voice never fires, or asks about Twilio regulatory bundles, toll fraud, account suspension or auto-recharge. Also for staging numbers, wiring a number to Retell, decommissioning a number, and any time "Australian SIP", "buy a number" or "make the number live" comes up - even if only one step is asked for, because the steps have a strict order and doing them out of order fails silently.
---

# Provisioning an Australian Twilio number for VoxTable

Taking a number from "not bought" to "answering customers reliably". Twilio's console reports most
failures in this workflow as **empty lists and greyed-out buttons rather than errors**, so people
conclude it's broken and retry the same thing. Each trap below has cost real time or money.

**Work in the order given.** The order is the point — several steps are irreversible or invisible
if done late.

---

## Definition of done

A number is not "ready" because it was purchased. It is ready when all of these are true:

- [ ] Bought on the **intended account**, friendly name set, correct type (Mobile for voice+SMS)
- [ ] Active region shows **AU1 — Voice** (Messaging stays US1; that's the only shape available)
- [ ] Attached to an AU1 SIP trunk whose origination points at Retell over TLS
- [ ] Trunk hardened: Secure Trunking on, transfer disabled, symmetric RTP off, CNAM off
- [ ] **Disaster Recovery URL set** so callers hear something when Retell is unreachable
- [ ] Traffic Status reads **Voice enabled**
- [ ] Messaging Service exists with the number as sender; SMS geo permission for AU enabled
- [ ] Retell agent bound to the number as `inbound_agent_id`
- [ ] `restaurants` row exists with `twilio_phone_number` in E.164
- [ ] **A real test call answered and landed in `call_logs` with the right `restaurant_id`**
- [ ] Account has a non-zero balance and **auto-recharge enabled**
- [ ] SIDs recorded in the runbooks

Console green ticks confirm configuration, not connectivity. Only the test call proves the chain.

**Realistic timing:** ~30 minutes when compliance already exists, *plus* one retry for a number
lost mid-purchase. Budget for the retry — it is the norm, not the exception.

---

## Phase 0 — Pre-flight

### Which account?

Three accounts exist; the console gives almost no visual difference between them. Check the account
picker (top-left) **before every action**.

| Console name | Account SID | Role |
|---|---|---|
| *My first Twilio account* (Algorythmos) | `AC949756ac8dc4aced25b15b2e0bbb3a61` | Original. Holds the **live** production voice number. Has been suspended for funds — verify before assuming production voice works |
| **Biteperk-staging** | `AC8116857da2064ef3251533f3ade56f32` | Staging / internal testing |
| **Biteperk-production** | `ACd423bd09e9649e552a0b6d19a9eed338` | Company-native production |

Buying on the wrong account is the one mistake that costs money and is annoying to undo — moving a
number between accounts is a support ticket, not an API call.

### Check the account can actually do the job

- **Balance and auto-recharge.** A balance at or below $0 suspends the account: calls, SMS, API and
  number purchases all stop (errors `10001`, `20005`, `30002`). Reactivation after payment takes
  5–10 minutes. This is why the Algorythmos account took production voice down.
  **Enable auto-recharge on any account carrying real traffic.**
- **Trial vs upgraded.** Trial accounts can't use alphanumeric sender IDs and restrict outbound
  calling to verified numbers.

Detail: `references/accounts-and-compliance.md`.

### Decide the voice architecture now

The backend supports **two mutually exclusive** inbound paths. Choosing late means reconfiguring,
and setting both wastes a day wondering why the webhook never fires.

**A. SIP Trunk (default — production and staging both use this)**

```
Caller → Twilio number → Elastic SIP Trunk (AU1) → Retell → backend /retell/tools/*
```

Twilio never calls our backend on the signalling path. Lower latency, and a backend outage doesn't
drop calls. Cost: no `call_logs` row at call start — the record arrives later from Retell's
`call_analyzed` webhook.

**B. TwiML webhook (`/twilio/voice`)**

`handleTwilioIncomingCall` writes a `call_logs` row with `status: "started"` immediately, then
returns TwiML dialling `TWILIO_RETELL_SIP_URI` with status callbacks to `/twilio/status`. Early
logging and per-call control — at the cost of putting our API in the call path.

**A number attached to a trunk ignores its voice webhook entirely.** That's why `/twilio/voice`
never fires on our numbers, and it isn't a bug.

Use **A plus a Disaster Recovery URL** (Phase 5). Full comparison in
`references/retell-and-db-binding.md`.

---

## Phase 1 — Compliance prerequisites

An AU number cannot be purchased without an **approved Regulatory Bundle** matching country *and*
number type. Without one the Buy button is greyed out with no explanation.

Three separate objects all use `BU…` SIDs and all are **account-scoped** — Primary Customer Profile,
Regulatory Bundle, Alphanumeric Sender ID. Treating them as one thing is the most common error here.
Full object model, the Bundle Clone recipe and its verified/unverified constraints:
`references/accounts-and-compliance.md`.

Check `Phone Numbers → Regulatory Compliance → Bundles` on the target account, then take the
cheapest path:

| Situation | Path | Time |
|---|---|---|
| Account has an approved **Customer Profile** | Create bundle → **"Use this profile"** | **Instant** |
| Another account in the org has an approved bundle | **Clone** it | **Instant** |
| Neither | Build from documents | ~1 day (budget 3) |

**Document path, if needed:** identity **Direct Customer**, end user **Business**;
`BITEPERK PTY LTD`; business ID `36 700 831 303`. All three document slots are satisfied by the
single **ABR ABN Advice PDF** under type *"Commercial registry or equivalent showing address"*. The
ASIC Certificate of Registration does **not** work — no address, no officers.

Address fields exactly: Street line 1 `457-459 Elizabeth Street`, Street line 2 `Level 1`,
Surry Hills / NSW / 2010 / AU. Note the inversion — the canonical NAP reads "Level 1, 457-459
Elizabeth Street" but Twilio's two-line form takes the unit on line 2.

The console shows approved as **"Accepted"**, not "Approved" as the email says.

---

## Phase 2 — Buy the number

**Choose Mobile, and know why:**

| Type | Voice | SMS | Cost |
|---|---|---|---|
| **Mobile** `+61 4…` | ✅ | ✅ | **$8.25/mo** |
| Local `02…` | ✅ | ❌ *cannot ever send SMS* | $3.00/mo |

There is no AU number doing voice and SMS at the local price.

**Don't chase a vanity number, and expect to lose one anyway.** Filtering on a memorable tail
returns a handful of numbers every other pattern-hunter is also seeing — one such pool went from
~13 to 4 to zero in a session. But the *unfiltered* pool loses numbers too: a staging purchase lost
`+61 495 044 529` with no filter applied at all, from a search that had returned only one result.
Pool depth swings wildly between searches minutes apart, so **a one-result search is a signal to
re-search, not proof of scarcity**. Three numbers were lost across two accounts in one afternoon.

Tell whoever asked for a pattern, up front, that it may take several attempts and may be
unobtainable — before the third failure, not after.

### The flow

`Phone Numbers → Buy a number` (the plain buy URL redirects into this wizard):

1. **Let the wizard finish loading before typing.** It renders with Destination country defaulted to
   United States and silently discards input sent too early.
2. Country **Australia**, type **Mobile**, no digit filter → Search.
3. Select the first available → Review → Continue.
4. **Manage compliance** — three answers, all of which must match the approved bundle or you land in
   a different requirement set and a fresh review queue:
   - Channel → **Voice** (Messaging routes into SMS registration; add later)
   - **Business / Nonprofit / Sole Proprietor**
   - **Direct Customer** — but read the ISV warning below before assuming this for venue numbers
5. **Compliance registration** → *"Yes, use an existing registration"* → pick the approved bundle. It
   should say *"already approved and ready to use"*. If it asks for documents, stop — you're creating
   a second bundle instead of reusing one.
6. **Saved address** → *"An existing address"*. The *"No saved addresses?"* banner is a static prompt,
   not a check. Open the dropdown; a duplicate NAP record makes it ambiguous later which address a
   bundle is bound to.
7. **Buy number**, then **Continue** on the final review.
8. **Set a friendly name immediately** — `voxtable-prod-natalias`, `voxtable-staging-test`. At venue
   scale an inventory of bare E.164 numbers is unusable.

### When a number is taken mid-flow

*"has been purchased by another customer"* — nothing was charged and no compliance work was lost.

**The search form will now be jammed**: Number type disabled, Search Criteria greyed showing
"Locality", no error. Page interactions won't recover it. **Reload
`…/senders-onboarding?setupGuide=true` fresh** and redo the search — compliance persists, so the
retry costs about thirty seconds. Confirmed on both accounts.

---

## Phase 3 — Region, and why it must come now

⚠️ **Do this before creating or attaching a trunk.** A US1 number does not appear in an AU1 trunk's
number picker at all — no error, just an empty list. This is what left `+61275011140` "attached to
the AU1 trunk but dormant" on the Algorythmos account: a migration abandoned because the symptom
looked like a console bug.

`Phone number → Configuration details → Regional → Change active region → Australia (AU1)`

Twilio warns: **Messaging is not available in AU1.** Only Voice moves; Messaging stays US1. Not a
failure — it's the only shape available. After the change the number shows `US1 — Messaging` and
`AU1 — Voice`.

> **Say this accurately.** AU1 keeps the *Twilio* leg and voice personal data in Australia. Retell is
> US-based, so call audio still leaves the country for processing. "Voice data processed and stored
> in Australia" is true; "calls processed onshore" is not — and the latter is exactly what the
> website's `check-claims` gate exists to block. Don't let it drift into internal language either;
> that's how it ends up in customer copy.

---

## Phase 4 — Create the SIP trunk

`Voice → Elastic SIP Trunking → Trunks`. **Switch the region selector to Australia (AU1) first** — it
defaults to US1 and a trunk's region cannot be changed after creation.

Name it for its environment: `voxtable-prod-au1`, `voxtable-staging-au1`.

**Origination** — the leg that matters:

```
sip:sip.retellai.com;transport=tls    priority 10    weight 10    enabled
```

**Termination — leave unconfigured.** It carries *outbound* traffic. VoxTable is inbound-only and
outbound calling is out of scope. Leaving it blank is the decision, not an omission.

**Numbers** → Add a number → filter by E.164 digits (an empty filter throws *"Invalid Pattern
Provided"*) → tick → Add Selected. Expect *"1 numbers were associated successful with this trunk"*.

Verify: the number's Traffic Status reads **Voice enabled**.

---

## Phase 5 — Harden the trunk

Default trunk settings are not production settings. Set all of these — full rationale, API field
names and failure behaviour in `references/trunk-hardening.md`:

| Setting | Value | Why |
|---|---|---|
| **Secure Trunking** | **ON** | TLS signalling + SRTP media. Our origination already uses `transport=tls`. Non-encrypted calls are rejected once on |
| **Call Transfer (SIP REFER)** | **disable-all** | Nothing transfers calls; enabled is unused attack surface |
| **Symmetric RTP** | **OFF** | Twilio strongly recommends against it (RTP inject/bleed) |
| **CNAM Lookup** | **OFF** | US/CA only, billed per lookup even with no data, null for international |
| **Disaster Recovery URL** | **SET** | See below — the biggest gap in a default trunk |

⚠️ **Disaster Recovery URL.** If **none** of the origination URIs can be reached — Retell down, DNS
broken, TLS failing — Twilio falls back to this URL and expects TwiML. Without it, callers get dead
air during a Retell outage and the venue never learns why bookings stopped. Point it at an endpoint
returning a `<Say>` apology plus `<Dial>` to the venue's own line. No re-arming after recovery.

> **Status: documented, not yet configured on our trunks.** Neither `voxtable-prod-au1` nor
> `voxtable-staging-au1` has one. Treat building that endpoint as outstanding work, not as
> something already in place.

---

## Phase 6 — Messaging

Create the Messaging Service in **US1** (AU1 has no messaging): `Messaging → Services → Create`.
Name `voxtable-<env>-notifications`, use case **Notify my users**. Add the number as a sender.

Then the three things people forget — detail in `references/accounts-and-compliance.md`:

1. **SMS geo permissions** — Australia must be enabled or every send fails with error `21408`.
2. **Account-wide alphanumeric toggle** (`Messaging → Settings → General`) — a registered sender ID
   is ignored if this is off. Alphanumeric senders don't work on trial accounts at all.
3. **AU registration** — the number shows *"Messaging disabled — Submit registration"* until done.
   Expected; doesn't block voice.

**The `BitePerk` alphanumeric sender ID has no clone API.** It's registered per Account SID — a send
from any other account (including staging) is stamped `Unverified` on the handset regardless of
approval. Adding an account means asking Twilio support. It is also **one-way**: recipients cannot
reply, `STOP` does not work, so no notification copy may invite a reply.

### Sending AS the registered sender ID — the config that decides it

⚠️ **A registered sender ID is not used because it exists. It is used because the send went
through the Messaging Service.** Approval, and even attaching the sender to the pool, changes
nothing on their handset if the app sends from a bare number.

Verified on `ACd423bd09…` on **28 Aug 2026** by reading the service back over the API — the pool
of `MG7ceaa2aaa3cea6195ea7979d57b78b14` (`voxtable-prod-notifications`) holds **both**:

| Sender | |
|---|---|
| `BitePerk` | alphanumeric, SMS — ACMA-approved, attached |
| `+61468202846` | the production number |

With the service alone, Twilio picks the alphanumeric sender for destinations that support it
(Australia does) and falls back to the number where they do not. So the rule is:

- **Set `NOTIFICATIONS_MESSAGING_SERVICE_SID`** to that `MG…`.
- **Leave `NOTIFICATIONS_SMS_FROM` unset.** `resolveSmsSender` in `services/notificationService.ts`
  returns the service when both are present, so a stray `SMS_FROM` is currently harmless — but it
  is the rollback lever, not the normal setting, and sending both to Twilio at once reads as "keep
  the service but pin this From", which switches sender selection OFF and silently drops you back
  to the number.
- **Rolling back to the plain number is unsetting the SID** — an env change, no deploy.

**Proving it, rather than assuming:** after the first real send, read the Message resource back
and check `from`. It must read `BitePerk`, not `+61…`. A handset screenshot is the other half —
an unregistered alphanumeric is overstamped `Unverified` in Australia, and the API cannot see that.

⚠️ **Neither BitePerk account has ever actually sent an SMS** (NUMBERS.md §1). Messaging shows
"enabled" on both, which proves configuration and not delivery. Treat the whole path as unproven
until one message lands on a real handset.

---

## Phase 7 — Retell and the database

See `references/retell-and-db-binding.md`. In short: import the number into Retell, bind the agent,
then insert the `restaurants` row with `twilio_phone_number` (E.164 — the trusted
routing key), `retell_agent_id`, `name`, `timezone`, `onboarding_status`.

⚠️ **Binding mode matters:** a single fixed line may use a static `inbound_agent_id`, but **any
per-venue number must use `inbound_webhook_url` (webhook mode)** — `NAMES.md` §6. A static binding
stops `/retell/inbound` firing, which is what resolves the restaurant from the dialled number.

Both Retell and Twilio handlers resolve the restaurant from the **dialled number** and **fail closed
in production**. Until the row exists a production call correctly reaches nothing — that's the system
working, not a bug to route around.

---

## Phase 8 — Verify

1. Traffic Status shows **Voice enabled**.
2. **Place a real call.** Confirm the agent answers and completes a booking.
3. Check `call_logs` for the row with the expected `restaurant_id`.
4. Open the **Console Debugger** (`Monitor → Logs → Errors`) — signature failures, unreachable
   webhooks and TLS problems land here rather than anywhere you'd naturally look.
5. Send one test SMS if messaging is in scope.

Only the test call exercises every hop.

---

## Phase 9 — Operational monitoring

- **Auto-recharge** — enable it. This is the failure that took production down.
- **Debugger webhook** (`Monitor → Debugger → Webhook`) — Twilio `POST`s every error and warning to
  a URL of your choice. Point it at a backend endpoint or Slack relay so webhook failures surface
  without anyone logging into the console.
- **Alarms** — threshold alerts on error rates. ⚠️ **Available only to customers in US1**, worth
  knowing given our voice runs on AU1. The Debugger webhook has no such restriction.
- **Voice geo permissions** govern *outbound* dialling and apply to Elastic SIP Trunking too.
  Low exposure while inbound-only, but the standard toll-fraud control if termination is ever added.

---

## Decommissioning a number

Releasing is immediate and irreversible. In order:

1. Remove or repoint the `restaurants` row so nothing resolves to it.
2. Unbind it in Retell.
3. Detach from the trunk and the Messaging Service.
4. Confirm no traffic for a full billing cycle.
5. Release it.

Adding a new number never retires the old one. Two numbers pointing at the same agent is fine;
assuming the new one has taken over is not.

---

## ⚠️ Venue numbers: settle this before the first one

Everything above assumes **Direct Customer** — that BitePerk answers the calls. True for BitePerk's
own lines, and what both current bundles assert.

The moment numbers are bought *on behalf of restaurants*, that may become false. Twilio's
ISV/Reseller option is literally *"I integrate Twilio in a product that I sell to my customers"* —
which is what VoxTable becomes. If venues are the real end users, each needs its own End User object
and bundle, and **cloning stops helping**, because the identity differs per venue.

Confirm the model with Twilio before the first auto-provisioned venue. Staging cannot rehearse this,
because both accounts are deliberately Direct Customer.

Also decide account topology first: both BitePerk accounts are **siblings** under one Organization,
not subaccounts. At venue scale, subaccounts under one parent is conventional and behaves differently
for number ownership, bundle inheritance, geo-permission inheritance and billing.

Planning arithmetic: 100 venues × $8.25/mo = **$825/mo** in line rental before a single call.

---

## Recording what you did

After each run record: the number and its `PN…` SID, the trunk `TK…` SID and region, the Messaging
Service `MG…` SID, which bundle and address were reused, which hardening settings were applied, and
what remains unwired. In this repo: `deploy/runbooks/twilio-account-topology.md` and
`vendor-accounts.local.md`.

Note anything the console did that surprised you — that's the material that makes the next run fast.

---

## References

- `references/accounts-and-compliance.md` — the three accounts, the three per-account object types, Bundle Clone, account health gates, messaging prerequisites
- `references/trunk-hardening.md` — Secure Trunking, transfer, CNAM, symmetric RTP, disaster recovery, origination redundancy, the `edge` parameter, why termination stays blank
- `references/console-navigation.md` — dead URLs, sticky footers, region selectors, session-pause, stale search, the jammed form
- `references/retell-and-db-binding.md` — the two voice architectures, trunk → Retell agent → `restaurants` row
