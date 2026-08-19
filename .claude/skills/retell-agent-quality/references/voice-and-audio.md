# Voice and audio — selection, Expressive Mode, ear tests, incident catalog

## Choosing a voice

Three tiers on Retell, with different capabilities:

| Tier | Examples | Expressive Mode | How to set |
|---|---|---|---|
| **Retell platform voices** (`retell-*`) | `retell-Cimo` (current, American middle-aged) | ✅ supported | API or dashboard |
| Provider stock voices (`11labs-*`, `cartesia-*`, `minimax-*`) | `11labs-Anna` | varies | API or dashboard |
| **Custom / community voices** (`custom_voice_*`) | "Australian female early 30s" (ElevenLabs community) | ❌ **no Expressive Mode**; needs `fallback_voice_ids` | **dashboard only** to add; API can select once added |

Facts that keep getting re-litigated:
- **`11labs-Anna` is catalogued AMERICAN** — the agent's `en-AU`/`en-US` language field is
  the ASR language, not the accent. Retell's standard catalog has no Australian female voice.
- Retell's own TTS comparison ranks **ElevenLabs most natural, including for Australian
  English**; `eleven_v3` is the max-expressiveness model (`voice_model` field). Cartesia
  trades naturalness for spelling accuracy and latency.
- An AU community-voice shortlist (5 voices with ElevenLabs IDs, top pick "Rachel — Fun,
  Casual, Australian Woman") is in the `20260816-natural-voice-staging` snapshot README on
  `integration` history.
- The persona prompt must match the voice: the "unmistakably Australian voice" line was
  removed when Cimo (American) went in — claiming an accent the TTS doesn't have creates
  dissonance. Aussie *phrasing* stays regardless of accent.

**Ear tests decide.** Configuration cannot tell you a voice sounds human. Protocol (from the
conversion runbook): dashboard playground → web call → ONE real phone call to the staging
line, judged deliberately per call: warmth, pacing, whether interjections land, whether menu
words are pronounced right. The dashboard voice picker is the audition room — but remember
the draft hazard (SKILL.md doctrine #3): audition, then DISCARD the draft and set the choice
via API.

## Expressive Mode economics

`enable_expressive_mode: true` + `expressive_emotion_tags` (booking-line set:
empathetic, excited, happy, curious, surprised, pause, emphasis — deliberately no
sigh/throat-clear) + optional `expressive_mode_prompt`.

**Measured 19 Aug 2026: +1.0 s on every turn** (e2e p50 2,085 → 3,029 ms, uniform across a
5-turn call). Retell's community confirms it as a known latency cost with no mitigation
setting. The verdict that stuck: *a warmer voice that takes three seconds to answer feels
MORE robotic, not less.* Keep it off for phone service; one boolean re-enables it for demos
where wow beats snappiness. Custom voices can't use it at all.

## Audio incident catalog (what "bad audio" has actually been)

| Incident | Mechanism | Fix / rule |
|---|---|---|
| Greeting dies at ~7.6 s, "self-interruption" (11:36/11:44, 19 Aug) | **Initially blamed on `ambient_sound: coffee-shop` being transcribed as caller speech.** Partially true — ambient WAS being transcribed — but the 7.6 s deaths continued after removal and were the telephony drop (see call-forensics). | Two rules: no ambient_sound ever; and **check the duration signature before blaming audio** — identical `duration_ms` across failures is telephony. |
| Agent's own greeting appears in the USER transcript ("Thanks for calling." as user speech) | Speakerphone echo on the caller's side leaking TTS back through the mic | Recognise it in transcripts (user "says" agent words at t≈0); `denoising_mode: noise-and-background-speech-cancellation` mitigates; don't tune interruption_sensitivity down because of it. |
| Talks over the caller ~9 s | `interruption_sensitivity 0.4` (set as belt-and-braces for the ambient bug that removal had already fixed) | 0.6. Lower only for OBSERVED self-interruption with ambient ruled out. |
| Robotic-instant answers | `begin_message_delay_ms 0` feels like a machine pouncing | 500 ms. |
| Menu words garbled | STT without vocabulary | `boosted_keywords` = venue name + real dishes; if `stt_mode: fast` starts garbling names, that's the documented revert trigger back to `accurate` (costs ~600 ms/turn). |

## Pronunciation

`pronunciation_dictionary` (agent field) for venue names the TTS mangles — e.g. "Mazcina"
(entry still pending Camilo's confirmation of the venue's own pronunciation). One entry per
venue name at build time; menu dishes usually self-correct via boosted keywords + context.
