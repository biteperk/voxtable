# 2026-08-26 — staging: drop "mm"/"mm-hm" from backchannel words (stage 2, revived)

On the 10:01 test call (`call_7bfba3cf0d6d122973496db9cac`) the caller asked, verbatim:
"m m? Why are you saying m m?" — direct evidence the backchannel "mm" interjections are
audible and read as weird. The earlier verdict that backchannel was not implicated was
wrong: backchannel audio never appears as agent turns in transcripts, which is why the
08:42 review missed it. The caller's ear caught what the transcript could not.

## What changed

`PATCH /update-agent/agent_7b67073710604d306443cc569c`:

```json
"backchannel_words": ["yeah", "right", "no worries"]
```

(was `["mm","mm-hm","yeah","right","no worries"]`). `enable_backchannel` stays `true`
and frequency stays 0.7 — backchannel itself is the free-warmth lever and
`assert-agent.mjs` requires it on; only the two humming words are gone.

## Read-back evidence (pasted, not summarised)

```
READ-BACK OK: backchannel_words = ['yeah', 'right', 'no worries']
invariants: backchannel on/0.7, voice_speed 0.92 , fillers False , stt fast , interrupt 0.6
```

`ALLOW_NO_DISCLOSURE=1 assert-agent.mjs`: **ALL CHECKS PASSED**.

## Verification still owed

Next call: no audible "mm/mm-hm" while the caller is speaking. The prompt's "Mm-hm"
turn-openers are a separate source and go in the stage-4 prompt wave.

Also watching: the 10:01 call read e2e p50 1893ms (above the 1.7s gate) on n=6 with
heavy interruptions — treat as noise unless the next clean call confirms it.

## Rollback

Re-apply `../20260826-backchannel-words-pre/agent.json`'s `backchannel_words` in one PATCH.
