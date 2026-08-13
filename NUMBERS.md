# NUMBERS.md — the telephony registry

> ☎️ **Every phone number in the BitePerk/VoxTable estate, what it can actually do, and
> what is still unwired.** Read this before you quote a number, wire a number, send an SMS,
> test a call, or tell anyone a number "works". Numbers here are *not* interchangeable, and
> **two of the four are not BitePerk platform infrastructure at all.**
>
> Naming rules live in [`NAMES.md`](NAMES.md) and win on any naming question.
> Procedure lives in [`deploy/runbooks/twilio-account-topology.md`](deploy/runbooks/twilio-account-topology.md).
> Credentials live in the gitignored `deploy/runbooks/vendor-accounts.local.md` — **never here.**
> This file is the inventory: what exists, on which account, wired to what.

Last verified in the Twilio console: **13 Aug 2026** — full audit of both platform numbers, both
trunks (General + Origination) and both Messaging Services. Re-verify before relying on a status;
account suspension and registration states change without anyone editing this file.

## Who owns what

| Vendor | Owner identity | Scope |
|---|---|---|
| Twilio | `twilio@biteperk.com.au` | Accounts `Biteperk-staging` + `Biteperk-production` (SIDs unchanged — only the owner moved) |
| Retell | `biteperk@gmail.com` | Workspaces **Biteperk** (production) + **Staging** |
| Twilio (legacy) | Algorythmos | The original account holding `+61 2 7501 1140` — **another project, not ours** |
| Retell (legacy) | `retellai@algorythmos.com.au` | Org `org_f0DPXgKIQTMJL4je` — still serves live traffic until the cutover |

⚠️ The Retell login is a **personal Gmail**, not a company mailbox. That is a knowingly accepted
exposure (no admin recovery, tied to one person), tracked in
[`deploy/runbooks/vendor-hardening.md`](deploy/runbooks/vendor-hardening.md) §2 — not an oversight.

---

## 1. Two estates — know which one you are touching

The most expensive mistake is treating "the BitePerk number" as one thing. It is two estates that
happen to appear side by side in old notes.

### BitePerk platform numbers — these are ours

| Number | Environment | Account | Takes a call today? | SMS? |
|---|---|---|---|---|
| `+61 468 202 846` | **Production** | Biteperk-production | ❌ No Retell agent bound yet | ✅ Enabled (never actually sent) |
| `+61 468 203 234` | **Staging** — never customer-facing | Biteperk-staging | ❌ No Retell agent bound yet | ✅ Enabled, stamped `Unverified` |

### Not BitePerk platform infrastructure — do not wire these

| Number | What it actually is | Rule |
|---|---|---|
| `+61 2 5504 1140` | **Published marketing line** — website, NAP, GBP, directories | Brand fact owned by `biteperk-website/src/data/site.ts`. Never goes in a `restaurants` row or Retell. |
| `+61 2 7501 1140` | **Algorythmos project line** — currently still serving Natalia's Bistro | Being migrated off (§4). Not part of the platform estate going forward. |

**`+61 2 5504 1140` is not a VoxTable line.** It must stay byte-identical everywhere it appears,
and where it terminates is not recorded in this repo. Do not wire it to Retell, do not put it in a
`restaurants` row, and do not "reconcile" it against the Twilio inventory.

⚠️ **`(02) 7501 1140` appears in the brand table as a print-only demo line** — the same number as
`+61 2 7501 1140`, in national format. **Printed collateral cannot be recalled.** Audit
`biteperk-website` before treating that number as disposable: if it is genuinely in print, it must
be kept alive or transferred into the BitePerk account, not abandoned.

---

## 2. Production — `+61 468 202 846`

**Account:** Biteperk-production `ACd423bd09e9649e552a0b6d19a9eed338`
**Bought:** 13 Aug 2026 · AU **Mobile** · **$8.25/mo**

