# Mazcina in PRODUCTION — Biteperk workspace, 19 Aug 2026

The first BitePerk-owned production voice line. Promoted from the Sam/Abhishek-verified
staging pair (`agent_7b67073710604d306443cc569c` / `llm_c1d40dbe180e737dd2ce1309ed3f`).

| | |
|---|---|
| Production agent | `agent_3bedcbdd77017136e5b4ade412` — "Mazcina (production)" |
| Production LLM | `llm_5774e05076475b2b0cdba5329ad5` (11,573 chars) |
| Number | `+61 468 202 846`, imported webhook-mode → `https://api.biteperk.com.au/retell/inbound` |
| Venue row | `44444444-4444-4444-8444-444444444444` (production DB on the VM) |
| Voice / knobs | `retell-Cimo`, `stt_mode fast`, interruption 0.6, expressive off, 30-day retention |

## Why this prompt differs from staging's (and it MUST)

Production runs `main` on the VM — 25 commits behind `integration`, with its **database at
migration 024**. Verified before building: its `/retell/inbound` serves only
`restaurant_id, restaurant_name, restaurant_timezone, caller_phone, today, tomorrow,
now_local, weekday_local`. It has **no `venue_faq`, no `owner_name`, no `today_status`**;
its availability tool **cannot return `reason: "closed"`**; `menu_lookup` **ignores
`category`**; and a zero-match menu reply names the **old fixture categories**.

Adaptations, each forced by one of those facts:

1. `{{today_status}}` and the `{{venue_faq}}` block removed — they would have been spoken
   aloud as literal text.
2. New **`## This venue's details`** section carries Mazcina's real hours and FAQ answers.
   ⚠️ **TEMPORARY and deliberate**: this is venue data in prose, which the de-venue rule
   normally forbids. **This agent must never be cloned for another venue.** Delete the
   section the day the backend serves `venue_faq`.
3. `{{owner_name}}` → "the team" (not served).
4. Closed-day rule strengthened: the prompt must answer closed days itself, because the
   tool would report "no table available" and leave the caller thinking we are merely full.
5. `menu_lookup` reduced to two modes, plus "never read the category list out of a miss" —
   that is what stops fixture categories reaching a real caller.
6. **Hard gate in the build script**: every `{{variable}}` in the final prompt is checked
   against the served list, and the build aborts otherwise. Result: `restaurant_name,
   today, weekday_local, tomorrow, restaurant_timezone, caller_phone, call_id` — all served.

## ⚠️ Greeting carries NO AI/recording disclosure

`Thanks for calling {{restaurant_name}} — this is Bella. How can I help?`

Sam's explicit decision, made against my recommendation to restore it, and recorded here as
his. The call-recording legal brief (`deploy/runbooks/legal-brief-call-recording.md`, NSW
Surveillance Devices Act) is still open. **Gate: restore the disclosure before this number
is publicised, handed to the venue, or given to real customers.** One PATCH to reverse; the
compliant long form is preserved in `20260819-humanize-pre/llm.json`.

## Verified

- Signed `/retell/inbound` on `api.biteperk.com.au` → **200** (signature path healthy;
  note production verifies with `RETELL_WEBHOOK_SECRET`, which is **not** the same string
  as `RETELL_API_KEY` — signing a probe with the API key 401s).
- Production venue data: 10 tables, Tue/Wed closed, 8 menu categories, 31 items.
- The pilot line `+61 2 7501 1140` and Natalia's row are untouched.

## Rollback

- DB: null `twilio_phone_number` + `retell_agent_id` on the Mazcina row → the line fails
  closed (reaches nothing) rather than answering wrongly.
- Retell: `DELETE /delete-phone-number/+61468202846`; delete this agent + LLM.
- `20260819-prod-mazcina-pre/` holds the workspace's prior state.

## Open follow-ups

1. **The agent is not published** (`is_published: false`). Retell exposes no publish API on
   the documented path; click Publish in the dashboard. Not functionally required — webhook
   mode serves the draft, proven on staging — but it pins the version.
2. Production DB is at migration **024** (missing 025–031, incl. the double-booking
   exclusion constraint). Menu import needed the 031 columns stripped to apply.
3. Backend promotion is blocked on `LEGAL_DOCUMENTS_MANIFEST_URL`, which the VM's `.env`
   lacks — the new code refuses to boot without it. Sequence when ready: publish legal docs
   → add the env var → apply 025–034 → deploy → then delete the temporary venue section.

## Bind applied and verified, 19 Aug 2026 23:18 AEST

`UPDATE 1` on the venue row (Sam ran it; the permission layer holds production routing
writes for a human). Signed probes against `https://api.biteperk.com.au` then confirmed the
whole chain:

| Probe | Result |
|---|---|
| `/retell/inbound` (`to_number +61468202846`) | 200 · `override_agent_id agent_3bedcbdd77…` · `restaurant_name Mazcina` · all served variables present |
| `menu_lookup` (no query) | Mazcina's REAL sections — Mushroom Ceviche, Mazcina Earth Board, Red Mechada Pasta. **No fixture items.** |
| `menu_lookup` ("empanadas") | Cocktail Empanadas ($5) |
| `check_availability` Wed 26 Aug | `available: false` — but the message is the generic *"No suitable table is available near the requested time."* This is precisely why the prompt must answer closed days itself; the tool cannot distinguish shut from full on this backend. |
| `check_availability` Thu 20 Aug | `available: true`, table T1 |

Remaining before the line is customer-facing: Sam's real test call, clicking **Publish** in
the dashboard (optional — webhook mode serves the draft), and restoring the disclosure.

## Full venue name + pronunciation, 20 Aug 2026

Sam heard "Mazcina" (not "Mazcina Resto-Bar"), pronounced "Mazina". Root cause was a data
gap, not the prompt: PR #232 renamed the venue in the seed files and applied it to staging,
but **production's database was never updated**. The prompt needed no edit — it is de-venued
and speaks `{{restaurant_name}}`.

Applied:
- Production DB `restaurants.name` → `Mazcina Resto-Bar` (targeted UPDATE; the full seed was
  deliberately not re-run, since its hours/FAQ/tables are already correct).
- **Pronunciation dictionary** on BOTH Mazcina agents — the "ask Camilo" item open since the
  conversion is now closed: `{"word":"Mazcina","alphabet":"ipa","phoneme":"mɑˈsinɑ"}`
  ("mahs-SEE-nah", Spanish/Chilean, confirmed by Sam).
- `boosted_keywords` gained the full name on both, so the STT is not biased against hearing
  a caller say it.
- **Agents renamed** to `Mazcina Resto-Bar (production)` / `(staging)`. This was not cosmetic:
  the admin bind guard is `comparableName(agentName).includes(comparableName(venueName))`
  (`retellProvisioning.ts:322`), so the rename had silently left **staging already broken** —
  agent "Mazcina" vs venue "Mazcina Resto-Bar" → `409 RETELL_AGENT_VENUE_MISMATCH` on any
  future rebind, discoverable only mid-incident. Both now satisfy the guard.

⚠️ **The rename alone did not take effect** — the deployed image (`api:0.1.0`) predates the
name-cache TTL, so its cache **never expires** (`expiresAt` is absent from the running
build). The old name was pinned in memory until `docker restart vocotable-api-1
vocotable-worker-1`. Any future venue rename on this image needs the same restart; the TTL
fix arrives with the backend promotion.

Verified: signed `/retell/inbound` returns `restaurant_name: "Mazcina Resto-Bar"`;
`assert-agent.mjs` green on both agents.
