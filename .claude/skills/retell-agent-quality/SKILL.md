---
name: retell-agent-quality
description: Building, tuning, verifying and diagnosing VoxTable's Retell voice agents — the agent half of the telephony stack (numbers/trunks/SIP are the sibling skill twilio-au-number-provisioning). Use whenever someone is building or cloning a venue agent, polishing or editing a prompt or greeting, choosing or switching a voice, asking about Expressive Mode, complaining the agent "sounds robotic", "takes time to respond", talks over callers, monologues, doesn't know the opening hours or "thinks about" whether the venue is open, gives dead air after checking something, names the wrong venue or owner, speaks a wrong date, mishandles a withheld caller ID, or when a call needs reviewing ("analyse this call", "why did it hang up", "she was confused"), latency needs measuring or cutting, an agent is being promoted from Staging to the Biteperk (production) workspace, or Retell/Twilio call APIs need querying. Also whenever a Retell dashboard draft exists, before ANY dashboard publish — a published draft can erase API-applied fixes. Even for one small prompt edit: the change discipline here (snapshot, PATCH, read-back, staging test call) is the point.
---

# Retell agent quality — build, tune, verify, diagnose

Everything here was learned on real calls, mostly on 19 Aug 2026, and each rule cites the
incident that created it. The agents are the heart of the product: a venue's entire
experience of VoxTable is whether Bella sounds human, knows the venue, and never lies.

**The doctrine, before anything else:**

1. **Build from the live golden snapshot, never from scratch or memory.** A rebuild from a
   committed snapshot once silently stripped the AI-disclosure greeting and the 30-day
   retention setting — the live config is the truth, and the latest
   `deploy/retell-snapshots/*/` pre/post pair is its committed mirror.
2. **Every change goes through the API**: fresh pre-snapshot → PATCH → **read the config back
   and assert it** (never trust the write response) → post-snapshot with README → commit.
   Rollback is always "re-apply the pre snapshot", one PATCH per object.
2b. **If the field is DECLARED, edit the declaration instead — do not hand-PATCH it.** Since
   7 Sep 2026 `deploy/voice-lines.json` declares the greeting (`begin_message`), the agent
   webhook and tool hosts (`api_base`), the agent name, boosted keywords and pronunciation, and
   `deploy-backend.yml` runs `apply-line --apply` → `assert-line` after every healthy deploy. A
   hand PATCH of a declared field is reverted by the next deploy, silently. Change it by PR to
   `integration` (staging applies itself), then promote to `main` (production applies itself) —
   **CLAUDE.md §0**. Rule 2 still governs the prompt body and anything else not yet declared.
3. **The staging dashboard is for ear-tests and voice auditions ONLY.** Dashboard edits create drafts;
   **publishing a stale draft erases every API-applied fix since the draft was opened** —
   this nearly reverted a full day of fixes twice on 19 Aug. If a draft exists, discard it.
4. **One lever per change**, so the next staging test call attributes cleanly. **Never claim a win
   without a measured staging call** — config that "should" be faster or more natural counts for
   nothing until `latency-report.mjs` and an ear say so. Never test changes on production.
5. **A document may only claim what a read-back printed.** On 20 Aug 2026 a snapshot README
   recorded a rename + pronunciation fix as applied to *both* Mazcina agents. It had reached
   staging only; production sat untouched for a day while the file said otherwise — and the
   snapshot committed in the same session proved it, unread. Paste the assertion output; do
   not summarise it from intent.
6. **The line is four bindings, not one.** Twilio trunk → Retell number import → Retell agent
   → the `restaurants` row. A perfect agent answers nothing if any other link is wrong, and
   three of the four were broken at once on production on 20 Aug. Declared state lives in
   [`deploy/voice-lines.json`](../../../deploy/voice-lines.json); **run
   `npm run check:voice-lines` before and after any routing change**. Production bindings are
   changed through the Cloud Run admin API; never use sandbox SQL as a production path.
7. **A number lives in exactly one Retell workspace, account-wide.** Importing it elsewhere
   silently evicts it from yours, and the symptom is a number that 404s locally while the
   import API says it already exists.