| Resource | Identifier |
|---|---|
| Phone number SID | `PN05a730d0f19b14578b76f72a547fa48e` |
| Elastic SIP Trunk | `TK6fcd3c96ea8317181d4049ce6f938f10` — `voxtable-prod-au1`, region **AU1** |
| Trunk origination | `sip:sip.retellai.com;transport=tls` · priority 10 · weight 10 · enabled |
| Trunk termination | **Deliberately unconfigured** — VoxTable is inbound-only |
| Messaging Service | `MG7ceaa2aaa3cea6195ea7979d57b78b14` — `voxtable-prod-notifications`, region **US1** |
| Regulatory bundle | `BU8cb2353e1b34a75c6ed0cec20e163356` (AU Mobile Business, approved 13 Aug, instant) |
| Compliance address | `AD3ea533a6a658f822c84cb37ebd88233e` |
| Customer profile | `BU975db7eebfb0b5525d6762f3d77e2087` (approved) |
| Alphanumeric sender ID | `BUce1fa0ad6053c4444f3faca4c7957f25` — **in review**, Twilio ticket `28926493` |

**Region split: `AU1 — Voice` / `US1 — Messaging`.** Twilio has no messaging in AU1, so this is
the only shape available, not a misconfiguration. Never "fix" it by moving the number back to US1
— an AU1 trunk cannot see a US1 number and the trunk binding will silently break.

### What works · what doesn't

| Capability | Status |
|---|---|
| Receives a call at the Twilio edge | ✅ Traffic Status **Voice enabled** |
| Forwards to Retell over TLS | ✅ Origination `sip:sip.retellai.com;transport=tls` · pri 10 · wt 10 · enabled |
| Compliance registration | ✅ *Australia: Mobile – BitePerk Pty Ltd* — **Approved** |
| Bound to the Messaging Service | ✅ Selected messaging service `voxtable-prod-notifications` |
| **Answers with a Bella agent** | ❌ **No Retell agent bound** |
| **Resolves to a restaurant** | ❌ **No `restaurants` row** — `getRestaurantIdByDialedNumber` returns nothing and the backend fails closed |
| Sends SMS from the number | ✅ Traffic Status **Messaging enabled** — but **never actually sent**; treat as unproven until one test SMS lands |
| Receives SMS | ❌ No inbound webhook — number-level Messaging configuration reads "Set up", webhook URL blank. Intentional; nothing consumes inbound SMS |
| Sends SMS as `BitePerk` | ⚠️ Sender ID `BUce1fa0ad…` still in review; one-way only when approved |
| Survives a Retell outage | ❌ **No Disaster Recovery URL** (verified blank) — callers would get dead air |

**This number is not live and does not replace `+61 2 7501 1140`.** Twilio-side wiring is done;
Retell-side and database-side are not. A call to it today reaches nothing, and that is the
fail-closed design working, not a fault to route around.

---

## 3. Staging — `+61 468 203 234`

**Account:** Biteperk-staging `AC8116857da2064ef3251533f3ade56f32`
**Bought:** 13 Aug 2026 · AU **Mobile** · **$8.25/mo**

| Resource | Identifier |
|---|---|
| Phone number SID | `PN5a99b73b6f6a9e9a1cc40f7eb7feba42` |
| Elastic SIP Trunk | `TKdebe2aa1a4287ca4b2f22da0e9d10ed7` — `voxtable-staging-au1`, region **AU1** |
| Trunk origination | `sip:sip.retellai.com;transport=tls` · priority 10 · weight 10 · enabled |
| Messaging Service | `MG692c54a793f914c2e43c7d691f4cb41e` — `voxtable-staging-notifications`, region **US1** |
| Regulatory bundle | `BUd5fe40c147a21757f04616a1180cdd89` (approved 13 Aug, ~1 day from documents) |
| Compliance address | `AD0b3b71dc0a972ac2e678cb633e3a2c3d` |
| Customer profile | **None** — staging has never had one |
| Alphanumeric sender ID | **None** — see the warning below |

