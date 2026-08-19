# Accounts and compliance objects

## Three objects that all use `BU…` SIDs and are all account-scoped

The single most common error here is treating these as one thing. They are three separate
resources, none inherited across accounts, with different remedies.

| Object | What it is | Reuse across accounts |
|---|---|---|
| **Primary Customer Profile** (Trust Hub) | The verified business identity | Re-verify, or clone a bundle built on it |
| **Regulatory Bundle** | Per-country, per-number-type record required to *buy* a number | `Bundles/{Sid}/Clones` API |
| **Alphanumeric Sender ID** | The `BitePerk` SMS sender | **No clone API** — Twilio support adds the Account SID |

**Customer profiles are account-scoped, not org-shared.** This is worth stating plainly because
the opposite sounds plausible and makes new accounts look free. The evidence is a natural
experiment: production owned an approved profile and its bundle approved *instantly* via
"Use this profile"; staging had no profile, was never offered that path, and waited ~1 day on
documents. If profiles were org-shared, staging would have been instant too.

Consequence: a new Twilio account starts with nothing. It needs its own verified profile (slow)
or a cloned bundle (fast).

## Current inventory (verified 13 Aug 2026 — re-verify, don't trust)

| Account | SID | Customer Profile | AU Mobile Bundle | Sender ID |
|---|---|---|---|---|
| Algorythmos | `AC949756ac8dc4aced25b15b2e0bbb3a61` | — | — | — |
| Biteperk-staging | `AC8116857da2064ef3251533f3ade56f32` | none | `BUd5fe40c147a21757f04616a1180cdd89` | none |
| Biteperk-production | `ACd423bd09e9649e552a0b6d19a9eed338` | `BU975db7eebfb0b5525d6762f3d77e2087` | `BU8cb2353e1b34a75c6ed0cec20e163356` | `BUce1fa0ad6053c4444f3faca4c7957f25` |

Production compliance address: `AD3ea533a6a658f822c84cb37ebd88233e`.
Both BitePerk accounts are **siblings** under one Organization — neither is a subaccount
(`Parent Account SID: N/A`). At venue scale, subaccounts under one parent is the conventional
topology and behaves differently for number ownership, bundle inheritance, billing and A2P.
Decide the topology before onboarding scales; moving numbers between accounts later is a support
ticket, not an API call.

## Bundle Clone

The supported way to reuse compliance across accounts.

```
POST https://numbers.twilio.com/v2/RegulatoryCompliance/Bundles/{BundleSid}/Clones
  TargetAccountSid=AC…        # required
  FriendlyName=…              # optional
  MoveToDraft=true|false      # optional; true lands it in draft instead of approved
```

**Confirmed by Twilio's API reference:**

- Source bundle must be `twilio-approved`.
- Target must be an account "within the same organization".
- The clone is set to `twilio-approved` **automatically** — no second review queue, so you can
  provision numbers in the target account immediately.
- It clones the bundle *items* (identities and documents), not just the wrapper.

**Claimed elsewhere but NOT in the reference — treat as unverified:** that the source needs a
valid `valid_until` date, and that a deleted linked Address blocks the clone. Both are plausible;
neither is documented on the Clones page. Don't design provisioning logic around them without
testing.

**`Copies` is a different resource.** `Bundles/{Sid}/Copies` duplicates within the *same* account
(renewal/versioning). `Clones` crosses accounts. Confusing the two at scale is easy and expensive.

## Regulatory bundle from documents

Only needed when there's no profile and no cloneable bundle.

- Identity: **Direct Customer**. End user: **Business**.
- Business Name `BITEPERK PTY LTD`, Business ID `36 700 831 303`.
- Three document requirements — Business Name, Business Address, Business ID Number — are all
  satisfied by **one** upload: `asic/01-register/2026-07-29_ABR_ABN_Advice_36700831303.pdf`,
  under type *"Commercial registry or equivalent showing address"*. Confirmed on the approved
  staging bundle, which shows a single document clearing all three.
- The **ASIC Certificate of Registration does not work** — no address, no officers.
- The Occupier Consent (s100) is not among the offered document types.
- AU **Mobile** explicitly allows a business address anywhere in the world, which is why a
  serviced office is acceptable. AU **Local** does not — it needs an in-country address record.

Approval took ~1 day in practice against a budgeted ~3 business days. Plan on the longer figure;
be pleased by the shorter one.

## Account health gates (check before provisioning)

**Balance and auto-recharge.** A balance at or below $0 suspends the account — calls, SMS, API
calls and number purchases all stop. Errors to recognise: `10001` (account not active), `20005`
(account not active, application log), `30002` (account suspended, seen in messaging status
callbacks and the `Message.ErrorCode` field).

Twilio typically suspends on a *negative* balance rather than exactly zero, and reactivation after
payment takes 5–10 minutes (sign out and back in if the console still shows suspended). A negative
balance can also be the symptom of toll fraud rather than ordinary spend.

This is not hypothetical: the Algorythmos account carrying the live production voice number was
suspended for lack of funds. **Enable auto-recharge on any account carrying real traffic.**

**Trial vs upgraded.** Trial accounts cannot use alphanumeric sender IDs at all, and outbound
calling is restricted to verified numbers. Upgrade before depending on either.

## Messaging prerequisites people forget

Beyond the Messaging Service and sender:

1. **SMS geo permissions** (`Messaging → Settings → Geo permissions`) — Australia must be enabled
   or every send fails with error `21408`. Changes take effect immediately, including blocking.
   Enable only the countries actually sent to; the rest left off is free SMS-pumping protection.
   Subaccounts inherit the parent's permissions unless inheritance is disabled.

2. **Account-wide alphanumeric toggle** (`Messaging → Settings → General` → *Alphanumeric Sender
   ID: Enabled*). A registered sender ID will not be used if this is off.

3. Error `30042` = the alphanumeric sender is generic, unregistered, or not authorised for the
   destination — or the `From` value doesn't exactly match a registered sender. Setting a
   **default sender ID** for countries requiring registration lets Twilio substitute a compliant
   sender instead of failing.

Alphanumeric sender constraints: max 11 characters, letters/digits/spaces, at least one letter,
**one-way only** (recipients cannot reply, `STOP` does not work, so every message needs an
alternative opt-out route).