8. **Check WHICH WORKSPACE your key opens before believing anything it tells you.** The repo's
   local `.env` may hold a sandbox or legacy key; production's lives in `bp-voxtable-prod`
   Secret Manager. A wrong key never errors — it returns clean 404s, so a healthy line
   reads as broken and the "repair" breaks it for real. That is exactly what happened on
   20 Aug 2026: a two-hour production outage caused by a diagnosis, not a fault. Never pass a
   key by hand; `assert-line.mjs`/`apply-line.mjs` load `retell_credentials` from
   `deploy/voice-lines.json` and refuse a key that cannot see the declared agent.
9. **If two things appear missing at once, suspect the credentials.** A number and its agent do
   not usually vanish together. And a *false verification* is worse than no check: an unverified
   claim invites doubt, while one "confirmed" against the wrong estate ends the conversation.

> 🧊 **PROMPT FREEZE — in force from 27 Aug 2026. Read before editing any prompt.**
>
> The staging prompt is frozen until the simulation-test suite exists (plan Phase 1). This is
> not caution; it is the finding of an audit of every change made since 13 Aug:
>
> - **58 phone calls have ever been placed.** The latency gate has been met on three days
>   (13, 16, 25 Aug) and never since 20 Aug. Best-ever 865 ms → 2,475 ms today.
> - **The prompt is a one-way ratchet.** 10,574 → 15,334 chars, +45% on 26 Aug alone across
>   nine patches, **five of which recorded no measurement at all**. The regression was visible
>   that night (2473/2525/2617 ms) and the response was to tune a voice knob.
> - **The same four complaints** — filler "hmm", too fast, repeated confirmations, no booking
>   SMS — were re-reported in **twelve separate sessions**, each promising to fix them via the
>   API. They are still open.
> - `interruption_sensitivity` has been set **six times**, `voice_id` **five times**. The
>   assertion script was *widened* to accept a band rather than the question being settled.
>
> This skill's own eval rubric already stated the rule that was broken: *"Expect the prompt to
> get shorter. That is the tell that you fixed the cause and not the symptom."*
>
> **If a fix makes the prompt longer, it is a symptom patch.** Find the instructions already in
> the prompt that cause the behaviour and delete them. And one lever, then a **graded suite
> run** — an intention to place a call is not verification. Fourteen "verification still owed"
> items were never done.
>
> **Update, 1 Sep 2026:** that suite now exists and runs in CI (`deploy/voice-tests/cases.json`, `voice-agent-behaviour.yml`). The freeze's precondition is met; the discipline it describes is not thereby cancelled.

**Measured decomposition, 27 Aug 2026** (`scripts/turn-latency.mjs`, 37 healthy calls,
21 sub-15 s drops excluded). Stop quoting a blended e2e p50 — it hides the dominant term:

| Term | p50 | Paid on |
|---|---|---|
| Endpointing | **~581 ms** | every turn |
| LLM generation | 655 ms | every turn |
| TTS | 193 ms | every turn |
| **Tool overhead** | **~1,082 ms** | every TOOL turn |
| — our own API | **67 ms** (n=180, Cloud Run logs) | — |

## Definition of done for an agent

Machine-checkable half (`scripts/assert-agent.mjs` runs all of these):

- [ ] Prompt and begin_message are **de-venued**: zero venue names in prose. Identity comes
      only from `{{restaurant_name}}` / `{{owner_name}}` (venue-onboarding.md §1 trap 3).
- [ ] Every functional tool has `speak_during_execution: true` AND
      `speak_after_execution: true` (dead-air incident — see triage).