Same wiring state as production, verified item-for-item: origination
`sip:sip.retellai.com;transport=tls` (pri 10, wt 10, enabled), Traffic Status **Voice enabled** and
**Messaging enabled**, sender attached to `voxtable-staging-notifications`, no Retell agent, no
`restaurants` row, no Disaster Recovery URL.

## 3a. Trunk configuration — audited 13 Aug 2026

Both trunks are **identically configured**, which is what staging is for. Every setting below was
read from the console, not assumed.

| Setting | `voxtable-prod-au1` | `voxtable-staging-au1` | Wanted |
|---|---|---|---|
| Region | AU1 | AU1 | ✅ |
| Origination URI | `sip:sip.retellai.com;transport=tls` · 10 · 10 · enabled | same | ✅ |
| Termination | unconfigured | unconfigured | ✅ deliberate — inbound only |
| Call Recording | Disabled | Disabled | ✅ |
| Call Transfer (SIP REFER) | Disabled | Disabled | ✅ |
| Symmetric RTP | Disabled | Disabled | ✅ Twilio's recommended state |
| CNAM Lookup | Off | Off | ✅ US/CA only, billed per lookup |
| **Secure Trunking** | **Disabled** | **Disabled** | ⚠️ **should be ON** |
| **Disaster Recovery URL** | **blank** | **blank** | ⚠️ **should be set** |
| Header manipulation | none | none | ✅ |

**Secure Trunking off means media is plain RTP.** The origination URI already negotiates TLS for
*signalling*, so turning Secure Trunking on costs nothing and adds SRTP for the audio. The console
states the trade-off plainly: with it off, "SIP messages may be sent unencrypted or encrypted using
TLS. Any SRTP encrypted calls will be rejected." Turn it on **before** the first customer call, and
turn it on in staging first.

### Rules for this number

- **Never customer-facing.** Internal end-to-end testing only. It must not appear in marketing
  copy, a customer email, a `restaurants` row on production, or any directory.
- ⚠️ **SMS from staging is stamped `Unverified` on the handset.** The `BitePerk` alphanumeric
  sender ID is registered against the **production** Account SID only, and there is no clone API
  for sender IDs. Adding staging means asking Twilio support to add
  `AC8116857da2064ef3251533f3ade56f32` to ticket `28926493`. Until then, any branded-SMS test on
  staging measures the wrong thing.
- Staging bills separately from production. Balance was **$11.75 on 13 Aug 2026** — watch it,
  because a zero balance suspends the account and every test fails with `20005` for reasons that
  look like a code bug. Production sat at the same $11.75; **neither account has auto-recharge**,
  and an end-to-end call-and-SMS test run will eat into that.

## 3b. Ignore the leftover "finish compliance" prompts

Both dashboards nag about incomplete registrations. They are **dead registrations for numbers we
never owned** — started during the purchases that lost a number mid-flow on 13 Aug:

| Account | Stale registration | Reality |
|---|---|---|
| Biteperk-production | `+61495031140`, `+61495041140` | Both taken by another customer mid-purchase |
| Biteperk-staging | `+61495044529` | Same |

Production's banner *"Finish compliance for 2 numbers and senders"* counts these, not
`+61 468 202 846`. Do not "complete" them — there is no number behind them. They are cosmetic and
can be left alone.

---

## 4. Legacy — `+61 2 7501 1140` (Algorythmos, being migrated off)

**Account:** *My first Twilio account* `AC949756ac8dc4aced25b15b2e0bbb3a61` — **Algorythmos, not BitePerk**
**Type:** AU **Local** `02` — **voice only, cannot ever send SMS**

This is the number behind the `algorythmos` SIP trunk that Natalia's Bistro customers dial today,
bound to the live Bella agent in the **legacy** Retell workspace:

