# Building venue agent #N, verifying it, and promoting to production

Numbers, trunks and SIP are the sibling skill (`twilio-au-number-provisioning`) and its
`retell-and-db-binding.md`. This file starts where a working number ends.

## Build (staging first, always)

1. **Source = the golden snapshot**, latest `deploy/retell-snapshots/*/` (`llm.json` +
   `agent.json`). Never a hand-written config, never memory, never an old snapshot — the
   13 Aug rebuild-from-snapshot silently stripped the disclosure greeting and
   `data_storage_retention_days: 30`.
2. **Create the LLM** (`POST /create-retell-llm`): golden `general_prompt` verbatim (it is
   de-venued — reusable as-is), golden `general_tools` (assert speak flags survived),
   `model`, `model_temperature`, `begin_message`, `start_speaker`,
   **`default_dynamic_variables: {}`**. Tool URLs → THIS environment's API host.
3. **Create the agent** (`POST /create-agent`): golden agent knobs (the SKILL.md table).
   ⚠️ **API-created agents do NOT inherit `webhook_url` or anything else "obvious"** — set
   every field explicitly (observed 19 Aug: fresh agents arrived without webhook_url and
   without dynamic-variable plumbing).
4. **Per-venue customisation — exactly three things, all OUTSIDE the prompt:**
   - `boosted_keywords`: THIS venue's name + the dishes callers will say. A copied agent
     carries the previous venue's list (live find: "Natalia's Bistro" + "fish and chips"
     still boosted on Mazcina's clone).
   - `pronunciation_dictionary`: the venue name, confirmed with the owner.
   - `agent_name`: must contain the venue name — the admin bind endpoint verifies it.
   Venue facts (hours, FAQ, owner, timezone, transfer number) go in the DATABASE
   (`restaurants` + `restaurant_settings.opening_hours_json` / `faq_json`), never the prompt.
5. **Bind** via the admin endpoint —
   `PATCH /api/admin/restaurants/:id/provisioning { twilio_phone_number, retell_agent_id }`
   (both together; half-binds are rejected). It verifies the agent exists, is held by no
   other venue (migration 034 unique index), and is named for this venue. SQL binding only
   when a zero-round-trip run demands it, replicating those three checks by hand — and note
   SQL binds take up to 60 s to serve (per-process cache).
6. **Number in webhook mode** on the Retell side (`inbound_webhook_url` → this environment's
   `/retell/inbound`; `inbound_agent_id` null). Static bindings kill per-venue resolution
   silently (NAMES.md §6).
7. Snapshot the built pair into `deploy/retell-snapshots/<date>-<venue>-built/`, commit.

## Verification battery

**Machine half (run before any human dials):**
- `scripts/assert-agent.mjs <agent_id> <llm_id>` — definition-of-done checks.
- `scripts/probe-inbound.mjs <number>` — signed inbound probe; every dynamic variable
  present with venue-correct values (`today_status` matching the venue's real hours is the
  canary for the DB half).
- Signed tool probes: `menu_lookup` no-args (real sections), a real dish query, a
  closed-day `check_availability` (`reason: "closed"`).
- `npm run smoke:retell-signed` against the environment when configured.

**Ear half (~3 minutes, per meaningful change and at build):**
1. "What time do you open?" → instant, correct, **no tool call** in the transcript.
2. "Can I book [a closed day]?" → instant refusal + nearest open day, **no tool call**.
3. Happy-path booking → name asked explicitly, one confirmation, correct SPOKEN
   day-of-month, confirmation read back.
4. Interrupt her mid-sentence → she stops within a beat.
5. "What's on the menu?" → two or three real items, then a question. Any fixture item
   (Fish & Chips as a fixture, Garden Salad) = the venue's menu import regressed.
6. Withheld caller ID booking → she asks for the number digit by digit, booking succeeds.
Then `scripts/latency-report.mjs 5` — **e2e p50 ≤ 1.7 s**, and `review-call.mjs latest` for
dead air (no >3 s silent gap after any tool result).

A green console is configuration; only the battery is connectivity and behaviour.

## Promotion to production (Biteperk workspace)

Deliberate, atomic, never partial:

- **What promotes**: the staging-proven `general_prompt`, tools, and agent knobs — replayed
  into the Biteperk workspace via the same create/PATCH calls. Payloads carry no hostnames
  or secrets, so replay is safe.
- **What CHANGES during promotion** (the checklist that makes it safe):
  1. `webhook_url` + every tool URL → the production API hostname. Then **assert the staging
     hostname appears NOWHERE in the result** — cloned agents once carried production URLs
     into staging; the reverse is just as possible and worse.
  2. **The greeting**: restore the AI + recording disclosure form (legal caveat —
     `legal-brief-call-recording.md`). The staging ultra-short greeting must not reach real
     callers without sign-off.
  3. **Publish the agent.** Staging serves unpublished drafts via webhook mode (proven
     13 Aug); do not rely on that in production — publish, then bind.
  4. Bind number + venue row on the production side (production venue data is inserted
     separately — data never promotes between environments).
- **What never promotes**: staging identifiers (agent/LLM ids, numbers, hostnames), staging
  DB rows, the no-disclosure greeting.
- **One Retell account per environment** — `RETELL_API_KEY`/`RETELL_WEBHOOK_SECRET` are an
  atomic env cutover; there is no gradual migration.
- Do not repeat the battery on the production line. The full machine and ear battery must
  pass on the venue's staging twin before promotion. In production, read the promoted
  configuration back without mutation and monitor genuine customer calls. Never create
  a test booking, order, call log or other dummy row in production.

## Scale notes (many venues)

- One LLM + one agent pair **per venue** — never share an agent between venues (migration 034
  enforces it; a shared agent answers in the wrong venue's voice with the right venue's data,
  which reads as a mystery, not a bug).
- The golden prompt is the template; per-venue deltas are ONLY the three customisation items
  above. If a venue "needs" a prompt change, it's either a golden-prompt improvement (apply
  everywhere) or venue data (put it in the DB).
- `provisioningWorker` automation should converge on exactly this recipe; until then this
  file is the manual path.
