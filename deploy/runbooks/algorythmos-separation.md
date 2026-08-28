# Separating BitePerk from Algorythmos

BitePerk's pilot ran on **Algorythmos** infrastructure — a separate legal entity — before it had
its own. BitePerk now has its own Twilio accounts and its own Retell workspaces, and the decision
(28 Aug 2026) is **full separation, including the numbers**.

This file exists because separation is not a config change. Most of it is not ours to execute, one
piece of it is permanent, and one piece is a number printed on things that cannot be recalled.

📖 Inventory: [`NUMBERS.md`](../../NUMBERS.md) §4. Naming: [`NAMES.md`](../../NAMES.md).

## The state, read back 28 Aug 2026 — not from memory

Two claims that stood in the docs for weeks were wrong, and both would have misled a decision:

- **The Algorythmos Twilio account is `active`, type `Full` — NOT suspended.** The "suspended for
  lack of funds, 5 Aug" note was stale. Anyone reasoning from it concluded the pilot was already
  dead and separation was mostly bookkeeping. It isn't.
- **It holds five numbers, not one.** Three sit on trunk `TK7fdb99d65ddf3eeccb0ca76aaf38cc59`.

| Number | Trunk | Note |
|---|---|---|
| `+61 2 5504 1140` | — | ⚠️ **BitePerk's published marketing line** |
| `+61 2 7501 1140` | ✅ | the pilot line (Natalia's Bistro) |
| `+61 2 3821 1140` | ✅ | |
| `+61 2 5501 1140` | — | |
| `+61 2 5017 1140` | — | |

## Done on our side

- ✅ **Both production agents are clean.** Mazcina and Cuban Corner read back with **zero** tool
  URLs and zero webhooks on `vocotable.algorythmos.com.au`. Everything is `api.biteperk.com.au`.
- ✅ **The pilot line is retired from our routing.** `restaurants` row `11111111-…` unbound —
  no number, no agent — so `getRestaurantIdByDialedNumber` no longer resolves it. The row, 15
  reservations and 43 call logs stay: they are history, and `call_logs` references the venue.
  Safe because there were **0 future bookings** and the last call was 11 Aug.
- ✅ **Production routing is BitePerk-only** — Mazcina and Cuban Corner, nothing else.

## Still entangled, in the order it has to happen

### 1. The published marketing number — the long pole

`+61 2 5504 1140` is on their account and on BitePerk's website NAP block, Google Business Profile
and printed collateral. Two routes, and it is a **business decision, not a technical one**:

- **Port it** to `Biteperk-production`. Needs the other entity's written authorisation and account
  details; a Twilio port is weeks, not days, and the number keeps working throughout.
- **Replace it** with a BitePerk-owned number and update every citation. Faster to execute, but
  print cannot be recalled and inbound calls to the old number become theirs to route.

Nothing else on this list should start before this one is decided, because it sets the deadline.

### 2. Their pilot number still points at our hostname

`+61 2 7501 1140` is imported in the **legacy Retell workspace** with
`inbound_webhook_url = https://vocotable.algorythmos.com.au/retell/inbound` and a static fallback
agent.

That is their configuration on our hostname. **Do not drop `vocotable.algorythmos.com.au` from
[`deploy/nginx/vocotable.conf`](../nginx/vocotable.conf) until they repoint or retire it** — with
our side unbound, our webhook now returns no override, so the caller falls through to their stale
static agent. Dropping the hostname turns that into a TLS failure instead. Neither is good; theirs
is at least their own.

Ask them to remove the webhook. Then the `server_name` and the cert SAN can go.

### 3. Our own config still authenticates as them

| Where | Holds | Should hold |
|---|---|---|
| VM `/opt/vocotable/.env` | `TWILIO_ACCOUNT_SID=AC949756ac…` (Algorythmos) | `ACd423bd09…` Biteperk-production |
| `bp-voxtable-prod` / `voxtable-prod-twilio-account-sid` | `AC949756ac…`, and the pair **401s** | Biteperk-production |
| `bp-voxtable-prod` / `voxtable-prod-env` | legacy `RETELL_API_KEY`, legacy `RETELL_LLM_ID` | Biteperk workspace values |
| repo local `.env` | legacy-workspace `RETELL_API_KEY` | nothing — it caused a two-hour outage on 20 Aug |

The VM swap is required for SMS anyway: the Messaging Service belongs to Biteperk-production, and
a Messaging Service SID from another account is a *not found*, so every send fails until it moves.
Confirm nothing else on the VM uses those credentials first — voice runs over the SIP trunk, not
`/twilio/voice`, so it should be clear.

Keep the legacy Retell key **somewhere** until step 2 is done: reading their workspace is the only
way to confirm they have repointed. Then destroy it.

### 4. Their Retell workspace holds recordings

Calls recorded during the pilot live in the legacy workspace. They were tests, not customer audio
([`NUMBERS.md`](../../NUMBERS.md) §4), but confirm that against
[`recording-data-inventory.md`](recording-data-inventory.md) before anyone closes the workspace —
deletion is not reversible and a legal question is easier to answer with the data than without it.

## Permanent — do not "clean this up"

**`SYNTH_EMAIL_DOMAIN = bookings.vocotable.algorythmos.com.au`**
([`calcomService.ts:61`](../../apps/backend/src/services/calcomService.ts)) is baked into the
attendee identity of **every existing Cal.com booking**. It is a matching key, not a label:
changing it orphans past bookings and breaks the loop guard that stops voice bookings echoing back
in. It is internal-only and never shown to a guest.

It looks exactly like leftover branding. It is not. Leave it.

## Verification

- `npm run check:voice-lines` — every declared line still resolves. Run before and after each step.
- Routing table on the VM: only Mazcina and Cuban Corner should have a `twilio_phone_number`.
- After the VM credential swap: send one SMS and confirm the sender reads `BitePerk`.
- After they repoint the pilot: `curl` the old hostname and confirm nothing of ours depends on it,
  then drop the `server_name` and re-issue the cert without the SAN.
