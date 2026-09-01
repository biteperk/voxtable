# 2026-08-27 — staging: six defects fixed, each one graded

First change set in this repo's history verified by a **graded suite** rather than by a
single human phone call. `deploy/voice-tests/cases.json`, run with
`scripts/run-sim-tests.mjs`. Pre snapshot: `20260827-takeaway-tool-schema-pre/`.

**Suite: 4/10 → 9/10.** Every number below was printed by a run, not inferred.

## What was actually wrong

Only two of the six were prompt-wording problems. Four were **stale config contradicting
the prompt** — which is why a month of prompt edits could not fix them.

| # | Defect | Real cause | Fix |
|---|---|---|---|
| 1 | Takeaway created a phantom table reservation | `create_order`'s tool schema still had `reservation_id` **required** and no `pickup_name`. The backend dropped that requirement long ago (`retellService.ts` — takeaway is a first-class order type). The model had no legal way to place a pickup order. | Schema: `required: [call_id, items]`, added `pickup_name`/`pickup_time`. Prompt step 3 now calls `create_order` directly. |
| 2 | Reported "not showing as paid" seconds after sending the link | A close-out rule told it to check once more before hanging up, so the last thing a caller heard was always a negative — nobody pays in ten seconds. | Deleted the close-out rule; scoped the per-turn check so it cannot fire on the turn the link went out. |
| 3 | Booked a withheld caller ID without asking for a number | The rule was a conditional aside buried inside step 6, whose main clause was the `create_booking` arguments. Numbered steps get followed; asides inside them do not. | Promoted to its own step 5, before the confirmation. Backend now sends `caller_phone_known` so the prompt keys on a value that is always present. |
| 4 | Restated the whole booking after confirming it | The `create_booking` **tool description** said the result carries "a confirmation_message to read back to the caller" — directly contradicting prompt step 8's "no details repeated". A tool description next to the result beats a rule forty lines up. | Rewrote both tool descriptions. `create_order`'s still said "for an EXISTING booking… only AFTER create_booking", which was defect 1 alive in a second place. |
| 5 | Confirmed a menu item we do not stock ("truffle fries") | `speak_during_execution: true` on every tool made it speak **before** the result — "yep, I can help with that" to an order for a dish that does not exist. | Talk-While-Waiting off on every tool except `send_payment_link`. See below. |
| 6 | Recapped details twice before booking | Nothing said what to say when `check_availability` returned, so the generation `speak_after_execution` fires filled the gap with a recap. | Step 4 now says not to restate; step 1's date check narrowed to the date alone. |

## Talk-While-Waiting — the one worth reading

It is **off by default at Retell**. It was switched on for all eight tools on 19 Aug to cure
18 seconds of dead air — but `speak_after_execution: false` was the actual cause and was
fixed in the same change. The filler has been running ever since on tools that return in
under a tenth of a second.

Measured 27 Aug (Cloud Run, n=180): **p50 67 ms** across every tool endpoint. `menu_lookup`
71 ms, `create_order` 47 ms, `create_booking` 107 ms, `check_payment_status` 20 ms. Only
`send_payment_link` is a real wait — 718 ms p50, 1190 ms p90 (Stripe) — and keeps it.

What it was costing, verbatim from `call_cadfa10a862788ed5a4759659df`:

```
27.6-28.0s AGENT: Let me
28.0-33.6s AGENT: check what mushroom dishes we've got and the price for you.We've got a
                  Mushroom Ceviche for nineteen
```

That run-on is the "sounds robotic" Sam has been reporting. `assert-agent.mjs` used to
*require* the flag on every tool; it now requires it only where the measurement says there
is silence to cover, and says to re-measure before widening it.

## Read-back

```
create_order required: ["call_id","items"]      has pickup_name: true
create_booking description says "read back":    false
create_order description says "EXISTING booking": false
talk-while-waiting on: send_payment_link        (all others false)
speak_after_execution: true on all 8
ALL CHECKS PASSED — assert-agent.mjs, 21 assertions
```

## Honest limits

- **Prompt grew 246 chars** (15,334 → 15,580), against this skill's own rule that a real fix
  makes the prompt shorter. The two largest fixes were schema and config, not prose; the
  growth is steps 4 and 5 being made explicit. It is a debt, and the compression pass needs
  to be graded, not eyeballed.
- **`one-recap-not-five` is the one case not passing.** Its metric asked the grader to count
  full recaps, which flaked 2/3 on an unchanged config. The metric has been rewritten to
  grade the two objective halves — confirm before committing, never restate after — but
  **that rewrite is UNVERIFIED**: Retell's credit balance was exhausted mid-session
  (`402 Credit balance exhausted`) and no run has scored it. Top up, then run it.
- **The backend half of fix 3 is committed but NOT deployed.** `caller_phone_known` reaches
  real calls only after staging deploys; until then a real withheld call still behaves the
  old way. The simulation supplies the variable itself, which is why the case passes here.
- **Nothing here was heard.** No phone or web call has been placed against this config.
  Filler words, pacing and backchannel are invisible to a transcript-graded run — backchannel
  audio never appears as agent turns at all. Latency was not re-measured either; expect the
  Talk-While-Waiting change to help, but that is a prediction, not a result.

## Rollback

Re-apply `20260827-takeaway-tool-schema-pre/llm.json` with one PATCH to
`/update-retell-llm/llm_c1d40dbe180e737dd2ce1309ed3f` (`general_prompt` + `general_tools`).
