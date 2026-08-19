# Staging call battery — the human half of "staging passed end to end"

~15 minutes with a phone. Run only after the machine half is green:

```bash
PUBLIC_API_BASE_URL=https://voxtable-stg-api-naed3dbhna-ts.a.run.app \
SMOKE_RESTAURANT_ID=33333333-3333-4333-8333-333333333333 \
SMOKE_RETELL_SIGNING_KEY=$(gcloud secrets versions access latest --secret voxtable-stg-retell-api-key --project bp-voxtable-stg) \
TWILIO_AUTH_TOKEN=$(gcloud secrets versions access latest --secret voxtable-stg-twilio-auth-token --project bp-voxtable-stg) \
TWILIO_PHONE_NUMBER=+61468203234 RETELL_PHONE_NUMBER=+61468203234 \
SMOKE_FIREBASE_API_KEY=AIzaSyAKpQoXeQem7F2z-IdPI_v0J8FhlpetVwc \
SMOKE_FIREBASE_EMAIL=biteperk@gmail.com \
SMOKE_FIREBASE_PASSWORD=$(gcloud secrets versions access latest --secret voxtable-stg-smoke-user-password --project bp-voxtable-stg) \
npm run smoke:staging
```

First green machine run: **14 Aug 2026** (all six suites, both negative controls).

## Setup

