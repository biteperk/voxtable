# Trunk hardening and failure behaviour

Default Elastic SIP Trunk settings are not production settings. Every item below is a real
Twilio setting with a documented effect; API field names in brackets so they can be set by
script as well as console.

## General tab

### ⚠️ MEASURED CAVEAT (20 Aug 2026) — TLS origination is under investigation

Both AU1 trunks built to the recipe below (`transport=tls` + Secure Trunking) drop
**~a third of inbound calls at a fixed 7,593–7,653 ms**, from their first day, on two
separate accounts. The only trunk that has never done this is US1 with
`sip:sip.retellai.com;transport=tcp` and `secure=false` (25 calls, zero drops).

Transport and region are still confounded; the isolating experiment and full evidence are in
[`deploy/runbooks/incident-7600ms-call-drops.md`](../../../deploy/runbooks/incident-7600ms-call-drops.md).
**Until that resolves, do not treat TLS origination as proven-good for a new AU1 venue
trunk** — build it, then call it six times before handing the number to anyone.

### Secure Trunking — ENABLE [`Secure`]

TLS for SIP signalling, SRTP for media. Twilio's own security guidance recommends it wherever
possible. Our origination URI already carries `transport=tls`, so we are compatible today.

**Behaviour when enabled:**

- Non-encrypted calls are **rejected**. Every origination URI must use TLS.
- Twilio ignores any other `transport=` value (e.g. `transport=udp`) once Secure is on and uses
  TLS regardless. Default TLS port is 5061; a different port may be specified in the URI.
- Crypto suite on origination: `AES_CM_128_HMAC_SHA1_80` only (termination supports two).
- The optional MKI parameter is not supported.
- **Side effect:** SIP signalling no longer appears in PCAP captures in Call Logs. Disable
  temporarily if you need packet-level debugging, then re-enable.

**Do not use the `sips:` URI scheme.** Twilio does not support it for end-to-end encryption;
it silently rewrites `sips:` to `sip:` + `transport=tls` and warns this can behave unexpectedly.
Use `sip:` with `transport=tls` explicitly.

TLS version floor is 1.2 — Twilio dropped 1.0/1.1 for both inbound and outbound trunk calls and
SIP registration.

### Call Transfer (SIP REFER) — DISABLE [`TransferMode: disable-all`]

Nothing in VoxTable transfers calls. Enabled transfer is unused attack surface.
`TransferCallerId` (`from-transferee` / `from-transferor`) is irrelevant while transfer is off.

### CNAM Lookup — OFF [`CnamLookupEnabled`]

Resolves Caller ID Name into the SIP INVITE's From / Contact / P-Asserted-Identity.

**Only works for US and Canadian numbers, and is billed per lookup even when no data comes back.**
International numbers return null. On an Australian inbound line it is pure cost for no data.

### Symmetric RTP — leave DISABLED

Twilio strongly recommends leaving it off; enabling it exposes the RTP inject/bleed vulnerability
class. If NAT traversal seems to require it, fix NAT handling on the SIP side instead.

## Origination tab

### Disaster Recovery URL — SET IT [`DisasterRecoveryUrl` / `DisasterRecoveryMethod`]

The single biggest reliability gap in a default trunk.

If **none** of the origination SIP URIs can be reached — Retell down, DNS broken, TLS handshake
failing — Twilio invokes this webhook and expects TwiML back. Without it, callers get dead air
during a Retell outage and the venue never learns why bookings stopped.

The endpoint can do anything TwiML can: `<Say>` an apology, `<Dial>` the venue's own line, take a
voicemail, or replicate an IVR. Normal Twilio Voice rates apply to calls handled this way.

No re-arming is needed after recovery — Twilio tries origination first on every new call and only
falls through when all URIs fail.

> **Status: documented, not yet configured.** Neither `voxtable-prod-au1` nor
> `voxtable-staging-au1` has a disaster recovery URL set. Building the TwiML endpoint is
> outstanding work, not something already in place.

### Origination redundancy

Multiple URIs are tried by **priority** (lower number first), with **weight** distributing load
between URIs at equal priority:

| Origination SIP URI | Priority | Weight | Meaning |
|---|---|---|---|
| `sip:sip.retellai.com;transport=tls` | 10 | 10 | primary |
| `sip:secondary.example;transport=tls` | 20 | 10 | standby, tried only if priority 10 fails |

Worth adding if Retell ever publishes a secondary endpoint. Disaster recovery fires only after
*all* URIs fail, so a standby URI and a DR URL are complementary, not alternatives.

### The `edge` parameter

`;edge=sydney` pins which Twilio edge location sends the originating SIP traffic. Without it,
traffic leaves from the edge where the inbound PSTN call arrived — for AU callers on an AU1 trunk
that is already Sydney, so leave it off unless debugging a specific routing problem. If you do set
it, the destination must allow that edge's signalling and media IP ranges.

(Previously named `region`; the old name still works.)

## Termination — deliberately unconfigured

Termination carries outbound traffic (our infrastructure → Twilio → PSTN). VoxTable is
inbound-only and outbound calling is out of scope.

If it is ever enabled, Twilio requires at minimum an IP ACL **or** a credential list, and
recommends credentials because IP ACLs alone don't protect against all attack types. Outbound
caller ID must be a Twilio number on the account or a verified caller ID. E.164 with a leading `+`
is mandatory — anything else is rejected with SIP `400 Bad Request`.

Leaving termination blank is the decision, not an omission. A half-configured termination invites
someone to "finish" it later and widens the attack surface for no benefit.
