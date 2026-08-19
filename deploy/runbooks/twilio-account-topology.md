# Twilio account topology, compliance objects and number provisioning

**Verified 13 Aug 2026** against the Twilio console (both accounts) and the Twilio API
reference. Read this before creating a Twilio account, buying a number, or designing
per-venue provisioning. Sender-ID-specific detail lives in
[`acma-sender-id-registration.md`](acma-sender-id-registration.md); this file covers the
account/bundle/profile layer underneath it. The number inventory itself — which number
is on which account and what each can actually do — is [`../../NUMBERS.md`](../../NUMBERS.md).

> **Ownership (13 Aug 2026):** both BitePerk accounts are owned by
> **`twilio@biteperk.com.au`**, replacing the previous personal/agency login. **The Account
> SIDs did not change**, so every SID, trunk, bundle, address and Messaging Service recorded
> in this file remains valid — only the credential record moved. Logins live in the
> gitignored `vendor-accounts.local.md`.
>
> The third account (**Algorythmos**, §below) is **not BitePerk infrastructure**. It belongs
> to a separate project and is being migrated away from — do not add BitePerk resources to it.

---

## 1. Three objects, three SIDs, all account-scoped — do not conflate them

The single most common error in this area is treating these as one thing. They are three
separate resources that happen to all use `BU…` SIDs, and **none of them is inherited
across accounts**.

| Object | What it is | Scope | How to reuse elsewhere |
|---|---|---|---|
| **Primary Customer Profile** (Trust Hub) | The verified BitePerk Pty Ltd business identity | **Per account** | Re-verify, or clone the bundle built on it |
| **Regulatory Bundle** | Per-country, per-number-type compliance record required to *buy* a number | **Per account** | `Bundles/{Sid}/Clones` API (§4) |
| **Alphanumeric Sender ID** | The `BitePerk` SMS sender | **Per account** | Ask Twilio to add the Account SID to the registration — **no clone API exists** |

> ⚠️ **The Clone API does not clone sender IDs.** Solving the bundle problem does not solve
> the sender-ID problem. They need separate actions on separate tickets.

---

## 2. What exists today

| Account | SID | Customer Profile | AU Mobile Bundle | Sender ID |
|---|---|---|---|---|
| **Biteperk-production** | `ACd423bd09e9649e552a0b6d19a9eed338` | `BU975db7eebfb0b5525d6762f3d77e2087` (approved) | `BU8cb2353e1b34a75c6ed0cec20e163356` (approved 13 Aug, instant) | `BUce1fa0ad6053c4444f3faca4c7957f25` — **✅ ACMA-approved 18 Aug 2026** (not yet attached to the Messaging Service) |
| **Biteperk-staging** | `AC8116857da2064ef3251533f3ade56f32` | none | `BUd5fe40c147a21757f04616a1180cdd89` (approved 13 Aug, ~1 day) | **none — open action** |

**Numbers owned (production):** **`+61 468 202 846`** — AU Mobile, Voice + SMS, $8.25/mo,
purchased 13 Aug 2026 against bundle `BU8cb2353e…` and address `AD3ea533a6a658f822c84cb37ebd88233e`.

### Production voice + messaging wiring (built 13 Aug 2026)

| Resource | SID / value |
|---|---|
| Phone number | `+61468202846` · **`PN05a730d0f19b14578b76f72a547fa48e`** |
| Elastic SIP Trunk | **`TK6fcd3c96ea8317181d4049ce6f938f10`** — friendly name `voxtable-prod-au1`, region **AU1** |
| Trunk origination URI | `sip:sip.retellai.com;transport=tls` · priority 10 · weight 10 · enabled |
| Trunk termination | **deliberately not configured** — see below |
| Messaging Service | **`MG7ceaa2aaa3cea6195ea7979d57b78b14`** — `voxtable-prod-notifications`, use case *Notify my users*, region **US1**, sender pool = the number |

