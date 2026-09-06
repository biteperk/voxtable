# Binding the number to Retell and the database

Twilio work alone produces a number that rings and reaches nothing. Three things must line up:
the trunk forwards to Retell, Retell knows which agent answers the dialled number, and the
backend can resolve that number to a restaurant.

## The call path

```
Caller → Twilio AU Mobile number
       → Elastic SIP Trunk (AU1)  origination: sip:sip.retellai.com;transport=tls
       → Retell  (matches the dialled number to a registered agent)
       → agent calls back into /retell/tools/* on the VoxTable backend
       → backend resolves restaurant from the dialled number
```

Each hop is a separate registration. A break in any one of them presents as "the number rings
out", so check them in order rather than guessing.

## Retell side

Import the number into Retell and bind an agent. Termination URI on the Retell side is
`<trunk>.pstn.twilio.com`.

⚠️ **How you bind depends on whether this is a fixed line or a venue number** — and getting it
wrong breaks multi-tenant routing silently.

| Case | Binding | Why |
|---|---|---|
| A single fixed line (BitePerk's own numbers) | static `inbound_agents: [{agent_id, weight: 1}]` | One number, one agent, forever |
| **Any per-venue number** | **`inbound_webhook_url` (webhook mode)** — never a static binding | `NAMES.md` §6. Webhook mode is what makes `/retell/inbound` fire so the backend can resolve the restaurant from `to_number` at call time |

(`inbound_agent_id` no longer exists — Retell replaced it with the weighted `inbound_agents` list
on 31 Mar 2026. Every VoxTable line today is webhook mode with `inbound_agents` empty.)

A static `inbound_agents` entry means `/retell/inbound` never fires, so `getRestaurantIdByDialedNumber`
is never consulted on the Retell side and the venue must be hard-bound at the agent level. That
does not scale and is the opposite of the fail-closed routing the rest of the system relies on.

`NAMES.md` §6 is the SSOT for this; if this file and NAMES.md disagree, NAMES.md wins.

**Dynamic variables come from the LLM's `default_dynamic_variables`, not from our
`/retell/inbound` webhook.** That webhook only fires when the phone number is registered with a
webhook URL rather than a static `inbound_agent_id`. This trips people up when dates go stale:
the fix is `retellVariablesWorker` (a deliberate no-op unless both `RETELL_LLM_ID` and
`RETELL_API_KEY` are set), not the webhook.

Snapshot Retell config to `deploy/retell-snapshots/<timestamp>-<reason>/` before changing a live
agent, so there's a rollback path.

## Database side

Insert or update the `restaurants` row so the dialled number resolves:

- `twilio_phone_number` — E.164-normalised. This is the **trusted routing key**.
- `retell_agent_id`
- `name`, `timezone`, `onboarding_status`

Since 2 Aug 2026 both Retell and Twilio handlers resolve the restaurant from the **dialled
number** (`To`/`Called` → `getRestaurantIdByDialedNumber`) and **fail closed in production**.
Caller-supplied `restaurant_id` is deliberately ignored — that closes off a class of "AI talked
into booking at the wrong venue" attacks. So until the row exists, a production call correctly
goes nowhere. That's the system working, not a bug to route around.

`env.DEFAULT_RESTAURANT_ID` remains only a dev fallback and the Cal.com web-booking default.

## Verify before declaring it live

1. On staging, Twilio number Traffic Status shows **Voice enabled**.
2. Place a real call to the staging number and confirm the staging agent answers.
3. Check the call appears in staging `call_logs` with the expected `restaurant_id`.
4. Read back production configuration without mutation and monitor genuine calls after activation.

A staging test call is the only permitted check that exercises every hop. Never place a test call
or create a dummy restaurant row in production.

## Cutover caution

Adding a new number does not retire the old one. `+61 2 7501 1140` on the Algorythmos account
remains the live Bella number until someone deliberately moves traffic. Two numbers pointing at
the same agent is fine; assuming the new one has taken over is not.

---

## The two voice architectures (choose before you configure)

The backend supports two inbound paths and they are **mutually exclusive**. A number attached to a
SIP trunk ignores its voice webhook entirely — that is why `/twilio/voice` never fires on our
current numbers, and it is not a bug.

### A. SIP Trunk — what production and staging both use

```
Caller → Twilio number → Elastic SIP Trunk (AU1) → Retell → /retell/tools/*
```

Twilio never calls our backend on the signalling path.

- **Pro:** lowest latency; a backend outage does not drop calls.
- **Con:** no `call_logs` row at call start. The record arrives later from Retell's
  `call_analyzed` webhook via `persistRetellCall`.
- `TWILIO_VALIDATE_SIGNATURE` is irrelevant on this path — Twilio isn't calling us.

### B. TwiML webhook — `POST /twilio/voice`

```
Caller → Twilio number → /twilio/voice → TwiML <Dial><Sip> → Retell
```

`handleTwilioIncomingCall` (`services/twilioService.ts`):

1. Resolves the restaurant from the dialled number and writes a `call_logs` row with
   `status: "started"` immediately.
2. Returns TwiML dialling `env.TWILIO_RETELL_SIP_URI` with `answerOnBridge: true`, an `action` of
   `/twilio/status`, and status callbacks on `initiated|ringing|answered|completed`.
3. Sets `callerId` from `env.TWILIO_PHONE_NUMBER` when present.

- **Pro:** early call logging, full status callbacks, per-call TwiML control.
- **Con:** puts our API in the call path — if the API is down, callers get nothing.

**Important:** when the dialled number maps to no restaurant, the handler logs
`twilio_call_unmapped_number` and **still connects the call**. It deliberately does not fall back
to a default tenant — filing calls under the default tenant is what produced the cross-tenant leak.
An unmapped number degrades to a missing log entry rather than a wrong one. Do not "fix" this.

### C. Number router — `voice_url` → Twilio Function (staging's shared number)

```
Caller → Twilio number → Function /router (voxstay repo) → <Dial><Sip> sip:+E164@sip.retellai.com   (Retell)
                                                         → <Redirect> https://…/twiml                (a webhook agent)
                                     SIP leg fails/collapses → /sip-failed → <Dial> desk number
```

Used by **`+61 468 203 234` since 30 Aug 2026**, because one paid test number is shared between
VoxTable staging, the VoxStay hotel agent and other experiments. Which agent answers is a router
Variable, switched by hand — from this repo with `switch-line.mjs`, which drives voxstay's
`twilio-route.py`, sets the Retell inbound shape, reads back and re-asserts. The trunk layer is
absent; `assert-line` reads the number's `voice_url`, voice region and the live Variables instead
and prints `HOLDER: <profile>`. Not for production lines.

### Recommendation

Production: **A plus a Disaster Recovery URL** (see `trunk-hardening.md`). Shared test numbers: **C**. That keeps the fast, resilient
trunk path while giving callers something to hear when Retell is unreachable — most of B's benefit
without putting the API in the happy path.
