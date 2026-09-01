# NUMBERS.md — the telephony registry

> 🟢 **UPDATE 20 Aug 2026 (third revision, and the two above were WRONG) — the production
> line is wired and answering.** `+61 468 202 846` is imported in the **Biteperk** workspace as
> `voxtable-prod-mazcina`, webhook-only → `https://api.biteperk.com.au/retell/inbound`, bound to
> agent **`agent_b6b6488af08b82d80e8f4d270a`** ("Mazcina Resto-Bar (production)", LLM
> `llm_5f642f051bb83c28d02cea4e1cbc`) and venue row `44444444-…`. Four real calls reached that
> agent on 20 Aug (12:26, 12:41, 16:50, 17:24). `npm run check:voice-lines` passes every check.
>
> 🔴 **Why the two revisions above said the opposite: they were read with the wrong API key.**
> The repo's local `.env` holds a Retell key for the **legacy Algorythmos workspace**, not
> production. That workspace contains the pilot line `+61 2 7501 1140` and a *different* Mazcina
> agent (`agent_3bedcbdd77017136e5b4ade412`). Read with it, the production number 404s and the
> correct agent id "does not exist" — clean, confident, and completely wrong. Acting on that
> reading repointed the live venue row at an agent from the other workspace and **took the
> production line down for about two hours** before it was restored.
>
> **The production key lives on the VM (`/opt/vocotable/.env`) and nowhere else.** Never check or
> change this line with the repo's local `.env`. `assert-line.mjs` and `apply-line.mjs` now load
> credentials from `retell_credentials` in [`deploy/voice-lines.json`](deploy/voice-lines.json)
> rather than the shell, and refuse to proceed when a key cannot see the line's declared agent.
>
> **Two useful rules came out of it.** A wrong key never errors — it answers every question with
> a tidy 404, so "the binding vanished" and "I am looking at the wrong estate" are
> indistinguishable without an independent check. And if BOTH a number and its agent appear
> missing, suspect the credentials before the line; things do not usually vanish in pairs.
>
> 🔴 **Do NOT publicise this number yet.** The real remaining fault is the fixed-timer drop:
> those four calls ran 4,937 / 7,602 / 8,215 / 8,359 ms. That is the AU1 trunk incident, still
> open — [`deploy/runbooks/incident-7600ms-call-drops.md`](deploy/runbooks/incident-7600ms-call-drops.md).

> ☎️ **Every phone number BitePerk owns, what it can actually do, and what is still
> unwired.** Read this before you quote a number, wire a number, send an SMS, test a call,
> or tell anyone a number "works". **BitePerk owns exactly three numbers** (§1) — anything
> else you have seen referred to as "the BitePerk number" is either marketing or another
> company's infrastructure, and wiring it is a mistake.
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

⚠️ The Retell login is a **personal Gmail**, not a company mailbox. That is a knowingly accepted
exposure (no admin recovery, tied to one person), tracked in
[`deploy/runbooks/vendor-hardening.md`](deploy/runbooks/vendor-hardening.md) §2 — not an oversight.

Anything on an **Algorythmos** account is a different company's infrastructure and is out of scope
(§4).

---

## 1. BitePerk owns exactly three numbers

