# Call forensics — reviewing calls and diagnosing failures across both vendors

## Reading a Retell call (`GET /v2/get-call/{id}` — `review-call.mjs` prints all of this)

| Field | What it actually means |
|---|---|
| `duration_ms` | Media duration. **Identical values across failures (±60 ms) = a machine timer, not humans** — the single most diagnostic number on a bad day. |
| `disconnection_reason: user_hangup` | Retell RECEIVED a BYE from the telephony side. **Not proof the human hung up** — a carrier or Twilio teardown looks identical. |
| `disconnection_reason: agent_hangup` | The agent called `end_call` — the CORRECT ending. A day of `agent_hangup` endings is health, not a problem. |
| `latency.{e2e,llm,tts}.p50/p90/max` | Per-call response-time percentiles. e2e = caller stops → agent audio starts. |
| `transcript_with_tool_calls` | Utterances with word-level timestamps + tool invocations/results. Gap analysis: user's last word `end` → agent's first word `start` = the silence the caller sat through. A tool result followed by NO agent utterance = the dead-air bug. |
| `retell_llm_dynamic_variables` | What the inbound webhook ACTUALLY injected on this call — the ground truth for "did she know X". Also carries SIP headers: `lk-real-ip` (Retell media node — cluster dead calls by it to test bad-node theories), `twilio-callsid`, `twilio-accountsid`, `p-asserted-identity`, `diversion`. |
| `public_log_url` | Retell's per-call debug log (fetchable, no auth): webhook request/response bodies, "Starting call", "Ending call". Shows setup problems; does NOT say who sent the BYE. |
| `telephony_identifier.twilio_call_sid` | The bridge to Twilio's view. |

## The two-sided verdict method

For any dropped/failed call, get BOTH views before concluding anything:

1. **Retell view**: the fields above.
2. **Twilio view**: the call record — `status: completed` means Twilio saw a normal
   termination (someone sent BYE); `failed`/`busy`/error codes mean Twilio itself objected.
   Plus Monitor alerts (`https://monitor.twilio.com/v1/Alerts`) — signature failures, TLS,
   webhook errors land there.

Verdict table:
- Retell `user_hangup` + Twilio `completed` + caller says they didn't hang up → **the BYE
  originated upstream of Twilio** (carrier/handset side). Both vendors blaming "the other
  side" is itself the finding.
- Retell error / Twilio `failed` → the SIP/trunk leg; go to the sibling skill.
- Retell `agent_hangup` unexpectedly early → the prompt's end_call discipline misfired; read
  the transcript.

## ⚠️ THE US1/AU1 TRAP (cost an hour and a false "trunk deleted" alarm)

**AU1-region resources are invisible to the default (US1) API hosts.** Queries return empty
lists and 404s that look exactly like deleted resources.

| Resource | WRONG host (US1 — 404/empty) | RIGHT host |
|---|---|---|
| AU1 trunks | `trunking.twilio.com` | `trunking.sydney.au1.twilio.com` |
| Trunking call records | `api.twilio.com` (also: trunk calls never appear in US1 Programmable Voice logs at all) | `api.sydney.au1.twilio.com/2010-04-01/...` |

**Auth**: the account auth token works only on US1 hosts. AU1 hosts need the **regional API
key pair** — staging: Secret Manager `voxtable-stg-twilio-au1-key-sid` / `-key-secret`
(project `bp-voxtable-stg`), used as basic-auth user:pass. Monitor (alerts/events) is global
and takes the auth token.

## The audit trail (who changed what)

`GET https://monitor.twilio.com/v1/Events?PageSize=30` (optionally `ResourceSid=`) — each
event's `event_data` carries a before/after diff (e.g.
`{"secure_trunk":{"previous":"false","updated":"true"}}`). Actor `user US…` = a console
human; actor `account AC…` = an API integration. This is how the 19 Aug secure-trunking flip
was attributed to automation in two minutes.

## The fixed-duration drop signature (open incident)

Recognition: multiple calls dying at near-identical `duration_ms` (19 Aug: eleven calls in a
7,593–7,653 ms band), `user_hangup`, Twilio `completed`, mid-caller-sentence, intermittent
(~50%), config-independent. Full evidence chain, ruled-out list, decision table and the
ready-to-send Twilio ticket: `deploy/runbooks/incident-7600ms-call-drops.md`.

Rules it burned into this skill:
- **Check the duration signature BEFORE blaming the agent** — this fault was misdiagnosed as
  ambient-sound self-interruption for half a day because the greeting "died at 7.6 s".
- One surviving call proves nothing at ~50% intermittency (the CLIR "clue" was retracted the
  same hour a withheld-ID call died on schedule).
- Discriminating tests run only on the staging line, cheapest first: calls from a DIFFERENT handset/carrier; the
  **synthetic self-call** (Twilio REST outbound, `From`=`To`=the DID, TwiML `<Pause>` — a
  Twilio-originated caller on a completely different ingress path); then the Twilio ticket —
  only Twilio can read the SIP/Q.850 release cause on the dead legs.
- Secure Trunking ON removes SIP from Twilio's PCAP call-log captures; the documented
  debugging move is a temporary disable during a repro window, then re-enable (single field).

## Continuous watching

`list-calls` with a timestamp watermark, polled every 30–45 s, catches every staging test call the
moment it ends. Production call review is monitoring of genuine customer traffic only. For anything longer than a test
session, wire the `call_analyzed` webhook data already in `call_logs` instead of polling.
