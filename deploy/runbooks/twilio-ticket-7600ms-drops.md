# Twilio ticket — fixed ~7.6 s release on AU1 trunks

**Send from `sam@biteperk.com.au`** (the address on the existing correspondence). New ticket, or
reference 28926493 only if they ask — that one is the sender-ID registration and is unrelated.

Every SID below was read from the Twilio API on 27 Aug 2026, not copied from earlier notes.
Evidence and reasoning: [`incident-7600ms-call-drops.md`](incident-7600ms-call-drops.md).

---

**Subject:** Inbound trunk calls released at a fixed ~7.6 s on AU1 Elastic SIP Trunks — two accounts, both regions of origination transport

Hello,

We have a reproducible fault on inbound Elastic SIP Trunking and we have exhausted what we can
test from our side. We would like the release cause from your records.

**Symptom.** Roughly a third of inbound calls to our AU1 trunks are released **7,590–7,653 ms**
after setup. The timing is machine-precise across fifteen occurrences and independent of call
content — we have drops mid-greeting, before the caller has spoken at all, and drops mid-sentence
later in the call, at the same instant. No human hangs up inside a 60 ms band repeatedly.

Your Calls API records these as `completed`. Our SIP endpoint (Retell, `sip.retellai.com`) records
receiving a **BYE**. Each side therefore attributes the release to the other, which is why we are
asking you for the Q.850 cause rather than guessing again.

**Accounts and numbers affected**

| Account SID | Number | Trunk |
|---|---|---|
| `AC8116857da2064ef3251533f3ade56f32` (staging) | `+61468203234` | `TKdebe2aa1a4287ca4b2f22da0e9d10ed7` (AU1) |
| `ACd423bd09e9649e552a0b6d19a9eed338` (production) | `+61468202846` | `TK6fcd3c96ea8317181d4049ce6f938f10` (AU1) |

Two separate accounts, built to the same recipe, both affected. The production number dropped its
very first call.

**What we have already eliminated.** Every component under our control has been replaced at least
once while the fault persisted: the voice agent, its prompt and greeting, the vendor workspace, our
API credentials, our backend runtime (two different platforms), the Twilio account, our database
records, and caller-ID presentation. The fault survived all of it.

**Origination transport is not the cause — this is the newest evidence.** Both trunks were built
with `sip:sip.retellai.com;transport=tls`. On **20 Aug 2026 at 05:34:29 UTC** we changed the
staging trunk to `transport=tcp` and disabled Secure Trunking. Calls still drop:

| Trunk configuration | Window | Drops / calls |
|---|---|---|
| TLS + Secure Trunking | to 20 Aug 05:34 UTC | 12 / 35 |
| **TCP, Secure Trunking off** | from 20 Aug 05:34 UTC | **3 / 19** |

(The apparent improvement is not statistically distinguishable at this sample size — Fisher exact
p = 0.21. We are not claiming TCP helped.)

*Counts above are from your Calls API for this trunk, so they are reproducible on your side. Our
SIP vendor's records show 13/38 and 3/19 over the same windows — the small difference is calls
present in one system and not the other, and it does not change the conclusion.*

**Dropped calls — TCP, Secure Trunking off** (staging, `AC8116857da…`):

- `CA2f6db49984dcfca614189de6edb7305e` — 26 Aug 2026 00:01:19 UTC
- `CAad2c09801078606bdd7abb2773d0a0c5` — 26 Aug 2026 07:32:24 UTC
- `CA4c177e347b13f0d89b80b4dfc82effcf` — 26 Aug 2026 10:31:08 UTC

**Dropped calls — TLS + Secure Trunking** (same account and trunk):

- `CA0cec0219c7ad8cc8943f8390ea8ad087` — 19 Aug 2026 01:36:36 UTC
- `CA6c9f06c2efefa0b56965ddfd23db0904` — 19 Aug 2026 05:04:56 UTC
- `CA91597bf39aef62b1c34c591413532590` — 19 Aug 2026 06:46:09 UTC
- `CA69e9bf9da5b5a133998f4a1f7c6ddbf1` — 13 Aug 2026 13:26:23 UTC (the trunk's first day)

**Healthy controls, same trunk, same day as the TCP drops:**

- `CA18775960bc01c17fef74676fb2e91a75` — 26 Aug 2026 12:53:38 UTC, 126 s
- `CAa8e75a9c41b42b4d3e11b84ebefa2d6e` — 26 Aug 2026 13:05:05 UTC, 311 s

**The one configuration that has never shown the fault** is a **US1** trunk with TCP origination on
a third account (`AC949756ac8dc4aced25b15b2e0bbb3a61`) — 25 calls, zero drops, 5 s to 232 s. With
transport now eliminated, the remaining difference between that trunk and the failing ones is the
**AU1 region** itself.

**What we are asking**

1. The **Q.850 release cause** for the three 26 Aug calls above, and **which side sent the BYE** —
   your network, the originating carrier, or our SIP endpoint.
2. Whether an **AU1 Elastic SIP Trunk originating to an out-of-region SIP endpoint** (Retell is
   US-hosted) is expected to enforce a **fixed session timer** or any media/signalling timeout in
   the 7–8 second range. A fixed ~7.6 s release that is indifferent to call content looks like a
   timer to us, not like a media fault.
3. Whether anything in the AU1 trunk defaults — session refresh (RFC 4028), SIP OPTIONS pings,
   or media-inactivity handling — differs from US1 in a way that could produce this.
4. If this is expected behaviour, what configuration avoids it. We would prefer to stay on AU1
   with TLS; we changed to TCP only to test a hypothesis and intend to change back.

This line is intended for a restaurant taking customer bookings, so a third of callers being cut
off is blocking launch. Happy to run any diagnostic call you would like on the staging number.

Thank you,
Sam Kalaliya
BitePerk Pty Ltd — ABN 36 700 831 303