**Regional split — this is deliberate and Twilio-enforced.** The number's active region is now
**AU1 for Voice** and **US1 for Messaging**. Twilio states plainly: *"Messaging is not available in
Australia (AU1)… only its Voice capabilities will be enabled in AU1. The phone number's Messaging
capabilities will remain in the United States (US1) region."* You cannot have both in AU1 today.

> ⚠️ **Ordering matters, and getting it wrong looks like a broken console.** A number provisioned in
> US1 is **invisible** to an AU1 trunk — the "Add a number" picker returns nothing with no useful
> error. Change the number's active region to AU1 **first** (Phone number → Configuration details →
> Regional → Change active region), *then* attach it to the trunk. This is the same trap that left
> `+61275011140` "attached to the AU1 trunk but dormant" on the Algorythmos account.

**Termination is not configured, on purpose.** Termination carries *outbound* traffic (your
infrastructure → Twilio → PSTN). VoxTable is inbound-only — caller → Twilio → Retell — which is
**Origination**, and outbound calling is explicitly out of scope. Do not "fix" this by adding a
termination URI unless outbound genuinely ships.

> ⚠️ **AU1 is not "onshore processing".** AU1 keeps the *Twilio* leg and voice personal data in
> Australia. Retell's platform is US-based, so call audio still leaves the country for processing.
> This is exactly the claim the website's `check-claims` gate exists to prevent — do not describe
> the AU1 move as onshore call processing, internally or externally.

**Still outstanding on this number:**

- **Retell side is untouched** — the number is not imported into Retell and no agent is bound.
- **No `restaurants` row** binds it, so `getRestaurantIdByDialedNumber` will not resolve it.
- ~~Messaging shows "Messaging disabled — Submit registration"~~ **Corrected 13 Aug 2026 by console
  audit:** Traffic Status reads **"Messaging enabled"** *and* **"Voice enabled"**, and the number's
  compliance registration shows *Australia: Mobile – BitePerk Pty Ltd — **Approved***. Outbound SMS
  from the number is available; it has simply never been sent.
- **The `BitePerk` alphanumeric sender ID is ✅ ACMA-approved (18 Aug 2026)** — but **not attached to
  `voxtable-prod-notifications`**, so sends still show the number. Wiring steps:
  [`acma-sender-id-registration.md`](acma-sender-id-registration.md) §6.
- Emergency Address Status is **Unregistered**.

### Staging voice + messaging wiring (built 13 Aug 2026)

| Resource | SID / value |
|---|---|
| Phone number | **`+61 468 203 234`** · `PN5a99b73b6f6a9e9a1cc40f7eb7feba42` · $8.25/mo |
| Elastic SIP Trunk | **`TKdebe2aa1a4287ca4b2f22da0e9d10ed7`** — `voxtable-staging-au1`, region **AU1** |
| Trunk origination | `sip:sip.retellai.com;transport=tls` · priority 10 · weight 10 · enabled |
| Trunk termination | not configured (inbound-only, same as production) |
| Messaging Service | **`MG692c54a793f914c2e43c7d691f4cb41e`** — `voxtable-staging-notifications`, US1, sender = the number |
| Compliance reused | bundle `BUd5fe40c147a21757f04616a1180cdd89` · address `AD0b3b71dc0a972ac2e678cb633e3a2c3d` |

Region split identical to production: **AU1 Voice / US1 Messaging**. Traffic Status confirms
**Voice enabled**; messaging shows *"Messaging disabled — Submit registration"*.

**Purpose:** internal end-to-end testing only. Never customer-facing.

**Still unwired:** no Retell agent, no staging `restaurants` row. Note also that the `BitePerk`
alphanumeric sender ID is registered against **production only** — so staging cannot produce a
branded send regardless of that approval. ⚠️ **The failure is silent:** tested 18 Aug 2026, a
staging send with `BitePerk` in the pool delivered from `+61 468 203 234` with no `Unverified`
stamp and no error. See [`acma-sender-id-registration.md`](acma-sender-id-registration.md) §5.

