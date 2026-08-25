# 2026-08-26 — staging: Retell-injected filler words OFF (stage 1 of 4)

Sam's e2e test call (25 Aug) heard "hmm"-style fillers. Three sources exist; this change
removes the biggest one and ONLY this one (one lever per change): the agent's
`handbook_config.natural_filler_words`, which tells Retell itself to sprinkle
"um / you know" into responses. It had been `true` since the 16 Aug naturalness pass.

Backchannel (`mm`/`mm-hm` while the caller talks) and the prompt's "Mm-hm" turn-openers
are deliberately untouched — they are stages 2 and 4, applied only if the next test call
still hears them.

## What changed

`PATCH /update-agent/agent_7b67073710604d306443cc569c`:

```json
"handbook_config": { "natural_filler_words": false }
```

(all other handbook keys re-sent unchanged: speech_normalization, ai_disclosure,
smart_matching, scope_boundaries all `true`).

The LLM object was not touched; the llm.json here is byte-identical to the pre snapshot.

## Read-back evidence (pasted, not summarised)

```
READ-BACK OK: handbook_config = {"speech_normalization": true, "scope_boundaries": true, "smart_matching": true, "natural_filler_words": false, "ai_disclosure": true}
invariants: voice_id=retell-Cimo voice_speed=1 backchannel=True/0.7 words=['mm', 'mm-hm', 'yeah', 'right', 'no worries'] stt=fast expressive=False interrupt=0.6 delay=500 retention=30
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED** (disclosure check skipped —
staging greeting deliberately carries none).

`assert-line.mjs +61468203234`: all checks passed (Twilio trunk leg skipped — no AU1
key in env; this change touches nothing on the Twilio side).

## Verification still owed

A real test call to +61 468 203 234 listening for mid-sentence "um/hmm" — gone or not.
If "mm/mm-hm" interjections remain, that is backchannel (stage 2), not this lever.

## Rollback

Re-apply `../20260826-fillers-off-pre/agent.json`'s `handbook_config` in one PATCH:

```json
"handbook_config": { "natural_filler_words": true, "speech_normalization": true, "ai_disclosure": true, "smart_matching": true, "scope_boundaries": true }
```
