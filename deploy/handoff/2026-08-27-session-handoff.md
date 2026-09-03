# Session handoff — 27 Aug 2026

Written to be pasted into, or pointed at from, a fresh chat. Everything here is either verified
today or explicitly flagged as unverified. Branch: **`pipeline-environment-checks`** (pushed).

**If the new chat is about the voice agent's responses, read §5 and §6 and skip the rest.**

---

## 1. What shipped today (8 commits, all pushed)

| Commit | What |
|---|---|
| `1d887ad` | Three safety rules added to the reliability skill (see §5) |
| `33904db` | Made the 7.6 s experiment safe to run; caught a rollback order that would break the line |
| `c624509` | **Verdict: transport is not the cause of the 7.6 s drops** |
| `3e0db9e` | Trunk transport + Secure flag now declared and asserted per line |
| `6d09871` | Scripted the US1 region test |
| `1dde1cc` | Per-region credentials; blocked a number move that would pass on a dead line |
| `7ad127b` | Recorded the new US1 trunk |
| `1a6784e` | Drafted the Twilio ticket |

---

## 2. The ~7.6 s call-drop incident — current state

**Canonical file: [`deploy/runbooks/incident-7600ms-call-drops.md`](../runbooks/incident-7600ms-call-drops.md).**

**Status: trunk confirmed as the layer. Transport EXONERATED. Region is the last variable, and it
is blocked.**

What was learned today:
- The staging trunk was changed to `transport=tcp` + Secure Trunking **off** on **20 Aug 05:34:29 UTC**
  by hand at the vendor, and **nothing recorded it**. Six days of call data had been read against
  the wrong assumed config.
- Splitting call records at that moment: **12/35 drops before (TLS), 3/19 after (TCP)**. Drops
  continue at 7,590–7,594 ms. The runbook's own rule was "any drop exonerates transport" → exonerated.
- The apparent improvement (34% → 16%) is **not** statistically distinguishable, Fisher exact
  **p = 0.21**. Do not record it as a partial win or ship TCP to production on it.
- 15 releases span **7,590–7,653 ms — a 63 ms spread**. Twilio's own API rounds every one to "8s".

**Twilio ticket #29205443** raised 27 Aug 16:05 — Elastic SIP Trunking, P2 Degraded, status New.
Filed under Biteperk-**production**'s ticket history (the account picker resets on every page load
and could not be made to stick), which is why both account SIDs are named in the body. A follow-up
comment with the millisecond table is posted. Draft text: [`../runbooks/twilio-ticket-7600ms-drops.md`](../runbooks/twilio-ticket-7600ms-drops.md).

**A US1 trunk now exists and is inert:** `TK97846b40ae334b32d64d98b627dea9e4`
(`voxtable-staging-us1`, Secure off, TCP origination). Nothing routes to it.

---

## 3. What is BLOCKED and needs a human in the Twilio console

1. **The number's voice region.** `+61468203234` reports a **different trunk binding per region** —
   via the US1 host `trunk_sid = null`, via the AU1 host the AU1 trunk. So attaching the US1 trunk
   **adds a parallel binding** rather than moving the line, and a move would read back cleanly while
   the line was dead. `trunk-region-experiment.mjs --move` refuses until someone establishes **where
   the voice/inbound region is set and whether changing it is reversible.**
2. **Production's trunk posture.** `origination_transport` and `trunk_secure` are declared `null` in
   `deploy/voice-lines.json` because production has no API credentials outside the console. Read both
   from the console and fill them in; `assert-line.mjs` then checks production properly. It will also
   reveal whether production got the same unrecorded 20 Aug downgrade.
3. **Do NOT restore staging to TLS yet.** Staging is AU1+TCP; the known-good trunk is US1+TCP, so
   region is currently the only difference. Restoring TLS first makes the region result unattributable.

---

## 4. Credential facts learned today (these cost real time)

- **The two Twilio credentials are complementary, not interchangeable.** The AU1 API key sees AU1
  trunks and **401s on US1**; the account auth token sees US1 and **401s on AU1**. A 401 rendered as
  an empty list reads as "the resource does not exist" — that bug was written and caught today.
- **AU1 resources answer only at `*.sydney.au1.twilio.com`.** `trunking.twilio.com` 404s on an AU1
  trunk and looks exactly like a deleted trunk.
- **Twilio's Calls API `To` field is a SIP URI** (`sip:+61…@sip.retellai.com;transport=tcp`), not
  E.164 — filtering by phone number returns zero calls and looks like an empty estate.
