# Incident: calls dropping at a fixed ~7.6 seconds

**Status: OPEN — narrowed to the SIP trunk. One experiment away from a verdict. 20 Aug 2026.**

⚠️ **This file previously concluded the caller's handset/carrier was the prime suspect and
that "calling from a different phone is the decider". That conclusion was WRONG** and is
retracted below. The evidence that overturned it is in §2 and §3.

## 1. Symptom

Calls die at a machine-precise **7,593–7,653 ms** (one outlier 8,532 ms), on both AU1 mobile
numbers, across two separate Twilio accounts:

| Number | Trunk | Environment |
|---|---|---|
| `+61 468 203 234` | `voxtable-staging-au1` (`AC8116857da…`) | staging |
| `+61 468 202 846` | `voxtable-prod-au1` (`ACd423bd09…`) | production — **dropped its very first call**, 7,595 ms, 20 Aug |

Twilio records them as `completed`; Retell records `user_hangup` (i.e. it received a BYE).
Both vendors point at the other, which is itself the finding: the BYE originates upstream of
Retell.

## 2. It is a fixed timer, independent of the conversation

On **13 Aug** staging still ran the long 16-second disclosure greeting and dropped at
**7,611 ms** — mid-greeting, before the caller had spoken. On **19–20 Aug**, with a
4-second greeting and the caller mid-sentence, drops land at 7,593–7,653 ms.

Same instant, completely different call content. That eliminates the agent, the prompt, the
caller's behaviour, and any "she talked too long" theory — and no human hangs up inside a
60 ms band, eleven times.

## 3. It has been present since these trunks' first day

Staging, by day. **Trunk configuration unchanged since 13 Aug:**

| Day | Calls | 7.6 s drops |
|---|---|---|
| 13 Aug (first day of the number) | 5 | 1 |
| 16 Aug | 3 | 1 |
| 17 Aug | 3 | 0 |
| 19 Aug | 23 | 10 |

19 Aug only *looked* like an onset because 23 calls were made that day. The real rate is
roughly **a third of all calls, from the beginning**. Nothing "broke" on 19 Aug, and no
config change of ours caused it.

## 4. The trunk diff — every field

The one trunk that has never dropped a call is `algorythmos` (US1), which carried the pilot
line `+61 2 7501 1140`: **25 calls, zero drops**, durations 5 s–232 s.

| Field | WORKING `algorythmos` | BOTH BROKEN trunks |
|---|---|---|
| **origination transport** | **`tcp`** | **`tls`** |
| **region** | **US1** | **AU1** |
| `secure` | false | staging false until 13:49 on 19 Aug, then true |
| `domain_name` | `algorithmos.pstn.twilio.com` | null |
| `auth_type` | CREDENTIAL_LIST | none |
| cnam · symmetric_rtp · transfer · recording | — | identical |

**Ruled out from this table:** `secure` (staging dropped calls for six days while it was
false), and `domain_name`/`auth_type` (both termination-only, i.e. outbound — irrelevant to
an inbound call).

**Surviving candidates: transport (TLS vs TCP) and region (AU1 vs US1).** They are
confounded in the existing data.

⚠️ **Honest caveat on the pilot comparison:** the pilot line's most recent call was
**11 Aug**, two days before the staging number existed, so "different trunk" is partly
confounded with "different time period". What survives: its clean record spans three months,
and at the observed ~35 % failure rate, 25 consecutive clean calls has probability ~0.003 %.
A purely time-based cause would have had to begin in the 48 hours between 11 and 13 Aug.
Unlikely — but this is why the next step is an experiment, not an assumption.

## 5. Also ruled out (each verified, not assumed)

- Retell agent/prompt/config — failures bracket every change made on 19 Aug, and predate
  them all by six days.
- `ambient_sound` self-interruption — the original 13 Aug theory; ambient was removed on
  19 Aug and the drops continued unchanged.
- A bad Retell media node — `lk-real-ip` on dead calls (.120–.123) overlaps completely with
  healthy calls.
