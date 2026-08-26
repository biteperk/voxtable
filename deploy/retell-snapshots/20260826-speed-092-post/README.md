# 2026-08-26 — staging: voice_speed 1 → 0.92 (stage 3 of the tuning ladder)

Sam's e2e feedback: Bella talks a bit fast. One lever, one change: `voice_speed: 0.92`
(API range 0.5–2; a deliberately small step — the Expressive Mode lesson is that slow
reads as MORE robotic, so we nudge rather than jump). `enable_dynamic_voice_speed`
stays `true`; disabling it is the follow-up lever only if pacing still varies oddly.

Stage 1 (fillers off, `20260826-fillers-off-post`) was verified effective on the 08:42
test call — no injected "um/you know". The two remaining "Mm" occurrences on that call
were the PROMPT's turn-openers, so the original stage 2 (backchannel narrowing) is
dropped; the opener swap rides the stage-4 prompt wave instead.

## What changed

`PATCH /update-agent/agent_7b67073710604d306443cc569c`: `{"voice_speed": 0.92}`.
LLM untouched; llm.json here is byte-identical to the pre snapshot.

## Read-back evidence (pasted, not summarised)

```
READ-BACK OK: voice_speed = 0.92
invariants: dyn_speed=True temp=1.1 backchannel=True/0.7 stt=fast expressive=False interrupt=0.6 delay=500 retention=30 fillers=False
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

## Verification still owed

Ear test on the next call: pace natural, not drowsy. `latency-report.mjs` e2e p50 must
not regress vs the 1252ms baseline (speech rate is not response latency).

## Rollback

`PATCH /update-agent/agent_7b67073710604d306443cc569c` with `{"voice_speed": 1}`
(the value in `../20260826-speed-092-pre/agent.json`).
