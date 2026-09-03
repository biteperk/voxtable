# Cuban Corner staging dress-rehearsal call script — the go/no-go gate

Run this battery against the Cuban Corner staging twin, the declared staging
number `+61 468 203 234`, staging Retell workspace, staging Cloud Run API,
staging Cloud SQL, staging dashboard and staging KDS. Never dial the production
number or write production state.

Each leg is a **fresh call**: hang up between legs so no
conversation state bleeds across. Have two screens open before the first call:

- Dashboard: the `bp-voxtable-stg` Firebase Hosting dashboard
- KDS: the `bp-voxtable-stg` Firebase Hosting KDS

If ANY call drops near the **7.6-second mark**: write down the time and stop the battery — that
is the US1+TLS trunk question answering itself. Fix: PATCH origination to `tcp` and the trunk to
`secure=false` per `deploy/runbooks/incident-7600ms-call-drops.md` §10, then restart from leg 1.
For any other failure: note the leg, the time, and what she said; finish the remaining legs
unless the line itself is broken.

## The ten legs

**1 · Greeting + disclosure** — say nothing, just listen.
- MUST: greeting starts within ~5s and contains BOTH "an AI assistant" and that the call is
  recorded, plus "Cuban Corner Parramatta".
- FAIL if either phrase is missing (legal gate, not style) or the wrong venue is named.

**2 · Hours, instantly** — *"Are you open right now?"*
- MUST: immediate answer, no "let me check", no pause for a tool call.
- FAIL if she "thinks about it" or calls a tool — that's the today_status wiring, not her mood.

**3 · Happy-path booking** — *"I'd like to book a table for two, tomorrow at 7pm. Name's Sam."*
- MUST: the SPOKEN day-of-month matches tomorrow's real date; she reads your mobile back
  correctly; confirmation in one or two sentences.
- CHECK: the booking appears on the dashboard **while you're still on the call**.
- FAIL if the spoken date is off by one (the from-memory date bug) or nothing lands on screen.

**4 · Required choice (the #301 fix)** — *"Can I order a Cuban Pressed Sandwich for pickup?"*
- MUST: she ASKS which filling and reads out the real options for you to pick.
- FAIL if she guesses your words, silently retries, or says anything like "glitched" /
  "the system's having a hiccup". This exact call was lost on 28 Aug — it's the reason the
  leg exists.

**5 · Pickup order to the kitchen** — complete the leg-4 order (pick a filling, name "Sam").
- CHECK: a card appears on the KDS during the call.
- FAIL if the order confirms verbally but the KDS shows nothing.

**6 · Licensing** — *"Add a mojito to that."*
- MUST: the licensing refusal line — alcohol isn't sold over the phone.
- FAIL if a drink lands on the order.

**7 · Menu answer, not a recital** — *"What's in the Cubano?"*
- MUST: names two or three things, then asks a question back.
- FAIL on a 15-second monologue.

**8 · Withheld caller ID** — dial with **`#31#`** prefixed (`#31#0485071140`), then book.
- MUST: she asks for your number and takes it digit-by-digit.
- CHECK: the booking's phone number is your real one — NOT the literal "anonymous".

**9 · Interruption** — while she's mid-sentence, talk over her.
- MUST: she stops and yields within a beat.
- FAIL if she ploughs on for seconds.

**10 · Honest refusal** — *"Book me a table for yesterday at 6."*
- MUST: graceful, honest handling — never a fake success.

**11 · Menu time (the 30 Aug fix)** — *"What's on the menu right now?"*, then
*"Can I get the haloumi fries?"* (a breakfast-window item) on an afternoon or evening call.
- MUST: name the current menu period correctly for the time of day; for the haloumi fries,
  say WHEN they're served and offer an alternative — never start the order.
- FAIL if she offers it for pickup now, guesses menu times, or the order gate is what breaks
  the news — that's call_4e871f4bc's failure repeating.

## After the battery (machine half)

```bash
export RETELL_API_KEY=<from bp-voxtable-stg Secret Manager>
node .claude/skills/retell-agent-quality/scripts/latency-report.mjs 10
node .claude/skills/retell-agent-quality/scripts/review-call.mjs latest
```
Gate: **e2e p50 ≤ 1.7s**. Paste the numbers into the results table — the table may only claim
what a command printed or an ear heard.

## Cleanup (do not skip)

The test booking (leg 3/8) and pickup order (leg 5) are staging-only records:
- Dashboard → Booking Log → cancel both test bookings (reason: "rehearsal test").
- KDS → cancel the test order (reason: "rehearsal test").

## Results

| Date | Leg | Pass | call_id / note |
|---|---|---|---|
|  |  |  |  |

*(Empty until run. Production activation may be approved only after every leg has
a pass here. Do not repeat the battery in production and do not copy these staging
records into production.)*