- [ ] Every functional tool carries `execution_message_description` constraining the aside to
      three to six words with **no booking or order details**, and `end_call` has
      `speak_after_execution: false`. The LLM otherwise writes a full-sentence recap as the aside
      and speaks a second goodbye after yours (issue #389, 5 Sep 2026). `assert-agent.mjs`
      enforces both under `REQUIRE_CONFIRM_ONCE=1`.
- [ ] `default_dynamic_variables` carries **no volatile keys** — `today`, `tomorrow`,
      `weekday_local`, `now_local`, `caller_phone`. These are the fallback when
      `/retell/inbound` fails and nothing refreshes them, so the rule (NUMBERS.md §6) is
      that a fallback may only ever be **vague, never wrong**: frozen dates and a
      hardcoded caller number go confidently wrong. A single-venue agent's own *static*
      identity (`restaurant_name`, `owner_name`, `restaurant_timezone`, and a weekday-free
      `today_status` for a venue that trades every day) cannot go wrong and is permitted —
      it is also the only way to test in the dashboard, where no webhook fires. Clear it if
      the agent is ever re-pointed at another venue.
- [ ] `webhook_url` and every tool URL point at THIS environment's API hostname and no other.
- [ ] Golden knobs match the table below.
- [ ] Number binding is **webhook mode** (`inbound_webhook_url`), never a static
      `inbound_agent_id`, for any venue number (NAMES.md §6).

Human half (the 3-minute ear battery, details in
[references/build-and-promote-venue-agent.md](references/build-and-promote-venue-agent.md)):
greeting ≤5 s; "what time do you open?" answered instantly with **no tool call**; a
closed-day booking ask refused instantly with the next open day, **no tool call**; a
happy-path booking with correct SPOKEN date; she stops when interrupted; menu answers name
two or three things then ask, never a recital. Latency gate: **e2e p50 ≤ 1.7 s**.

Plus: venue row bound in the DB with `opening_hours_json` + `faq_json` populated, and the
pre/post snapshots committed.

## The golden config (verified against `20260819-humanize-post/`)

| Knob | Value | Measured why |
|---|---|---|
| `stt_mode` | `fast` | `accurate` cost ~600 ms on every turn (e2e p50 2.3 s → 1.0–1.65 s after the switch). Menu vocabulary is protected by `boosted_keywords`. **Revert trigger:** garbled dish or person names. |
| `enable_expressive_mode` | `false` | Measured **+1.0 s per turn** (e2e p50 2.1 → 3.0 s, uniform). Sounds warmer, feels slower — and slow reads as MORE robotic. Demo-only re-enable; the tag list stays configured on the agent so it is one boolean away. |
| `interruption_sensitivity` | `0.6` | 0.4 made her talk over a caller for ~9 s; 0.7 combined with ambient_sound self-interrupted the greeting. 0.6 with no ambient sound is the tested point. |
| `ambient_sound` | none | The coffee-shop track was transcribed as caller speech and killed greetings. Never re-add. |
| backchannel | on, 0.7, `["mm","mm-hm","yeah","right","no worries"]` | Free perceived-latency and warmth. |
| `voice_id` | `retell-Cimo` (platform voice) | Sam's ear-tested pick; platform voices support Expressive Mode and multi-provider fallback. Voice choice guidance: [references/voice-and-audio.md](references/voice-and-audio.md). |
| `voice_temperature` / `voice_speed` / `volume` | 1.1 / 1 / 1 | From the 16 Aug naturalness pass. |
| `responsiveness` | 1 (+ dynamic responsiveness & speed on) | Already maxed — not a lever. |
| `begin_message_delay_ms` | 500 | Answers feel deliberate, not robotic-instant. |
| tool `execution_message_description` | "A tiny aside of three to six words with NO booking or order details — e.g. 'Just checking that now…' for a lookup, 'Locking that in…' for a booking or order." on every functional tool | Without it the aside is a full recap ("Booking in a table for Megan at four thirty tomorrow") spoken 2 s before the result sentence says the same thing. Our API answers in ~67 ms, so the aside covers Retell's own ~1 s tool overhead and nothing else. |
| `end_call.speak_after_execution` | `false` | With `true` the model's `execution_message` ("Cheers Megan, see you tomorrow!") is spoken after the goodbye it already said — every production call ended with two farewells. |
| `reminder_trigger_ms` | 18000, max 1 | Restored after a rebuild dropped it. |
| `denoising_mode` | `noise-and-background-speech-cancellation` | Part of the ambient/echo fix set. |
| `data_storage_retention_days` | 30 | Legal posture — a rebuild once silently dropped it. |
| `begin_message` (production) | names Bella as **an AI assistant** and says the call **is recorded** | The owner warrants this in the agreement ledger. `assert-agent.mjs` checks the greeting; it passed the Mazcina production agent on 20 Aug with neither phrase present because nothing looked. Staging skips via `ALLOW_NO_DISCLOSURE=1`. |
| LLM `model` / `model_temperature` | `gpt-4.1` / 0.2 | Quality pick; see latency ladder before touching. |
| KB | deliberately unused | Venue facts travel per call as `{{venue_faq}}` (≤16 entries/1200 chars) — injection beats retrieval for a dozen facts and costs no lookup latency. |

## Latency doctrine

A turn spends its time in: **endpointing** (deciding the caller finished — `stt_mode`) →
**LLM first token** (model + prompt length) → **TTS start** (~150–250 ms, already fast).
Tool turns add: tool-call decision + HTTP round trip + a second generation — which is why
the biggest single win was removing tool calls from questions the agent can already answer
(`today_status`).

Measure, never guess: `scripts/latency-report.mjs` (per-call e2e/llm/tts percentiles) and
`scripts/review-call.mjs` (word-timestamp gaps per turn). Reference points from 19 Aug:
worst 3.0 s p50 (expressive on) → 2.2 s (expressive off) → **1.0–1.65 s** (stt fast +
no-tool hours answers).

Lever ladder, largest first — pull ONE, then measure:
1. Expressive Mode off (−1.0 s, done).
2. `stt_mode: fast` (−~600 ms, done).
3. Prompt length (golden is ~10k chars; keep it there — every section earns its tokens).
4. Model swap (gpt-4.1 → a faster tier) — **last resort, untested**; risks tool-flow
   discipline; a deliberate experiment with the full ear battery, never a default.
Free perceived-latency tricks already in the prompt: instant-open first word,
`execution_message` asides during tools, backchannel.

## Triage tree — symptom → cause → fix

Every line below is a real incident, not a hypothetical.

| Symptom | Cause | Fix |
|---|---|---|
| Dead air after "let me check…", caller hangs up | A functional tool has `speak_after_execution: false` — the result arrives and no generation is triggered (18 s of silence holding a 162-char result, 19 Aug) | Assert `true` on every functional tool. Any agent built by copying an old one inherits `false`. |
| Booking details spoken 4–7 times; two goodbyes (Megan, `call_bc863edd…`, 4 Sep 2026: aside → result → confirm → aside → result → goodbye → end_call message) | Three mechanisms, none of them prose: the LLM authors its own tool aside; the backend's `confirmation_message` was a full recap and the prompt said "read it back"; `end_call` speaks its `execution_message`. Twelve sessions added prompt words against this and it never moved. | Tool-level `execution_message_description` (contentless), `end_call.speak_after_execution=false`, backend returns "All set, Megan." with the facts as fields, `check_availability` returns `next_step` so the ONE recap happens before the commit (the prompt's "confirm once" was skipped whenever the caller front-loaded details — a tool result is read at decision time, prose is not). Graded: `one-recap-not-five`. |
| Reads a 15+ second monologue | Summary-recite: the tool description or prompt lets her read a whole `speakable_summary` | "Name two or three things, stop, ask" — in both the prompt AND the tool description. |
| Talks over the caller for seconds | `interruption_sensitivity` too low | 0.6. Only lower it if actual self-interruption is observed AND ambient audio has been ruled out first. |
| "Yes we're open— actually we're closed" / "thinks about" the hours | Answering before checking; or deriving open/closed by calling `check_availability` | `{{today_status}}` spoken verbatim + the closed-day no-tool gate. See [references/prompt-architecture.md](references/prompt-architecture.md). |
| Greets as the wrong venue / names the wrong owner | Static venue text in the prompt, a borrowed agent binding, or a published stale dashboard draft | De-venue the prompt; bind via the admin endpoint (verifies name + uniqueness); discard dashboard drafts. |
| Greeting dies mid-sentence at a consistent time | Check the **duration signature first**: identical `duration_ms` across failures = telephony, NOT the agent (the 7.6 s drops were misdiagnosed as an agent bug for half a day) | [references/call-forensics.md](references/call-forensics.md); ambient_sound only if durations vary. |
| Call drops at a fixed duration, `user_hangup` | Upstream telephony (both vendors will blame the other side) | Two-sided verdict method + `deploy/runbooks/incident-7600ms-call-drops.md`. |
| "We don't have that" for the menu itself | `query: "menu"` can never match an item | menu_lookup three-mode contract: no args = sections; `category` = one section; `query` = a named dish only. |
| Offers a breakfast-only item at night / doesn't know which menu is on; order then refused with ITEM_NOT_AVAILABLE_NOW | Daily windows reached the DB and the order gate but never the menu ANSWER (call_4e871f4bc, 30 Aug 2026 — three haloumi variants offered identically for a 2 PM pickup; caller gave up at the late refusal) | `{{menu_status}}` injected per call (spoken verbatim, "" when unwindowed); `menu_lookup` matches carry `available_now` + `served`; the order gate judges the PICKUP time, not the call time. Prompt must reference `{{menu_status}}` once the backend serves it — `assert-agent` enforces via `REQUIRE_MENU_STATUS`. |
| Order fails 2–3 times, then "something glitched, I'll get the team to call you back" | The dish has a REQUIRED modifier group and the agent could not know the option names, so it guessed the caller's word ("the chicken one") and got `UNKNOWN_MODIFIER` — a readable error it then failed to read out (28 Aug 2026, Cuban Pressed Sandwich, four fillings, call abandoned) | `menu_lookup` now returns `required_choices` (required groups only — optional add-ons include alcohol). Prompt: ask the choice BEFORE ordering; when a tool names the real options, read them and let the caller pick; **never say "glitched"**; never send the same failing call twice. |
| Agent apologises for the system instead of asking the obvious question | Tool errors are written to be spoken, and the prompt has no rule saying so | Every error path in the prompt must end in a question to the caller, not an apology. An error naming valid options IS the menu answering. |
| Books with phone number "anonymous" | Withheld caller ID passed through as a literal | Backend sends `""`; prompt asks digit-by-digit before `create_booking`. |
| Speaks the wrong date ("the twenty-second" for the 20th) | Day-of-month said from memory | Prompt rule: spoken day-of-month comes off the resolved YYYY-MM-DD. |
| Stale dates or venue name on some calls only | `default_dynamic_variables` populated + inbound webhook 401ing → silent fallback | Keep them `{}`; fix the webhook auth; NUMBERS.md §6. |