Both are sibling accounts under one Organization. **Neither is a subaccount**
(`Parent Account SID: N/A`) — this matters, see §6.

> ⚠️ **There is a THIRD account, and it is the one that matters for live traffic.** The original
> **Algorythmos** account `AC949756ac8dc4aced25b15b2e0bbb3a61` holds the live production voice
> number `+61 2 7501 1140` behind the `algorythmos` SIP trunk — and is **suspended for lack of
> funds** (as at 5 Aug 2026). Neither BitePerk account carries live customer calls today.
> Credentials, trunk SIDs and the full number inventory:
> [`vendor-accounts.local.md`](vendor-accounts.local.md).

---

## 3. Customer profiles are account-scoped, NOT org-shared

**This corrects a plausible-sounding claim that is wrong**, and getting it wrong makes new
accounts look free when they are not.

The evidence is a natural experiment we already ran:

- **Production** owns an approved customer profile. Creating its AU Mobile bundle offered
  *"Do you want to use the profile BitePerk Pty Ltd"* → **approved instantly**, no queue.
- **Staging** has no customer profile. It was never offered that path, had to upload
  documents, and waited ~1 day for review.

If profiles were shared at the Organization level, staging would have been instant too.
It wasn't. **The instant approval was same-account reuse.**

Consequence: a new Twilio account starts with *nothing*. It needs either its own verified
customer profile (slow) or a cloned bundle (fast, §4).

---

## 4. Cloning an approved bundle into another account

The supported way to reuse compliance across accounts. Verified against the API reference.

```
POST https://numbers.twilio.com/v2/RegulatoryCompliance/Bundles/{BundleSid}/Clones
  TargetAccountSid=AC…        # required
  FriendlyName=…              # optional
  MoveToDraft=true|false      # optional; true lands it in draft instead of approved
```

**Confirmed by the docs:**

- Source bundle must be `twilio-approved` (the resource is defined as copying a
  `twilio-approved` bundle).
- Target must be an account "within the same organization".
- The clone is set to `twilio-approved` **automatically** — no second review queue, so you
  can provision numbers in the target account immediately.
- It internally clones the bundle *items* — identities and documents — not just the wrapper.

**Claimed elsewhere but NOT in the reference — treat as unverified:**

- That the source needs a valid `valid_until` date.
- That a deleted linked Address blocks the clone.

Both are plausible; neither is documented on the Clones page. Don't design around them
without testing.

**`Copies` is a different resource.** `Bundles/{Sid}/Copies` duplicates within the *same*
account (renewal/versioning). `Clones` crosses accounts. Confusing the two at scale is an
easy and expensive mistake.

---

## 5. ⚠️ The ISV question — the real scale blocker

**Cloning propagates BitePerk's identity, and that is exactly the problem at venue scale.**

The current bundles are **Direct Customer + Business**: they assert that *BitePerk* answers
the calls. That is true today — the MVP number is BitePerk's own.

The moment `provisioningWorker` buys numbers on behalf of restaurants, that assertion may
become false. Two models, and they are not interchangeable:

| | BitePerk is the end user | Venue is the end user |
|---|---|---|
| Identity Type | Direct Customer | **ISV/Reseller** ("I integrate Twilio in a product that I sell to my customers") |
| Bundles | One, cloned per account | **Per-venue** bundle + per-venue End User object |
| Does cloning help? | Yes | **No** — the identity differs per venue |
| Guest sees | BitePerk | The venue |

**Confirm the correct model with Twilio before the first venue is auto-provisioned.** This
is one of the few places where staging genuinely does not rehearse production, because both
current bundles are deliberately Direct Customer.

---

## 6. Topology: sibling accounts vs subaccounts

Today: two **sibling** accounts under one Organization. Fine for a staging/production split.