| Thing | Value |
|---|---|
| Dial | **+61 468 203 234** (**Mazcina** — the real Darlinghurst venue, converted 19 Aug 2026; agent `agent_7b67073710604d306443cc569c`) |
| Dashboard | `https://bp-voxtable-stg.web.app` — sign in as `biteperk@gmail.com` (the ONLY email on staging's allowlist today; Google sign-in needs #111 done, password sign-in works now) |
| KDS | staging KDS once deployed (no pipeline yet — see the staging-venue runbook / issue tracker) |
| Log tail | `gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="voxtable-stg-api"' --project bp-voxtable-stg --freshness 10m --format='value(textPayload)'` — grep `retell_tool_call`, `create_booking`, `create_order` |
| Menu you're ordering from | Fish & Chips (variants + required drink) · Garden Salad · Big Breakfast (09:00–11:30 only) · Coke · House Lager (licensed) |

Every call must land in `call_logs` with `restaurant_id = 33333333-…` — that row is the
canonical proof of connectivity (NUMBERS.md). Check via the throwaway job
(`deploy/runbooks/staging-venue.md`) with:
`SELECT provider_call_id, created_at FROM call_logs WHERE restaurant_id='33333333-3333-4333-8333-333333333333' ORDER BY created_at DESC LIMIT 10;`

## The seven legs

| # | Say / do | Pass looks like |
|---|---|---|
| 1 | **Happy-path booking.** "Table for 2 tomorrow at 7pm, name Sam." | Bella **names this venue and no other** (see below); opens with the AI + recording disclosure; booking confirmed by voice; row appears on the dashboard live-feed **during** the call. |
| 2 | **Booking + pre-order.** Book, then "and we'll have a large Fish & Chips with a Coke." | Order confirmed with an order number; ticket on the KDS within one 2 s poll. |
| 3 | **Menu question.** "What mains do you have?" | Answer drawn from the seeded menu (Fish & Chips, Garden Salad — not an invented list). |
| 4 | **Refusals.** "Add a House Lager." Then (after 11:30) "and a Big Breakfast." | Lager refused with the licensing line; Big Breakfast refused as outside its window. |
| 5 | **Modify by voice, cancel by dashboard.** "Actually make it 8pm." Then hang up and cancel the booking from the dashboard. | Bella re-checks availability and confirms the new time (modify-booking tool); dashboard cancel succeeds. There is deliberately no voice-cancel tool. |
| 6 | **SMS infrastructure leg.** Via the throwaway job, insert one outbox row: `INSERT INTO notifications_outbox (channel, recipient, kind, body) VALUES ('sms', '+61…your mobile', 'staging_smoke', 'VoxTable staging SMS test');` | The worker delivers it from +61 468 203 234. ⚠️ **Corrected 18 Aug 2026 — do NOT expect an `Unverified` stamp.** This leg used to predict one. A real send proved otherwise: `BitePerk` is bound to the production Twilio account, and AU sender-selection quietly deprioritises the unregistered ID rather than emit something that would read `Unverified`, so the message simply **arrives from the number with no stamp and no error**. Record that it delivered; the absence of branding is the expected result here, not a fault. Requires `NOTIFICATIONS_ENABLED=true` plus a sender on the staging worker (Terraform) — if unset, the row stays pending: that's the finding, not a failure of this leg. **Prefer `NOTIFICATIONS_MESSAGING_SERVICE_SID=MG692c54a793f914c2e43c7d691f4cb41e` and leave `NOTIFICATIONS_SMS_FROM` unset**: that is the configuration production runs, so this leg exercises the real code path and the either-or boot gate rather than a staging-only variant. Run `npm run smoke:sms-sender` first to confirm the service belongs to the staging account before sending anything. |
| 7 | **Negatives.** Call once with caller ID withheld. (The unknown-number path is covered by the signed smoke posting an unbound `to_number` — do NOT unbind the live venue row to test it.) | Withheld caller ID still books (caller phone recorded as unknown); no crash. |


### The floor plan is real now

Ten tables, 36 seats: T1–T4 (1–2), T5–T8 (2–4), T9–T10 (4–6). The old S1–S4 fixture tables are
deactivated, not deleted, so historical bookings stay linked and stay inside the overlap guard.

**The ceiling is 6.** Party-size answers are finally real rather than invented — and legs 8
and 9 exist because that ceiling is the one thing about the new floor plan a caller can hit.

### The venue is becoming Mazcina

From 18 Aug 2026 this line answers as **Mazcina**, not "VoxTable Staging Venue", with a real
28-item menu — see [`mazcina-staging-conversion.md`](mazcina-staging-conversion.md). Two legs
change with it:

- **Leg 3 (menu question)** now runs against a real menu with six mains and five items whose
  names begin with "Mazcina". That is the first genuine test of both the menu readout and
  fuzzy name matching; note what she actually says.
- **Leg 4 (refusals)** is **pending the bar list**. Mazcina's menu PDF is food-only, so there
  is no licensed item to order yet — though the venue certainly serves alcohol (its reviews
  single out the pisco sour and the wine jugs), so this is a missing fixture, not a missing
  requirement. Both code paths now have automated cover instead
  (`npm run smoke:menu-guards`), so this leg is about the phrasing a caller hears, not about
  whether the guard works.
- **New leg 8 — a large party.** "Table for 8 on Friday." Mazcina's largest table seats **6**
  and nothing in the platform combines tables, so this cannot be booked. Bella must say the
  largest table seats 6 and offer a callback — she must **not** offer a different time, which
  could never help. Before this was fixed she blamed the clock and suggested nine alternative
  slots. The tool response now carries `reason: "party_too_large"`; if you hear a time
  suggestion, the prompt is ignoring it.
- **New leg 9 — a party that just fits.** "Table for 6." Must succeed, on T9 or T10. This is
  the control for leg 8: it proves the new floor plan is reachable rather than merely inserted,
  so a refusal in leg 8 means the ceiling, not a broken table set.
- **New leg 10 — a closed day.** Bella now has a distinct answer for this — "we're closed
  then, would another day suit?" rather than the old generic "no table near that time", which
  told a caller nothing they could act on. Mazcina is closed **Tuesday and Wednesday**. Ask for a
  Tuesday booking: Bella must decline and offer an open day, not book into a closed one.
  Nothing in the automated suite covers a fully-closed weekday, and the failure mode is a
  confirmed booking for a night nobody is there.
- **Last-slot behaviour.** Bookings run 90 minutes against a 21:30 close (Thu–Sat) and 21:00
  (Sun–Mon), so the last bookable start is 20:00 / 19:30. Ask for 9pm on a Sunday and expect
  an alternative, not a table.

Also judge the **voice** on every leg: whether the register changes mid-call, whether times
and prices are read naturally, and whether *Mazcina*, *Sopaipillas*, *Chorrillana* and
*Celestinos* are pronounced correctly.

### Leg 1 additionally checks WHICH venue answers

Write down the venue name Bella actually says, verbatim, in the results table.

This is not a formality. On 18 Aug 2026 this exact call was made and Bella answered as
**"Natalia's Bistro"** — a different venue. The dialled number had resolved correctly, the
webhook had returned the right venue name, timezone and dates, and the booking landed against
the right restaurant. Only the *voice* was wrong, because the venue row was bound to another
venue's Retell agent whose prompt hard-codes its own name.

Every other leg would have passed. The booking appears, the menu answers, the refusals fire —
all against the correct venue — while the caller is told they have reached somewhere else.
**If the spoken name is not this venue's, stop the battery and fix the binding**
(`deploy/runbooks/staging-venue.md`); the remaining legs prove nothing about a line that
misidentifies itself.

## Record the results here

| Date | Leg | Call id | Result | Notes |
|---|---|---|---|---|
| _yyyy-mm-dd_ | 1 | | | |

## After a full green run

1. Tick NUMBERS.md §8 item 2c (real staging call) and the staging half of item 8 (first SMS).
2. Close #128 and #165 with a link to this file's results table; update #113/#140.
3. Add the "staging passed end to end" entry to the dashboard journey
   (`scripts/dashboard-content.json`) and regenerate.
4. Staging is proven — the remaining go-live blockers are all production-side
   (#127 line restore, #129 prod Cloud Run, Stripe Tax config).