| Resource | Identifier |
|---|---|
| Retell agent | `agent_7b7a5f6c21c9968ee88afd3bac` |
| Retell LLM | `llm_2cad4da643f2beb4d07dd0b311d1` |
| Retell workspace | `org_f0DPXgKIQTMJL4je` (legacy, `retellai@algorythmos.com.au`) |

🔴 **The account was suspended for lack of funds as at 5 Aug 2026.** While suspended, this number
does not take calls — meaning **Natalia's line is down**, not degraded. Verify the balance before
investigating any "customers can't get through" report; the answer is usually here, not in the code.

### Its disposition

**Natalia's Bistro is migrating onto `+61 468 202 846`.** Until that cutover completes this number
still carries her traffic, so it is *legacy*, not *dead*.

Three rules while it exists:

1. **Keep this account funded through the cutover.** Because the migration moves Natalia's to a
   *different* number rather than porting this one, her old path stays intact — which makes it the
   rollback. A suspended account is a rollback that does not work.
2. **Do not delete the legacy Retell workspace.** `call_logs.recording_url` points at recordings
   hosted in *that* workspace, and the dashboard plays them back
   (`apps/frontend/src/pages/dashboard/LiveFeedDetailPage.jsx`). "Transcripts & call recordings" is
   a sold plan feature — letting the workspace lapse is a customer-visible regression, and there is
   an open retention review in `deploy/runbooks/recording-data-inventory.md`.
3. **Resolve the print-collateral question (§1) before handing the number back.**

After cutover it goes back to the Algorythmos project. It does not become a spare BitePerk number.

**A Local `02` number can never send SMS** — this is not a setting. Searching Twilio's AU Local
inventory with the SMS capability returns zero results. Any SMS design that assumes this number
can text is wrong at the number-type level, and the fix is a Mobile number, not configuration.

---

## 5. What the numbers can and cannot do

| | `+61 2 7501 1140` | `+61 468 202 846` | `+61 468 203 234` |
|---|---|---|---|
| Estate | **Legacy — Algorythmos** | BitePerk platform | BitePerk platform |
| Environment | Migrating off | Production | Staging |
| Number type | Local `02` | Mobile `+61 4` | Mobile `+61 4` |
| Monthly cost | ~$3.00 | $8.25 | $8.25 |
| Inbound voice | ✅ (when account funded) | ✅ Twilio side only | ✅ Twilio side only |
| Outbound voice | ❌ out of scope — no trunk termination anywhere | ❌ | ❌ |
| Outbound SMS | ❌ **never possible** | ✅ enabled, **never sent** | ✅ enabled, **never sent** + `Unverified` |
| Inbound SMS | ❌ | ❌ no webhook (deliberate — nothing consumes it) | ❌ no webhook (deliberate) |
| Bella answers | ✅ | ❌ | ❌ |
| Voice region | — | AU1 | AU1 |
| Messaging region | n/a | US1 | US1 |

**"Enabled" is not "works".** Both platform numbers report Messaging enabled with an approved AU
registration, but **neither has ever sent a message**. Treat outbound SMS as unproven until one
test SMS is delivered to a real handset from each number.

Current Twilio line rental across the estate: **~$19.50/month** — of which **$16.50 is BitePerk's**
(the two mobiles); the `02` rental belongs to the Algorythmos project.

---

## 6. Things agents get wrong about these numbers

**"The AU1 region means calls are processed onshore."** No. AU1 keeps the *Twilio* leg and voice
personal data in Australia. Retell is US-based, so call audio still leaves the country for
processing. **"Voice data processed and stored in Australia" is true; "calls processed onshore"
is not** — and the website's `check-claims` CI gate fails the build over exactly this wording.
Don't let it drift into internal language either; that is how it reaches customer copy.

**"The new production number replaced the old one."** Not yet. Adding a number never retires
another. `+61 2 7501 1140` remains the live Bella number until the cutover in §4 completes, and two
numbers pointing at one agent is a valid intermediate state.