- **Secrets** (project `bp-voxtable-stg`): `voxtable-stg-twilio-account-sid`,
  `voxtable-stg-twilio-auth-token`, `voxtable-stg-twilio-au1-key-{sid,secret}`,
  `voxtable-stg-retell-api-key`. `gcloud` is authenticated as `biteperk@gmail.com`.
- ⚠️ The repo's local `.env` Retell key is the **legacy Algorythmos workspace**. Never use it for a
  BitePerk line. Scripts resolve credentials from `deploy/voice-lines.json` instead.
- Twilio's Developer support plan **blocks `/submit` directly** — you must go through the AI chatbot,
  which mints a one-time form link. Live chat and phone need a paid plan.

---

## 5. Voice-agent work — start here for the next chat

**Invoke the skill `retell-agent-quality` before touching any agent.** It carries the golden config,
the prompt contract, and the change discipline: **snapshot → PATCH → read back and assert → one test
call**. One lever per change.

The vendor-agnostic doctrine lives in the skill `restaurant-voice-agent-reliability`.

**Three rules added to it today** (commit `1d887ad`) — these are prompt-relevant and not yet
reflected in any agent prompt:
1. **Never state a fact before the tool that establishes it returns.** On a real call the agent said
   *"yes, tomorrow works"* **23 seconds before the availability check ran**. It was free, so the call
   sounded perfect. Detect by **transcript ordering, not outcome**.
2. **Never adjudicate safety.** Allergens/intolerances: record verbatim, flag for human review, say
   the kitchen will confirm. Never assure. Dietary tags make it look like a lookup; it is a claim
   about a kitchen.
3. **Never take card details by voice.** Interrupt anyone who starts reading a number, never repeat
   digits back, and scan transcripts for 13–19 digit runs — a hit is a payment-data incident because
   calls are recorded and transcribed.

**Open prompt defects from earlier call audits, not yet fixed:**
- The agent confirmed a side dish the kitchen does not have, echoing the caller's guess instead of
  reading the options from the tool result. Rule: required choices are read **verbatim from the tool
  result**; never confirm an option the tool has not listed.
- Takeaway confirmation SMS uses dine-in copy ("booking confirmed… party of 1") for a pickup order.
- Takeaway wrap-up does not mention the confirmation text; the dine-in path does.

**Evaluation evidence** for the reliability framework is in
`.claude/skills/restaurant-voice-agent-reliability/evals/` — `rubric.md`, `results.md`,
`portability.md`. Honest summary: the framework scored 20/20 vs 15.5/20 for a no-skill baseline, but
**the baseline matched it on pickup modelling**, and a portability dry-run against a second venue
found the intake template covers the conversation and **not the installation** (no fields for
telephony, call forwarding, competing booking channels, access, commercials or rollback).

---

## 6. Current staging line state (verified 27 Aug)

- Number `+61468203234`, agent `agent_7b67073710604d306443cc569c`, LLM `llm_c1d40dbe180e737dd2ce1309ed3f`,
  venue `33333333-3333-4333-8333-333333333333` (Mazcina Resto-Bar, staging).
- **`assert-line.mjs +61468203234` passes all 20 checks.** Configuration is proven; **function is not**
  — the line still drops roughly one call in six.
- Latest agent snapshots: `deploy/retell-snapshots/20260826-*` (fillers off, voice_speed 0.92,
  interruption 0.7, voice `11labs-Grace`, payment watch, takeaway flow).
- ⚠️ **Production is roughly three weeks behind staging** on the agent — none of the August tuning has
  been promoted.

Run the checks with:
```bash
export TWILIO_AU1_KEY_SID="$(gcloud secrets versions access latest --secret=voxtable-stg-twilio-au1-key-sid --project=bp-voxtable-stg)"
export TWILIO_AU1_KEY_SECRET="$(gcloud secrets versions access latest --secret=voxtable-stg-twilio-au1-key-secret --project=bp-voxtable-stg)"
export RETELL_API_KEY="$(gcloud secrets versions access latest --secret=voxtable-stg-retell-api-key --project=bp-voxtable-stg)"
node .claude/skills/retell-agent-quality/scripts/assert-line.mjs +61468203234
node .claude/skills/retell-agent-quality/scripts/latency-report.mjs 25
```

---

## 7. Other open items, unchanged today

- **Production Google sign-in is broken on all four hosts** — the OAuth register says done, but the
  entries are not on the client Firebase actually uses. Customers cannot sign in.
- **The staging call battery has an empty results table.** Ten legs, none run. "A real call has been
  answered end to end" is unproven by our own standard.
- Refunds are unimplemented (`reverse_transfer` absent) — no real card money until that or a written
  manual two-step exists.
- AU legal gate on voice-order payments (counsel) — weeks-long lead item.