- Retell concurrency — 0 of 20 in use at a repro.
- Caller ID presentation — a withheld-ID call dropped at 7,593 ms (an earlier "CLIR is
  protective" clue was retracted the same hour).
- Twilio account health — both accounts active, funded, zero Monitor alerts.
- Cloud Run cold start / backend — the agent answers and greets on every dead call, and
  production (a different backend entirely, on the VM) drops identically.

## 6. The experiment — one variable, staging, reversible

Align staging's trunk with the only configuration that has never dropped a call:

```bash
# 1. Secure Trunking OFF first — it REQUIRES TLS and rejects non-encrypted calls,
#    so changing transport underneath it would break the line instead of testing it.
curl -u "$AU1_KEY_SID:$AU1_KEY_SECRET" -X POST \
  "https://trunking.sydney.au1.twilio.com/v1/Trunks/TKdebe2aa1a4287ca4b2f22da0e9d10ed7" \
  --data-urlencode "Secure=false"

# 2. Origination transport TLS -> TCP (everything else byte-identical)
curl -u "$AU1_KEY_SID:$AU1_KEY_SECRET" -X POST \
  "https://trunking.sydney.au1.twilio.com/v1/Trunks/TKdebe2aa1a4287ca4b2f22da0e9d10ed7/OriginationUrls/OU23100ba01330a692af3b64e244277847" \
  --data-urlencode "SipUrl=sip:sip.retellai.com;transport=tcp"
```

Keys: `voxtable-stg-twilio-au1-key-{sid,secret}` in Secret Manager, project
`bp-voxtable-stg`. ⚠️ Use the **AU1 host** — `trunking.twilio.com` 404s on AU1 trunks and
looks exactly like a deleted trunk.

Then place **6 calls** to `+61 468 203 234` and run
`.claude/skills/retell-agent-quality/scripts/latency-report.mjs 8`:

- **Zero drops in 6 calls** → transport confirmed (~93 % confidence at a 35 % failure rate).
  Repeat on `voxtable-prod-au1` (Twilio console — no BitePerk-production API credentials
  exist outside it).
- **Any 7.6 s drop** → transport exonerated; **AU1 is the remaining variable**, and a
  trunk's region cannot be changed after creation, so testing it means building a US1 trunk
  and re-attaching the number. Bring that back as its own decision.

Rollback: `Secure=true` and `transport=tls` — the values recorded in §4.

## 7. The trade-off

TCP sends SIP **signalling** unencrypted between Twilio and Retell; Secure Trunking off also
drops SRTP on the media leg. Weighed against: production has run exactly this posture for
months (the pilot line is `secure=false` + TCP), Retell is US-based so audio leaves Australia
either way, and the alternative is a restaurant line that drops a third of its calls. If the
experiment proves transport, the right end state is still TLS that works — so file the ticket
too.

## 8. Twilio ticket (needs a human on the console)

> Subject: Inbound trunk calls released at a fixed ~7.6 s on AU1 trunks (accounts
> AC8116857da2064ef3251533f3ade56f32 and ACd423bd09e9649e552a0b6d19a9eed338)
>
> Roughly a third of inbound calls to +61468203234 and +61468202846 are released
> 7,593–7,653 ms after setup, regardless of call content — we have drops mid-greeting and
> drops mid-caller-sentence at the same instant. Your Calls API records them `completed`;
> our SIP endpoint (Retell) receives a BYE. Present since each trunk's first day, on two
> separate accounts built to the same recipe (AU1, origination
> `sip:sip.retellai.com;transport=tls`). A US1 trunk with `transport=tcp` on a third account
> has 25 calls and zero such drops.
> Dead calls: CA0302138db8f3cfe3af2c0735a581f766 (20 Aug, prod),
> CA48c4ea0e17c20dbfc38f2830d19d5195, CA6c9f06c2efefa0b56965ddfd23db0904 (19 Aug, staging).
> Healthy control: CAa5e3f887956dbdf4bb930da16fdd5714.
> Please provide the Q.850 release cause and which side initiated BYE, and advise whether
> AU1 + TLS origination to an out-of-region SIP endpoint is expected to behave this way.

## 9. Related open gap

Neither AU1 trunk has a **Disaster Recovery URL**, so a Retell outage gives callers dead air.
Independent of this incident, still outstanding.