**"We've migrated off Algorythmos, so nothing depends on them."** Check before saying it. As at
13 Aug 2026 the BitePerk-workspace agents still call back to **`vocotable.algorythmos.com.au`** for
`webhook_url` and all five tool URLs — so every call still resolves DNS and terminates TLS on a
domain BitePerk does not own. Moving the agents without moving the API hostname to
`api.biteperk.com.au` relocates the agent and keeps the dependency. Two further residuals are
permanent or near-permanent: `SYNTH_EMAIL_DOMAIN` (`bookings.vocotable.algorythmos.com.au`) is baked
into every existing Cal.com booking and can never change (NAMES.md §4), and the legacy Retell
workspace must stay alive because it hosts the call recordings the dashboard plays back.

**"The number is configured, so it works."** Console green ticks confirm configuration, not
connectivity. Only a real test call that lands in `call_logs` with the right `restaurant_id`
proves the chain.

**"I'll bind the venue's number with `inbound_agent_id`."** That field no longer exists — Retell
removed it on **31 Mar 2026** in favour of weighted `inbound_agents: [{agent_id, weight}]`. Any
snapshot or runbook still showing `inbound_agent_id` predates the change and will fail.

**"So the live number is webhook-only."** It is not. Verified on the live number 13 Aug 2026, it
carries **both**:

```
inbound_agents      : [{ "agent_id": "agent_7b7a5f6c21c9968ee88afd3bac", "weight": 1 }]
inbound_webhook_url : https://vocotable.algorythmos.com.au/retell/inbound
```

They coexist, and that combination is the trap. **The static agent is a fallback that fires when
the webhook fails** — so if `/retell/inbound` returns 401 (say, after a Retell key rotation), the
call does not drop. Bella answers using the LLM's stored `default_dynamic_variables`, which
nothing in production refreshes: on a venue number that means greeting the caller with **the
wrong restaurant's name and months-old dates**, while every tool call fails. A confidently wrong
agent is worse than a dead line.

Two consequences. Keep `default_dynamic_variables` **empty** on every LLM, so a fallback can only
be vague, never wrong. And when registering a *venue* number, prefer `inbound_webhook_url` alone —
webhook mode is what lets `/retell/inbound` resolve the restaurant from the dialled number at call
time; a static binding silently reverts that venue to single-tenant defaults.

**"I'll put the restaurant_id in the request."** Both Retell and Twilio handlers ignore
caller-supplied `restaurant_id` by design and resolve from the dialled number instead. That
closes off a class of "AI talked into booking at the wrong venue" attacks.

**"There are two Twilio accounts."** Three. The console gives almost no visual difference between
them — check the account picker before every action.

---

## 7. Where to change things

| Thing | Where it lives |
|---|---|
| Which number a venue uses | `restaurants.twilio_phone_number` — **the database is the SSOT**, no spreadsheets |
| Retell agent / LLM per venue | `restaurants.retell_agent_id`; live ids also in `NAMES.md` §6 |
| Buying / wiring a new number | Skill `twilio-au-number-provisioning`, or `deploy/runbooks/twilio-account-topology.md` |
| Account credentials, auth tokens | `deploy/runbooks/vendor-accounts.local.md` (**gitignored — never commit these**) |
| Sender ID / ACMA registration | `deploy/runbooks/acma-sender-id-registration.md` |
| Published marketing number + NAP | `biteperk-website/src/data/site.ts` and `BRAND.md` |
| Number friendly-name convention | `NAMES.md` §6 |

**Never put an Auth Token, API key or `SK…` secret in this file.** SIDs and phone numbers are
identifiers and are safe to commit; credentials are not, and `*.local.md` is gitignored for that
reason.

---

## 8. Open actions

Ordered. The sequence matters — each step is either reversible or gated by the one above it.

### Restore and make safe to fail