At venue scale the conventional shape is **subaccounts under one parent**, which changes
behaviour for number ownership, bundle inheritance, billing rollup and A2P registration.
Do not assume the current two-account pattern extends. Decide the topology *before*
onboarding scales, because migrating numbers between accounts later is a support-ticket
exercise, not an API call.

Also unresolved: it is still not confirmed which account carries the **live AU voice number**
behind the `algorythmos` SIP trunk. Any plan that assumes it is `ACd423bd09…` should verify
first.

---

## 7. Cost arithmetic

| Item | Cost |
|---|---|
| AU **Mobile** (`+61 4`) — voice **and** SMS | **$8.25/mo** |
| AU **Local** (`02`) — voice only, cannot send SMS at all | $3.00/mo |
| Regulatory bundle / clone | free |

There is no AU number type that does voice *and* SMS at the local price. At 100 venues,
mobile numbers alone are **$825/mo** in line rental before a single call or message.

---

## 8. Buying a number — checklist

1. **Confirm the account picker.** The console gives almost no visual difference between
   `Biteperk-staging` and `Biteperk-production`.
2. Phone Numbers → Buy a number → country **Australia**, capabilities **SMS + Voice**,
   number type **Mobile**.
3. Assign the account's approved bundle at purchase (the bundle page labels it
   *"SID for provisioning numbers"*). Approval alone provisions nothing.
4. A shortlisted number is **not reserved** while you deliberate.

**Inventory note (13 Aug 2026):** Twilio's AU mobile stock was in the `420` / `468` / `483` /
`485` / `495` prefixes. The `450` prefix was not available at all, so a `0450…` vanity match
was not achievable.

### ⚠️ Do not chase vanity numbers through this wizard

**Two numbers were lost mid-purchase on 13 Aug 2026** — `+61 495 041 140` and then
`+61 495 031 140` — each with *"has been purchased by another customer"* after compliance was
completed. Root cause, and it is structural, not bad luck:

1. **Search results are a stale index.** The list shows numbers that may already be sold.
2. **Nothing is reserved** between selecting a number and paying for it.
3. **The wizard forces a multi-step compliance checklist in between**, so minutes elapse.
4. **Vanity patterns are the worst case** — a filtered tail like `1140` returns a handful of
   numbers that every other customer hunting a pattern is also seeing. That pool went from
   ~13 to 4 to 0 within one session.

**Working method:** search the *unfiltered* AU Mobile pool, take the first result, and move
straight through. If a specific tail is genuinely wanted, expect several attempts and accept it
may be unobtainable.

⚠️ **Even the unfiltered pool loses numbers.** On the staging purchase (13 Aug) `+61 495 044 529`
was taken mid-flow with no vanity filter applied at all, and that search had returned only *one*
result. Pool depth varies enormously between searches minutes apart — treat one-result searches
as a signal to re-search rather than proof of scarcity. **Three numbers were lost across two
accounts in one afternoon.** Budget for at least one retry every time.

**After a lost number the search form jams.** Number type goes disabled and Search Criteria
reverts to a greyed "Locality" — no error. Page interactions won't recover it. **Reload a fresh
`…/senders-onboarding?setupGuide=true` URL** and redo the search; account-level compliance
persists, so it costs ~30 seconds. Confirmed on both accounts.

**Let the fresh wizard finish loading before typing.** It renders with Destination country
defaulted to United States and silently discards input sent too early — wait for the form, then
set country and type.

There is no separate "quick buy" page — `/phone-numbers/manage/search` redirects into this
same wizard.

---

## Sources

- [Bundle Clones Resource — Twilio](https://www.twilio.com/docs/phone-numbers/regulatory/api/clones-resource)
- [Bundle Copies Resource — Twilio](https://www.twilio.com/docs/phone-numbers/regulatory/api/copies-resource)
- [Bundle Clone API changelog — Twilio](https://www.twilio.com/en-us/changelog/bundle-clone-api-for-regulatory-compliance)
- Console observation, both accounts, 13 Aug 2026.
