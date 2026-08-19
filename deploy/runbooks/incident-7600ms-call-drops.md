# Incident: staging calls dropping at ~7.6 seconds — evidence log

**Status: OPEN, cause narrowed to the caller/carrier side of Twilio. 19 Aug 2026.**

## Symptom

Calls to the staging line `+61 468 203 234` intermittently die at a machine-precise
**7,594–7,648 ms** media duration (one outlier at 8,532 ms), mid-caller-sentence. The agent
answers and greets normally first. Roughly half of the day's calls were affected; the other
half ran 37–166 s without issue, interleaved:

| Time (AEST) | Result | Duration |
|---|---|---|
| 11:36, 11:44 | DEAD | 7.6 s |
| 12:18 | alive | 59 s |
| 12:53 | DEAD | 7.6 s |
| 12:59–13:09 (4 calls) | alive | 37–70 s |
| 13:34 | DEAD | 8.5 s |
| 13:40 | alive | 71 s |
| 14:32 | DEAD | 7.6 s |
| 14:45 | alive | 166 s |
| 15:04, 15:05 | DEAD | 7.6 s |

⚠️ **The morning "greeting died at ~7.6 s twice" incident (11:36, 11:44) was this same
fault.** It was attributed to `ambient_sound` transcription/self-interruption at the time;
ambient sound was removed at ~12:10 and the 7.6 s deaths continued (12:53, 13:34, 14:32,
15:04, 15:05). The ambient-sound removal stands on its own merits, but it was not the fix
for this.

## What each side reports

- **Twilio (AU1 regional API — `api.sydney.au1.twilio.com`; the US1 API shows trunking
  calls not at all)**: `status: completed`, 8 s, direction `trunking-originating`. A clean,
  normally-terminated call. No debugger alerts, no notifications on the call.
- **Retell**: `disconnection_reason: user_hangup` — it received a BYE. Its per-call debug
  log shows a healthy setup (inbound webhook resolved Mazcina, variables injected) and then
  just "Ending call" with no error.

Both ends say the other side ended it → the BYE originated **upstream of Twilio**, on the
PSTN/caller side.

## Repro under live watch, 15:29 AEST

With a full pre-call audit green minutes earlier (account active/funded, zero alerts, trunk
healthy in AU1, Retell webhook mode resolving in 454 ms, agent config verified), Sam's 15:29
call died at **7,600 ms**, `user_hangup`, same handset. Eight dead calls now sit in a 54 ms
duration window (7,594–7,648 ms). Retell workspace concurrency was 0-of-20 at the time —
no phantom calls holding slots.

## Ruled out (each verified, not assumed)

- **Twilio trunk config** — `TKdebe2aa1…` is healthy *in the AU1 API view*: origination
  `sip:sip.retellai.com;transport=tls` enabled, number attached, transfer disabled, CNAM
  off. (⚠️ Query AU1 via `trunking.sydney.au1.twilio.com` with the AU1 API key from Secret
  Manager — the US1 endpoints 404 on AU1 trunks, which mid-investigation looked exactly
  like a deleted trunk.)
- **Secure Trunking toggle** — flipped false→true at 13:49:06 AEST (audit event; the AU1
  API key SK6c56b892… was minted 13:47 and stored in Secret Manager 13:49:27 — automation
  fingerprint, matches the cold-start background task's window and the provisioning
  skill's hardening step). Not the cause: failures predate it (11:36) and the longest
  success (14:45, 166 s) postdates it.
- **Retell agent/config changes** — failures bracket every config change made today
  (hours FAQ, prompt rewrite, greeting, expressive mode on AND off).
- **A bad Retell media node** — `lk-real-ip` on dead calls (.121/.122/.123) overlaps
  completely with alive calls.
- **Cloud Run cold start** — the agent answered and greeted on every dead call; the
  inbound webhook completed in ~350 ms on the 15:05 dead call.
- **Twilio account health** — active, $11.55 balance, no alerts.
- **Retell concurrency** — 0 of 20 in use at repro time; no stuck ongoing calls.
- **Retell number binding** — webhook mode (`inbound_webhook_url` → staging API), no static
  `inbound_agent_id`; resolution round-trip 454 ms at repro time.

## What's left (in probability order)

1. **The caller's handset/carrier path.** Every observed call today — dead and alive — is
   from the same handset (+61 450 011 1xx). A VoLTE/WiFi-calling handover or carrier
   answer-supervision fault can produce fixed-timer teardowns that Twilio sees as a normal
   remote BYE.
2. **Twilio AU1 ↔ carrier interop** — invisible to us; only Twilio can pull the SIP/Q.850
   release cause for the dead legs.

## Next actions

1. **Discriminating test (decides between 1 and 2, five minutes):** call the staging line
   several times from a *different* phone on a different carrier. Also worth one test from
   the usual handset with WiFi calling disabled.
   - Other phone never drops → handset/carrier path; production exposure low.
   - Other phone also drops at ~7.6 s → Twilio interop; production (+61 468 202 846, same
     AU1-trunk shape) IS exposed; escalate the ticket below immediately.
2. **Twilio support ticket** (draft below) — they can read the Q.850 release cause on the
   dead legs regardless of which way the test goes.
3. Regardless of this incident: the trunk still has **no Disaster Recovery URL** (known
   outstanding gap — callers get dead air if Retell is unreachable).

## Draft Twilio ticket

> Subject: Inbound trunking calls to +61468203234 intermittently released at ~7.6 s
> (account AC8116857da2064ef3251533f3ade56f32, AU1 trunk TKdebe2aa1a4287ca4b2f22da0e9d10ed7)
>
> Roughly half of inbound calls to +61468203234 are being released ~7.6 s after setup while
> the caller is mid-sentence. Your Calls API records them as `completed` (8 s); our SIP
> endpoint (Retell) receives a BYE. Interleaved calls from the same caller minutes apart
> run for minutes without issue, so our origination endpoint is reachable and answering.
> Example dead call SIDs (19 Aug 2026, AEST): CA48c4ea0e17c20dbfc38f2830d19d5195 (15:05),
> CA6c9f06c2efefa0b56965ddfd23db0904 (15:04), CAf47e12f94dcbcc2e937d867f14fd1c4e (14:32).
> Example healthy call for comparison: CAa5e3f887956dbdf4bb930da16fdd5714 (14:45, 168 s).
> Please pull the SIP traces / Q.850 release cause for the dead legs and advise which side
> initiated the release and why.