## Boundaries

- Numbers, regulatory bundles, SIP trunks, AU1 regions, SMS → **`twilio-au-number-provisioning`**.
- **The greeting disclosure is a legal decision, not a style one.** Staging deliberately runs
  the ultra-short greeting with no AI/recording disclosure; **production must not, without
  sign-off** — `deploy/runbooks/legal-brief-call-recording.md`.
- Production (Biteperk workspace) changes only via the promotion recipe in
  [references/build-and-promote-venue-agent.md](references/build-and-promote-venue-agent.md).

## References and tools

- [references/prompt-architecture.md](references/prompt-architecture.md) — dynamic variables, the golden prompt's section map, greeting variants, tool contracts
- [references/voice-and-audio.md](references/voice-and-audio.md) — voice selection, Expressive Mode economics, ear-test protocol, audio incident catalog
- [references/build-and-promote-venue-agent.md](references/build-and-promote-venue-agent.md) — venue #N build recipe, verification battery, production promotion
- [references/api-operations.md](references/api-operations.md) — keys, endpoints, snapshot discipline, signed probes, Retell gotchas
- [references/call-forensics.md](references/call-forensics.md) — reviewing calls, the US1/AU1 trap, two-sided verdicts, audit events
- `scripts/` — `snapshot.sh`, `probe-inbound.mjs`, `review-call.mjs`, `latency-report.mjs`, `assert-agent.mjs` (usage in api-operations.md)
- **Whole-line tooling** (added 20 Aug 2026, after three simultaneous undetected breaks):
  - `assert-line.mjs <+E164> [--strict]` — asserts the entire chain against `deploy/voice-lines.json` and names the layer that broke. `npm run check:voice-lines` runs it over every declared line.
  - `apply-line.mjs <+E164> [--apply]` — idempotent reconcile of live → declared. Dry-run by default; snapshots before writing and reads back after.
  - `switch-line.mjs <+E164> --to <profile> [--apply]` — for a **router-mode** line (the shared staging number, `routing.mode: "router"` in the declaration): switches the Twilio router (through voxstay's CLI), the Retell inbound shape and nothing else, reads back, logs to `deploy/voice-line-switches.log`, then re-asserts with `--expect`. Added 6 Sep 2026 after the checker spent a week reading a detached trunk as a ghost record while the real path failed. `assert-line --expect <profile>` is the read-only half for a human about to dial; `--calls 24` judges the most recent real SIP leg to Retell.
  - `selftest-assert-line.mjs` — corrupts the declaration one field at a time and requires the checker to fail. A checker nobody has seen fail is a green light, not a check.
  - `.github/workflows/voice-line-health.yml` — hourly off-laptop run, so a break is found by a machine rather than by a customer.