| Number | Environment | Account | Takes a call today? | SMS? |
|---|---|---|---|---|
| `+61 468 202 846` | **Production** | Biteperk-production | ✅ **Answers** — Biteperk workspace, agent `agent_b6b6488af08b82d80e8f4d270a`, venue row resolves. Drops roughly half its calls in a fixed ~7,447–7,653 ms band (trunk incident, #341) | ✅ Enabled (never actually sent) |
| `+61 485 071 140` | **Production** — Cuban Corner Parramatta | Biteperk-production | ✅ **Wired end to end, verified 1 Sep 2026.** Imported to the Biteperk workspace webhook-only, bound to agent `agent_2892d65ceace4e68d8a3f3e80c` / llm `llm_53c6e9de9aac3b60270ffdd6bcba`, venue row `22222222-…` resolves, US1 trunk `TK50f2a0cc6c4906a1b946867489716548`. `assert-line.mjs --strict` passes **17/17**, including the Twilio trunk layer. ⚠️ Still **no Disaster Recovery URL** on the trunk (#343), so a Retell outage is dead air. Not customer-facing: the eleven-leg rehearsal battery has not been run | ⚠️ Registration required; nothing wired |
| `+61 468 203 234` | **Staging** — never customer-facing | Biteperk-staging | ✅ Bound — imported to the Staging workspace (webhook mode) 13 Aug; `VoxTable Staging Venue` resolves | ✅ Enabled and **proven 18 Aug 2026** — delivers from the number. Cannot send branded: `BitePerk` is production-only, and the fallback is silent (no `Unverified` stamp) |

That is the whole platform estate. If a number is not in this table, **it is not ours to wire** —
do not put it in a `restaurants` row, do not register it with Retell, and do not "reconcile" it
against the Twilio inventory.

Two numbers get mistaken for platform numbers often enough to name:

- **`+61 2 5504 1140` — the published marketing line.** Website, NAP block, Google Business
  Profile, directory citations. It must stay byte-identical everywhere it appears, and where it
  terminates is not recorded in this repo. It is a brand fact owned by
  `biteperk-website/src/data/site.ts`, not a VoxTable line.
- **`+61 2 7501 1140` — an Algorythmos number.** A different company's (§4). It also appears in the
  brand table as the print-only demo line `(02) 7501 1140` — same number, national format — so
  **check `biteperk-website` before anyone assumes it can just disappear**; printed collateral
  cannot be recalled, and that is a brand question for Algorythmos and BitePerk to settle, not a
  telephony one.

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
| Alphanumeric sender ID | `BitePerk` — ✅ **ACMA-approved 18 Aug 2026**. Twilio bundle `BUce1fa0ad6053c4444f3faca4c7957f25`, ticket `28926493`. ✅ **Attached to `voxtable-prod-notifications` (`MG7ceaa2aaa3cea6195ea7979d57b78b14`)** — sender `AIdcca9ac75bbd77a5ff1a7570ed698660`, SMS-capable, in the pool alongside `+61468202846` as fallback. Read back over the API 28 Aug 2026 and again 1 Sep 2026. ⚠️ **Nothing sends as it, for two reasons and the second is the bigger one:** the app configures no messaging sender, AND the VM authenticates as the legacy Algorythmos account `AC949756ac8dc4aced25b15b2e0bbb3a61`, which owns neither this Messaging Service nor `+61468202846` — so no sender value can work until the credentials are corrected |

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
| **Answers with a Bella agent** | ✅ `agent_b6b6488af08b82d80e8f4d270a` in the **Biteperk** workspace — verified by four real calls on 20 Aug. ⚠️ `agent_3bedcbdd77017136e5b4ade412` is a **different agent in the legacy workspace**; binding it here takes the line down |
| **Resolves to a restaurant** | ✅ Row `44444444-…` (`Mazcina Resto-Bar`) resolves it, verified by a signed `/retell/inbound` probe |
| Sends SMS from the number | ✅ Traffic Status **Messaging enabled** — but **never actually sent**; treat as unproven until one test SMS lands |
| Receives SMS | ❌ No inbound webhook — number-level Messaging configuration reads "Set up", webhook URL blank. Intentional; nothing consumes inbound SMS |
| Sends SMS as `BitePerk` | ⚠️ **ACMA-approved, not wired.** Needs the account-wide alphanumeric toggle on, `BitePerk` added as a sender on `voxtable-prod-notifications`, and `notificationWorker` repointed. One-way only — no copy may invite a reply. Runbook §6 |
| Survives a Retell outage | ❌ **No Disaster Recovery URL** (verified blank) — callers would get dead air |

**This number is not live yet.** Twilio-side wiring is done; Retell-side and database-side are not.
A call to it today reaches nothing, and that is the fail-closed design working, not a fault to
route around. It becomes BitePerk's production line — and Natalia's line — at §8 step 6.

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
| Alphanumeric sender ID | **None.** `BitePerk` is approved against the *production* Account SID only |

Same **Twilio** wiring as production, verified item-for-item: origination
`sip:sip.retellai.com;transport=tls` (pri 10, wt 10, enabled), Traffic Status **Voice enabled** and
**Messaging enabled**, sender attached to `voxtable-staging-notifications`, no Disaster Recovery URL.

Beyond Twilio, staging has since gone **further than production**: the number was imported to the
Retell **Staging** workspace in webhook mode on 13 Aug and a `restaurants` row (`VoxTable Staging
Venue`) resolves it, with unknown numbers failing closed — see §8 item 2b. This paragraph
previously said "no Retell agent, no `restaurants` row", which contradicted §8 and is corrected
here. Production's `+61 468 202 846` remains unbound on both counts.

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
| **Secure Trunking** | **Disabled** | **✅ ON** (19 Aug 2026, via AU1 API, read back `secure=true`) | prod still ⚠️ — flip at cutover |
| **Disaster Recovery URL** | **blank** | **blank** | ⚠️ **should be set** |
| Header manipulation | none | none | ✅ |

**Secure Trunking off means media is plain RTP.** The origination URI already negotiates TLS for
*signalling*, so turning Secure Trunking on costs nothing and adds SRTP for the audio. The console
states the trade-off plainly: with it off, "SIP messages may be sent unencrypted or encrypted using
TLS. Any SRTP encrypted calls will be rejected." Turn it on **before** the first customer call, and
turn it on in staging first.

⚠️ **This stopped being theoretical on 19 Aug 2026.** A staging call (`CA6cb88e2c31f0aae148facf3d7bcec321`,
Retell `call_04ca66ce86bd9fdbfa9c936830e`, 02:53 UTC) connected, the agent spoke her full greeting —
and the caller's media never arrived: the multichannel recording shows the **caller channel at
digital zero for the entire 7.6 s call** while the agent channel carries steady speech. The caller
heard silence and hung up; Retell filed it as `user_hangup`, which is how a media-path failure
disguises itself as a caller choice. It is intermittent — 3 of that day's 4 calls had working
media — which makes it exactly the class of fault that erodes trust in the line while every log
reads clean. Retell's own log shows no error: from its side the PSTN leg simply ended.

Two lessons for whoever debugs the next "it dropped": **identical short durations are a machine,
not a person** (the day's three failed calls died at 7594/7601/7640 ms — a 46 ms spread across
three "human hangups" is nothing of the sort), and **the multichannel recording is the instrument**
— per-channel RMS separates "caller hung up on working audio" from "caller never had audio" in
one look, when transcript, webhook log and disconnection reason are all identical between the two.

When Secure Trunking is toggled, test with **several** calls, not one — the fault is intermittent,
so a single good call proves nothing. And if no-media calls recur with SRTP on, it becomes a
Twilio support ticket, with the SIDs above as evidence.

⚠️ **The trunks are invisible to the default Twilio API — and the empty responses look like
missing infrastructure, not a wrong hostname.** Learned the hard way, 19 Aug 2026, chasing the
incident above: `GET https://trunking.twilio.com/v1/Trunks` on the staging account returns an
empty list, the trunk SID 404s, `Calls.json` shows no calls ever, and the number shows no
`trunk_sid` — four independent readings that together look exactly like a deleted voice estate.
None of it was true. **Those are all US1 endpoints, and this estate is AU1**: regional resources
only answer at `{product}.sydney.au1.twilio.com` (the edge segment is mandatory —
`trunking.sydney.twilio.com` does not resolve, and the older `api.au1.twilio.com` form is
deprecated, dead 28 Apr 2026). **AU1 also requires region-scoped credentials** — the account's
US1 auth token gets `401 Authenticate` at the Sydney FQDN, so the working paths into the AU1
estate are the console (which sees all regions) or an API key created with Region = AU1
(Console → Account → API keys). No AU1 API key exists as of 19 Aug 2026 — creating one and
storing it in staging Secret Manager (suggested names `voxtable-stg-twilio-au1-key-sid` /
`-key-secret`) is what makes the voice estate automatable at all.

The same blindness applies in reverse and explains an old §2 note: messaging lives in US1, voice
in AU1, so **no single API view ever shows the whole number**. Anyone auditing "what does this
account have?" must query both regions or use the console, and an agent asserting "the trunk does
not exist" from a US1 response is making the 19 Aug mistake again.

### Rules for this number

- **Never customer-facing.** Internal end-to-end testing only. It must not appear in marketing
  copy, a customer email, a `restaurants` row on production, or any directory.
- ⚠️ **Branded SMS cannot be proven from staging — and the failure is silent, not stamped.**
  Tested 18 Aug 2026: with `BitePerk` sitting in the staging pool, the send delivered **from
  `+61 468 203 234`** with no `Unverified` mark and no error. Do not look for a stamp as the
  signal. ACMA approval did not change this: `BitePerk` was approved on 18 Aug 2026 against the
  **production** Account SID only, and
  there is no clone API for sender IDs. Adding staging means asking Twilio support to add
  `AC8116857da2064ef3251533f3ade56f32` to ticket `28926493` — now a support round-trip rather than
  a free amendment during review. **Branded-SMS testing therefore happens on production**, not
  here; a staging send measures the wrong account.
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

## 4. Algorythmos — a different company, out of scope

`+61 2 7501 1140`, its Twilio account and its Retell workspace belong to **Algorythmos**, a
separate legal entity. **They are not BitePerk infrastructure and are not tracked here.** Do not
add BitePerk resources to them, do not fund them from BitePerk, and do not treat that number as a
spare line.

They appear in this repo's history only because BitePerk's pilot ran on borrowed infrastructure
before it had its own. Everything BitePerk operates now lives on the three numbers in §1.

### Read back from that account on 28 Aug 2026 — two long-standing claims here were wrong

The account was checked with the credentials still sitting in the VM's `.env`. It is **`active`,
type `Full`** — **not suspended**. The "suspended for lack of funds, 5 Aug" line that stood here
for three weeks was stale, and anyone reasoning from it concluded the pilot was already dead.

It holds **five** numbers, not one, three of them on trunk `TK7fdb99d65ddf3eeccb0ca76aaf38cc59`:

| Number | Note |
|---|---|
| **`+61 2 5504 1140`** | ⚠️ **BitePerk's published marketing line** — website NAP, Google Business Profile, print. On the other entity's account |
| `+61 2 7501 1140` | the pilot line (Natalia's), on the trunk |
| `+61 2 3821 1140` | on the trunk |
| `+61 2 5501 1140`, `+61 2 5017 1140` | no trunk |

That marketing number is the reason separation is not just a config change: **BitePerk's own
published phone number is on infrastructure BitePerk does not own.** Porting it needs the other
entity's cooperation and a website / GBP / print change. Tracked in
[`deploy/runbooks/algorythmos-separation.md`](deploy/runbooks/algorythmos-separation.md).

**What this means in practice:**

- ✅ **The pilot line is retired from OUR side (28 Aug 2026).** `restaurants` row `11111111-…`
  is unbound — no `twilio_phone_number`, no `retell_agent_id` — so `getRestaurantIdByDialedNumber`
  no longer resolves it and `/retell/inbound` returns no override. The row, its 15 reservations and
  43 call logs stay as history. 0 future bookings, last call 11 Aug.
- ⚠️ **Their end still points at us.** `+61 2 7501 1140` is imported in the legacy Retell workspace
  with `inbound_webhook_url = https://vocotable.algorythmos.com.au/retell/inbound` and a static
  fallback agent. Their config, our hostname — so **nginx cannot drop that `server_name` until they
  change it**, or their caller reaches a stale agent instead of a clean failure.
- **A Local `02` number can never send SMS** — worth keeping because the constraint is generic, not
  about this number. Searching Twilio's AU Local inventory with the SMS capability returns zero
  results, so any SMS design assuming a landline can text is wrong at the number-type level; the
  fix is a Mobile number, not configuration.

The one genuinely permanent tie is `SYNTH_EMAIL_DOMAIN`
(`bookings.vocotable.algorythmos.com.au`), baked into the attendee identity of every existing
Cal.com booking and immutable per [`NAMES.md`](NAMES.md) §4. It is internal-only and never shown to
a customer. The API-hostname tie is **done on our side**: both production agents — Mazcina and Cuban Corner —
were read back on 28 Aug with zero tool URLs and zero webhooks on the old host. What remains is
their pilot number pointing at it, above.

---

## 5. What the numbers can and cannot do

Both numbers BitePerk owns. Nothing else belongs in this table.

| | `+61 468 202 846` | `+61 468 203 234` |
|---|---|---|
| Environment | Production | Staging — never customer-facing |
| Account | Biteperk-production | Biteperk-staging |
| Number type | Mobile `+61 4` | Mobile `+61 4` |
| Monthly cost | $8.25 | $8.25 |
| Inbound voice | ✅ Twilio side only — no Retell agent bound | ✅ Twilio side only |
| Outbound voice | ❌ deliberate — no trunk termination configured | ❌ |
| Outbound SMS | ✅ enabled, **never sent** | ✅ **proven 18 Aug 2026** — delivered from the number; branded sending is not possible here (§8 item 9a) |
| Inbound SMS | ❌ no webhook (deliberate — nothing consumes it) | ❌ no webhook (deliberate) |
| Bella answers | ❌ not yet | ❌ not yet |
| Voice region | AU1 | AU1 |
| Messaging region | US1 | US1 |

**"Enabled" is not "works".** Both report Messaging enabled with an approved AU registration, but
**neither has ever sent a message**. Treat outbound SMS as unproven until one test SMS is delivered
to a real handset from each.

BitePerk's Twilio line rental: **$16.50/month.**

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
`api.biteperk.com.au` relocates the agent and keeps the dependency. One further residual is
permanent: `SYNTH_EMAIL_DOMAIN` (`bookings.vocotable.algorythmos.com.au`) is baked into the
attendee identity of every existing Cal.com booking and can never change (NAMES.md §4). It is
internal-only and never shown to a customer.

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

Natalia's has no working line until step 4 completes — the one she used was never BitePerk's.
That makes this a restoration, not a migration, and it is the reason the order below starts where
it does.

### Stand the estate up

| # | Action | Blocks | Owner |
|---|---|---|---|
| 1 | **Auto-recharge + low-balance alert on both accounts** ✅ recharged 13 Aug — arm auto-recharge so it cannot recur | A dead balance suspends an account and every call fails in ways that look like a code bug | Sam |
| 2 | ~~Build both agents in the **Staging** workspace~~ ✅ 13 Aug — both built, every URL pointing at the staging API, verified by 15 read-back assertions | — | — |
| 2a | ~~Staging key into `voxtable-stg-retell-api-key` + roll a revision~~ ✅ 13 Aug — version 4, revisions `api-00031` / `worker-00027`; signed request verifies **204**, wrong key **401** | — | — |
| 2b | ~~`restaurants` row bound to `+61 468 203 234`~~ ✅ 13 Aug — number imported to the Staging workspace (webhook mode) and `VoxTable Staging Venue` resolves with fresh per-call variables; unknown numbers fail closed | — | — |
| 2c | **Make a real call to `+61 468 203 234`** — everything but audio is proven. The machine half is green (`npm run smoke:staging`, first green run 14 Aug); what remains is the ten-leg human battery (legs 8–9 added 19 Aug 2026: honest capacity, closed day; leg 4 blocked on the drinks list) in [`deploy/runbooks/staging-call-battery.md`](deploy/runbooks/staging-call-battery.md), whose results table is still empty. Leg 6 (SMS) additionally needs `NOTIFICATIONS_ENABLED` + `NOTIFICATIONS_SMS_FROM` on the staging worker — issue #185, not set today | Confidence before the production cutover | Sam |
| 3 | **Secure Trunking ON** + **Disaster Recovery URL** on both trunks, staging first — ✅ **staging trunk secured 19 Aug 2026** (AU1 API key in Secret Manager: `voxtable-stg-twilio-au1-key-sid`/`-secret`; readback `secure=true`); production trunk and both DR URLs still open — ⚠️ was upgraded to urgent by the no-media incident: a 19 Aug staging call lost caller media entirely (zero inbound audio, §3a) on the plain-RTP path, intermittently. One-command toggle recorded in §3a's incident note; verify with several calls, and escalate to Twilio with the recorded SIDs if no-media calls recur under SRTP | Plain-RTP media today; dead air during a Retell outage; intermittent no-media calls indistinguishable from caller hangups | Sam |
| 4 | Move the API hostname to `api.biteperk.com.au` and repoint the agents' `webhook_url` + 5 tool URLs | The last operational tie to the other company — see §6 | — |

### Put Natalia's back on the air

| # | Action | Blocks | Owner |
|---|---|---|---|
| 5 | 🔴 **BLOCKED — release `+61 468 202 846` from whatever Retell workspace currently holds it.** The import is refused with `Phone number already exists` while the number 404s in both BitePerk workspaces; a number lives in exactly one workspace account-wide. Sign in to the Retell dashboard, find it (check the legacy Algorythmos workspace too — §4), delete it there, then run `node .claude/skills/retell-agent-quality/scripts/apply-line.mjs +61468202846 --apply`, which imports webhook-only and reads back | Everything below. **This is the whole remaining blocker** — the agent, the venue row and the prompt are all verified correct | Sam |
| 5a | Create an **AU1 API key on the production Twilio account** (Console → Account → API keys, Region = AU1) and store it as `voxtable-prod-twilio-au1-key-{sid,secret}` | The trunk layer of `assert-line.mjs` is unverifiable on production without it — the asymmetry that let production drift unseen while staging stayed checkable | Sam |
| ~~5b~~ | ~~Mirror the production `RETELL_API_KEY` / `RETELL_WEBHOOK_SECRET` into repository secrets~~ **Done 23 Aug 2026** — `RETELL_PROD_API_KEY` / `RETELL_PROD_WEBHOOK_SECRET` set from the VM's `.env`; run `32631947070` is the first off-laptop green on the production line (layers 1–14; 15 still skipped pending 5a). The staging job still fails on `secretmanager.versions.access` for `voxtable-stg-deployer` — platform #31 was closed unmerged, the grant needs a clean Terraform PR | Sam |
| 6 | Bind Natalia's: env → health check → SQL rebind (`twilio_phone_number`, `retell_agent_id`) | Her service | — |
| 7 | Venue re-points call forwarding to `+61 468 202 846` | Her service — **needs the restaurant, so give them notice** | Sam + venue |
| 8 | **Send one real test SMS from each number** | Outbound SMS is enabled but has never been sent | — |

There is **no rollback to the old number** — it belongs to another company and is not coming back.
Step 5 exists to compensate: the new number is proven end-to-end against a throwaway restaurant row
before Natalia's is touched, so a failure delays the restoration rather than deepening it.

### Follow-ups

| # | Action | Blocks | Owner |
|---|---|---|---|
| 9 | **Wire the approved `BitePerk` sender ID** — ✅ ACMA approved it 18 Aug 2026, but nothing sends as it yet. ✅ **The code half shipped 18 Aug 2026** — `notificationWorker` now sends via `messagingServiceSid` (a bare alphanumeric `from` has no fallback and fails outright where unsupported), verified by `npm run smoke:sms-sender`. **What remains is console-only:** the account-wide *Alphanumeric Sender ID* toggle ON, AU enabled in Geo Permissions, and `BitePerk` added as a sender on `voxtable-prod-notifications` keeping the number as fallback. Runbook §6 | Branded SMS. Sends today still show the number, which is correct but unbranded | Sam |
| 9a | Add staging's Account SID to sender-ID ticket `28926493` — now a support round-trip, not a free amendment during review. **Until then branded-SMS testing must happen on production** — a staging send silently delivers from the number instead (proven 18 Aug 2026: no `Unverified` stamp, no error, indistinguishable from success) | Branded-SMS testing on staging (and leg 6 of the call battery) | Sam |
| 10 | Fix the recording exposure ([#173](https://github.com/biteperk/voxtable/issues/173)) — cheapest **before** real calls exist | Nothing today; every real call once Natalia's is live inherits it | — |
| 11 | Settle `(02) 7501 1140` in brand collateral **with Algorythmos** | A brand question, not a telephony one | Sam |
| 12 | Decide Direct Customer vs ISV before the first auto-provisioned venue | Per-venue provisioning at scale | Sam |
| 13 | Move the Retell login to `retell@biteperk.com.au` | Accepted exposure — cheapest while the workspace is near-empty | Sam |

---

## Change log

| Date | Change |
|---|---|
| 13 Aug 2026 | File created. Production `+61 468 202 846` and staging `+61 468 203 234` bought and wired (trunk + messaging service, AU1 voice / US1 messaging). Confirmed the live Bella number sits on the **Algorythmos** account, not either BitePerk account, and that account is suspended for funds. |
| 18 Aug 2026 | **ACMA approved branded SMS.** Both decisions granted 16:00 AEST — participation by Biteperk Pty Ltd, and registration of the sender ID **`BitePerk`** (submitted by Twilio Inc.; both automated; s558(1) appeal window to ~15 Sep 2026). Evidence in `asic/04-correspondence/2026-08-18_ACMA_SenderID_*.pdf`. ⚠️ Approval alone changes nothing on a handset — the sender ID is not attached to the Messaging Service and `notificationWorker` still sends from the number. Staging remains out of scope (production Account SID only). |
| 13 Aug 2026 | **Full console audit of both numbers.** Corrected: both show Traffic Status **Messaging enabled** and an **Approved** AU Mobile compliance registration — the earlier "pending registration" note was wrong. Confirmed origination URI, region split, messaging-service binding on both. Recorded trunk hardening state (§3a): Secure Trunking **off** and Disaster Recovery URL **blank** on both. Noted the stale compliance prompts (§3b) are for lost numbers, not ours. |
| 13 Aug 2026 | **Restructured around ownership.** BitePerk's vendor estate moved to company-owned identities — Twilio under `twilio@biteperk.com.au` (same Account SIDs), Retell under a new account with **Biteperk** and **Staging** workspaces. §1 now separates the two BitePerk platform numbers from the marketing and Algorythmos lines, which are *not* platform infrastructure. §4 rewritten as the legacy/handover entry: Natalia's is migrating to `+61 468 202 846`, and until then the old account must stay **funded** because it is the rollback, and the legacy Retell workspace must stay **alive** because it hosts the recordings the dashboard plays back. §5 corrected — SMS is *enabled but never sent* on both numbers, not "pending". §6 gained the deprecated `inbound_agent_id` field, the dual-binding fallback trap, and the residual Algorythmos dependencies (agents still call back to `vocotable.algorythmos.com.au`; `SYNTH_EMAIL_DOMAIN` is permanent). §8 re-ordered into a gated sequence. |
| 13 Aug 2026 | **Algorythmos removed from scope.** It is a separate company; its number, Twilio account and Retell workspace are no longer tracked here. §1 states plainly that BitePerk owns two numbers and everything else is out of scope; §4 is now a boundary note rather than an inventory entry; §5 and §8 cover only BitePerk's estate. The recordings that appeared to block separation were **test calls, not customer audio**, so no export is needed and the legacy workspace carries no obligation — the exposure mechanism behind them is still tracked in [#173](https://github.com/biteperk/voxtable/issues/173) because it will apply to real calls. **There is no rollback to the old number**, so the cutover now proves the new one against a throwaway restaurant row first. |
