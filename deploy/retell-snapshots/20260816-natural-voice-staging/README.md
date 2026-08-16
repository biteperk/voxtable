# 2026-08-16 — Natural-voice tuning, STAGING workspace only

Bella sounded robotic on staging calls. This change turns on every Retell naturalness
control we were leaving at default, restores two things the 13 Aug rebuild silently
dropped, and rewrites the prompt's style section into a proper persona. Applied to
**both staging pairs** via `PATCH /update-agent` + `PATCH /update-retell-llm`
(key: Secret Manager `voxtable-stg-retell-api-key`, project `bp-voxtable-stg`).

| Venue | Agent | LLM |
|---|---|---|
| Natalia's Bistro (STAGING) | `agent_b9087333b7030f0cee06a19ffc` | `llm_7c0a5c84498b81a5c723521038ef` |
| Cuban Corner Parramatta (STAGING) | `agent_a9c17694d805908f4b9a7bd4b9` | `llm_472328dafafd697a3c8e67230457` |

Nothing in the Biteperk (production) or legacy Algorythmos workspaces was touched.

## What changed — agent (exact payloads in `patch-agent-*.json`)

- `voice_model: eleven_multilingual_v2` — accent fidelity over minimum latency (drop to
  `eleven_flash_v2_5` if web-call latency feels laggy).
- `voice_temperature: 1.1`, `enable_dynamic_voice_speed: true`,
  `enable_dynamic_responsiveness: true` — livelier delivery, paced to the caller.
- `backchannel_frequency: 0.7` + `backchannel_words: ["mm","mm-hm","yeah","right","no worries"]`
  (backchannel was already enabled but on provider-default words).
- `reminder_trigger_ms: 18000` / `reminder_max_count: 1` — **restores the busy-fix
  regression**: these existed since `20260529-busy-fix` to stop "are you still there?"
  firing mid-tool-call, and the 13 Aug rebuild dropped them.
- `stt_mode: accurate` — ~200 ms slower ASR but better dates/times/party sizes.
- `boosted_keywords` — venue + core menu terms, per venue.
- `ambient_sound: coffee-shop` @ `ambient_sound_volume: 0.3` — **judged by ear; remove
  both fields if it sounds fake on the web-call test.**
- `begin_message_delay_ms: 500` — instant pickup reads as robotic.
- `fallback_voice_ids: ["cartesia-Maren"]` — TTS-outage cover from a second provider.
- `handbook_config`: `natural_filler_words`, `speech_normalization`, `smart_matching`,
  `ai_disclosure`, `scope_boundaries` all true. Deliberately NOT enabled:
  `conversational_personality` / `default_personality` (we carry a custom persona in the
  prompt — Retell says don't double up) and `echo_verification` (prompt already has
  explicit confirm-back steps).

## What changed — LLM

- `model_temperature: 0 → 0.2` (model stays `gpt-4.1`; one change-axis at a time).
- Prompt: `## Style` (5 thin bullets) replaced by `## Voice & personality` — warm
  easy-going Aussie persona, contractions, ≤2 sentences per turn, one question at a
  time, react-then-answer, varied confirmations, spoken-form dates/times (tools still
  get 24-hour values), one short aside while tools run, no "g'day" caricature.
- Prompt: added `## When a tool doesn't work — be honest, never fake it` **verbatim**
  from `20260529-busy-fix/llm.json`. Written after a real incident (every tool 401'd,
  Bella confirmed a phantom booking) and **never applied anywhere until now**. Only the
  prompt section was lifted — that snapshot's `begin_message` and dynamic variables are
  stale/pre-disclosure and must never be replayed.
- Dropped the hand-written "read prices naturally" rule — the `speech_normalization`
  handbook preset covers it.
- Untouched: `begin_message` (the AI + recording disclosure — byte-identical),
  `default_dynamic_variables: {}`, all 6 tools and their staging URLs, time anchor,
  alcohol section (Cuban), Aria edge case (Natalia).

Verified by diff: pre→post changes only the fields above (`*-pre.json` vs `*-post.json`).

## Open item — the voice itself is still American

`11labs-Anna` is catalogued by Retell as **accent: American**. The agent's `en-AU` is
the ASR language, not the voice. No Australian female exists in the standard catalog
(only Noah and Charlie, both male), so a real Aussie voice must be added from the
ElevenLabs community library — **dashboard-only**: voice selector → "Add custom voice",
search by name, preview by ear. Shortlist from `POST /search-community-voice`
(ElevenLabs `provider_voice_id` in parens):

1. **Rachel — Fun, Casual, Australian Woman** (`U9VgC8Xinl7nnNsyDd3J`) — "warm,
   conversational… 30s, natural Aussie accent, relaxed delivery". Closest to Bella.
2. **Australian female early 30s** (`jQQiXyFE3PBHLF8znAIb`) — "urban Sydney than ocker;
   warm, intelligent".
3. **Kylie — Warm & Friendly Australian Female** (`e1nbKcfTL4XYy71tZn9J`).
4. **Samantha — Aussie, Happy, Friendly** (`IdDgBtBBVTnSVb4wDvbT`).
5. **Sunny — Australian Female** (`VyyyOgRmsqOzaZXnKWnI`) — casual, confident.

After adding: set the new `voice_id` on both staging agents, keep
`fallback_voice_ids: ["cartesia-Maren"]` (custom voices REQUIRE a fallback), re-run the
web-call ear test. Custom voices don't get Expressive Mode (platform voices only).

## Test sequence (staging number +61 468 203 234, only after web test passes)

1. Dashboard **Playground** chat: booking, pre-order, date anchoring, and force a tool
   failure to hear the honesty section behave.
2. Dashboard **web call** (no phone needed): judge accent, fillers, backchannels,
   pacing, ambient volume. Iterate `voice_temperature` / `backchannel_frequency` /
   ambient here.
3. One **real call**: disclosure greeting intact, dynamic variables computed per call
   (not fallback), booking row lands in staging DB, no "are you still there?" during
   tool waits.

Note: staging serves the **unpublished draft (version 0)** via webhook mode — the 13 Aug
E2E call proved drafts answer, so there is no publish step here. Production cutover WILL
need a publish + number-binding check.

## Promotion (later, Biteperk workspace)

Repeat `patch-agent-*.json` and the LLM prompt/temperature changes against the Biteperk
pairs (`agent_5b5df167525452db98cda2112f`/`llm_18ad6f5adedc865b7ffd02a121e1`,
`agent_2892d65ceace4e68d8a3f3e80c`/`llm_53c6e9de9aac3b60270ffdd6bcba`) — but reconcile
against live first, take a fresh pre-snapshot, and swap the tool/webhook hostnames check:
the payloads here contain **no hostnames**, so they are safe to replay as-is. Add the
community voice to that workspace separately (voices don't cross workspaces).

## Rollback

`PATCH /update-agent` and `PATCH /update-retell-llm` with the matching fields from
`*-pre.json`. Fields that didn't exist before must be reset explicitly (they were
`null`): send `{"voice_model": null, "voice_temperature": null, …}` mirroring
`patch-agent-*.json` keys, and the LLM's old `general_prompt` + `model_temperature: null`.