| # | Action | Blocks | Owner |
|---|---|---|---|
| 1 | **Enable auto-recharge + low-balance alert on both BitePerk accounts** | A repeat of the outage below. Both sat at **$11.75** with no auto-recharge. | Sam |
| 2 | **Recharge the Algorythmos account** — deliberately, as the rollback path for the cutover, not as a stopgap | Natalia's line is **down now**; also makes rollback possible at all | Sam |
| 3 | Payment method on both Retell workspaces (Staging's trial has **ended**) | Every Retell number operation — they 402 without it | Sam |
| 4 | **Secure Trunking ON** + **Disaster Recovery URL** on both trunks, staging first | Plain-RTP media today; dead air during a Retell outage | — |

### Make the platform estate real

| # | Action | Blocks | Owner |
|---|---|---|---|
| 5 | Build both agents in the **Staging** Retell workspace (currently empty) | Any staging call | — |
| 6 | Move the API hostname to `api.biteperk.com.au` and repoint the agents' `webhook_url` + 5 tool URLs | The migration meaning anything — see §6 | — |
| 7 | Import `+61 468 202 846` into the Biteperk workspace (`inbound_webhook_url` only) and prove it against a **temporary** `restaurants` row | Cutover; doing it this way risks nothing live | — |
| 8 | Cut Natalia's over: env → health → SQL rebind → venue re-forwards | Closing the Algorythmos dependency | Sam + venue |
| 9 | **Send one real test SMS from each number** | Outbound SMS is enabled but unproven | — |

### Follow-ups

| # | Action | Blocks | Owner |
|---|---|---|---|
| 10 | Add staging's Account SID to sender-ID ticket `28926493` | Branded-SMS testing on staging | Sam |
| 11 | Export legacy call recordings before any decommission | Dashboard playback of historical calls (a sold feature) | — |
| 12 | Audit `biteperk-website` for `(02) 7501 1140` in print collateral | Whether the legacy number can ever be released | Sam |
| 13 | Decide Direct Customer vs ISV before the first auto-provisioned venue | Per-venue provisioning at scale | Sam |
| 14 | Move the Retell login to `retell@biteperk.com.au` | Accepted exposure — cheapest to fix while the workspace is near-empty | Sam |

---

## Change log

| Date | Change |
|---|---|
| 13 Aug 2026 | File created. Production `+61 468 202 846` and staging `+61 468 203 234` bought and wired (trunk + messaging service, AU1 voice / US1 messaging). Confirmed the live Bella number sits on the **Algorythmos** account, not either BitePerk account, and that account is suspended for funds. |
| 13 Aug 2026 | **Full console audit of both numbers.** Corrected: both show Traffic Status **Messaging enabled** and an **Approved** AU Mobile compliance registration — the earlier "pending registration" note was wrong. Confirmed origination URI, region split, messaging-service binding on both. Recorded trunk hardening state (§3a): Secure Trunking **off** and Disaster Recovery URL **blank** on both. Noted the stale compliance prompts (§3b) are for lost numbers, not ours. |
| 13 Aug 2026 | **Restructured around ownership.** BitePerk's vendor estate moved to company-owned identities — Twilio under `twilio@biteperk.com.au` (same Account SIDs), Retell under a new account with **Biteperk** and **Staging** workspaces. §1 now separates the two BitePerk platform numbers from the marketing and Algorythmos lines, which are *not* platform infrastructure. §4 rewritten as the legacy/handover entry: Natalia's is migrating to `+61 468 202 846`, and until then the old account must stay **funded** because it is the rollback, and the legacy Retell workspace must stay **alive** because it hosts the recordings the dashboard plays back. §5 corrected — SMS is *enabled but never sent* on both numbers, not "pending". §6 gained the deprecated `inbound_agent_id` field, the dual-binding fallback trap, and the residual Algorythmos dependencies (agents still call back to `vocotable.algorythmos.com.au`; `SYNTH_EMAIL_DOMAIN` is permanent). §8 re-ordered into a gated sequence. |
