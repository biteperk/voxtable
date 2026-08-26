# 2026-08-26 — staging: interruption_sensitivity 0.8 → 0.7 (latency lever, one change)

Three test calls tonight all measured **e2e p50 ~2.5 s** (2473 / 2525 / 2617 ms), against
**1109–1424 ms** earlier the same day. The 1.7 s gate is comfortably breached.

TTS is not the cause (p50 ~180 ms) and the LLM is not obviously the cause (p50 564–940 ms).
That leaves roughly 1.4 s in endpointing — deciding the caller has finished — which is what
`interruption_sensitivity` influences. It was raised 0.6 → 0.8 earlier today, and the
regression appeared in the same window.

Confounded with two other changes from the same window, which is why this is a single lever:
- the voice moved from `retell-Willa` (platform) to `11labs-Grace` (ElevenLabs)
- the prompt grew to 14,125 chars, against the skill's ~10k guidance

0.7 keeps most of what 0.8 bought — she stopped talking over a caller repeating "fish and
chips" — while testing whether the endpointing cost is real. If p50 does not move, the lever
is wrong and the voice provider is the next suspect, then prompt length.

## What changed

`PATCH /update-agent/agent_7b67073710604d306443cc569c`: `{"interruption_sensitivity": 0.7}`.
Nothing else touched.

## Read-back evidence (pasted, not summarised)

```
READ-BACK: interruption_sensitivity = 0.7
unchanged: voice 11labs-Grace | speed 0.92 | stt fast | reminder 10000 x 2 | fillers False
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

`assert-agent.mjs` now checks a **band** (0.6–0.8) rather than a point. A point check fails
whichever agent is not today's guess — production sits at 0.6 unpromoted, staging is being
tuned — and a check that is red for a reason nobody intends is one people learn to ignore.
Pin a single value again when the tuning settles.

## Verification still owed

One call, then `latency-report.mjs`. Success is e2e p50 back under 1.7 s **without** her
talking over the caller. If p50 stays ~2.5 s, revert this and try the voice next.

## Rollback

`PATCH` with `{"interruption_sensitivity": 0.8}` — the value in `../20260826-interruption-07-pre/agent.json`.
