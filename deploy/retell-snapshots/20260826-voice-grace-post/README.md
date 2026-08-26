# 2026-08-26 — staging: voice changed to Grace in the dashboard (recorded, not applied by us)

Sam auditioned voices in the Retell dashboard and settled on **`11labs-Grace`**, replacing the
`retell-Willa` this repo applied earlier today. This snapshot exists so the committed state
matches the live agent — the skill's rule is that a declaration is updated in the same change as
the vendor mutation, and a snapshot nobody took is drift waiting to be discovered.

## What the dashboard edit actually did — and did not do

The concern with a dashboard draft is that publishing a **stale** one erases API-applied fixes.
Verified against the live record immediately afterwards, that did not happen here: the draft was
created after the day's API work, so it carried it forward.

```
prompt chars = 14125          (exactly what was applied)
tools        = 8 -> …, send_payment_link, check_payment_status
payment-watch rules present: True
interruption 0.8 | reminder 10000 x 2 | speed 0.92 | fillers False
voice_id     = 11labs-Grace   ← the only field that moved
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

## About the voice, recorded once so it is not re-litigated

`11labs-Grace` is **American**. Retell's catalogue has exactly two Australian voices and both are
male, so no Australian female voice exists to choose — `retell-Willa` (British) was picked here
as the nearest thing for an Australian venue. Grace is Sam's ear-tested preference and his call;
voice selection is explicitly a taste decision in this skill, not a machine-checkable one.

Two trade-offs worth knowing, neither disqualifying:
- ElevenLabs voices are a different provider from the `retell-*` platform voices, so they do not
  get multi-provider fallback if that vendor has an incident.
- Expressive Mode is a platform-voice feature. It is deliberately off (it cost ~1 s per turn), so
  this changes nothing today, but it would need a platform voice to revisit.

## Production is NOT this

Production (`agent_b6b6488af08b82d80e8f4d270a`) still runs the pre-promotion agent: six tools, no
payment capability, the old prompt, fillers on, `mm`/`mm-hm` backchannel, reminder 18 s × 1.
Its live `voice_id` now also reads `11labs-Grace` where the 24 Aug snapshot has `retell-Cimo` —
recorded here as an observation to reconcile, not a change made by this repo.

`assert-agent.mjs` was widened to accept `interruption_sensitivity` of **0.6 or 0.8** so the
hourly line check does not fail production simply for being unpromoted. Tighten it to 0.8 alone
on promotion day — a permanently red check is one people stop reading.

## Rollback

`PATCH /update-agent/agent_7b67073710604d306443cc569c` with `{"voice_id":"retell-Willa"}`.
Alternatives with previews are in `../20260826-voice-and-listening-post/README.md`.
