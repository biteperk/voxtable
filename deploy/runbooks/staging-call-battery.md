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
| Dial | **+61 468 203 234** (VoxTable Staging Venue — the dummy test restaurant) |
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
| 1 | **Happy-path booking.** "Table for 2 tomorrow at 7pm, name Sam." | Bella opens with the AI + recording disclosure; booking confirmed by voice; row appears on the dashboard live-feed **during** the call. |
| 2 | **Booking + pre-order.** Book, then "and we'll have a large Fish & Chips with a Coke." | Order confirmed with an order number; ticket on the KDS within one 2 s poll. |
| 3 | **Menu question.** "What mains do you have?" | Answer drawn from the seeded menu (Fish & Chips, Garden Salad — not an invented list). |
| 4 | **Refusals.** "Add a House Lager." Then (after 11:30) "and a Big Breakfast." | Lager refused with the licensing line; Big Breakfast refused as outside its window. |
| 5 | **Modify by voice, cancel by dashboard.** "Actually make it 8pm." Then hang up and cancel the booking from the dashboard. | Bella re-checks availability and confirms the new time (modify-booking tool); dashboard cancel succeeds. There is deliberately no voice-cancel tool. |
| 6 | **SMS infrastructure leg.** Via the throwaway job, insert one outbox row: `INSERT INTO notifications_outbox (channel, recipient, kind, body) VALUES ('sms', '+61…your mobile', 'staging_smoke', 'VoxTable staging SMS test');` | The worker delivers it from +61 468 203 234. Expect the handset to stamp it **Unverified** — the BitePerk sender ID is bound to the production Twilio account; record the stamping, don't fix it here. Requires `NOTIFICATIONS_ENABLED=true` + `NOTIFICATIONS_SMS_FROM=+61468203234` on the staging worker (Terraform) — if unset, the row stays pending: that's the finding, not a failure of this leg. |
| 7 | **Negatives.** Call once with caller ID withheld. (The unknown-number path is covered by the signed smoke posting an unbound `to_number` — do NOT unbind the live venue row to test it.) | Withheld caller ID still books (caller phone recorded as unknown); no crash. |

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
