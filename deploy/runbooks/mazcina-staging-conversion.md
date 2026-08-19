# Converting the staging venue to Mazcina

Turns `VoxTable Staging Venue` into **Mazcina** — real name, real menu, its own Retell agent —
so staging stops being a synthetic fixture and becomes the rehearsal we promote to production
from. Also fixes the voice quality reported on the 18 Aug call.

**Environment: STAGING ONLY.** Staging Twilio account `AC8116857da…`, number
`+61 468 203 234`, Retell **Staging** workspace, restaurant
`33333333-3333-4333-8333-333333333333`. Production (`+61 468 202 846`, Biteperk workspace,
Natalia's Bistro) is not touched by any step here.

## Order matters — three traps

1. **Unbind BEFORE the rename.** `POST /unbind` compares `confirm_name` against the venue's
   *current* name with an exact `!==`. Do it first and it takes `"VoxTable Staging Venue"`;
   do it after and it takes `"Mazcina"`. Harmless either way — but only if you know which.
2. **Rename BEFORE creating or binding the agent.** The bind verifies the Retell `agent_name`
   contains the venue name, so binding `Mazcina (VoxTable)` while the row still reads
   "VoxTable Staging Venue" returns `409 RETELL_AGENT_VENUE_MISMATCH` — the guardrail working
   correctly against you.
3. **Retire the fixture menu with the script, not a DELETE.** `order_items` references
   `menu_items` with `ON DELETE RESTRICT` and staging has taken smoke orders, so a plain
   DELETE fails on exactly the rows that were ordered.

Sequence: `unbind → rename → retire fixtures → import menu → build agent → bind → voice
config → re-dial`.

⚠️ The staging line is **dead between the unbind and the bind**, and `smoke:staging` fails in
that window. Expected. Do it in one sitting.

## Prerequisites

- Admin Firebase token for staging (an address on `DASHBOARD_ADMIN_EMAILS`).
- Retell API access to the **Staging** workspace.
- `psql` access to staging Cloud SQL via the throwaway Cloud Run job — the instance is
  private-only, so there is no laptop path. Recipe in [`staging-venue.md`](staging-venue.md).
- **Supplied 18 Aug 2026** (from the venue's Google listing + the owner):

  | Fact | Value |
  |---|---|
  | Owner | Camilo |
  | Phone | `0433 865 661` → `+61433865661` (confirms the PDF's malformed `+04 3386 5661`) |
  | Address | 248 Palmer St, Darlinghurst NSW 2010 |
  | Cuisine | Mediterranean + South American |
  | Hours | Thu–Sat 12:00–21:30 · Sun–Mon 12:00–21:00 · **closed Tue & Wed** |

  All of it is in `deploy/seeds/mazcina-venue.sql`, verified locally: Tuesday and Wednesday
  resolve to CLOSED, the other days to their real windows.

- **Still outstanding** (do not invent these): the real **table count and capacities** — the
  four synthetic tables remain — and the **drinks/bar list**.

---

## 1. Unbind Natalia's agent

```
POST /api/admin/restaurants/33333333-3333-4333-8333-333333333333/unbind
{ "confirm_name": "VoxTable Staging Venue", "fields": ["retell_agent_id"] }
```

`agent_b9087333b7030f0cee06a19ffc` is **Natalia's Bistro (STAGING)** — the mis-bind behind
the 18 Aug wrong-venue call. The row now has no agent and fails closed loudly
(`retell_inbound_no_agent_bound`), which is the correct intermediate state.

## 2. Rename the venue and set its real details

One call does all of it — `restaurantProfileSchema` covers `opening_hours` and
`booking_duration_minutes` as well as the profile fields:

```
PATCH /api/restaurant/profile        (owner token, X-Restaurant-Id: 33333333-…)
{
  "name": "Mazcina",
  "owner_name": "Camilo",
  "cuisine_type": ["Mediterranean", "South American"],
  "address": "248 Palmer St", "suburb": "Darlinghurst", "state": "NSW", "postcode": "2010",
  "existing_phone_number": "+61433865661",
  "booking_duration_minutes": 90,
  "opening_hours": {
    "monday":    [{"open":"12:00","close":"21:00"}],
    "tuesday":   [],
    "wednesday": [],
    "thursday":  [{"open":"12:00","close":"21:30"}],
    "friday":    [{"open":"12:00","close":"21:30"}],
    "saturday":  [{"open":"12:00","close":"21:30"}],
    "sunday":    [{"open":"12:00","close":"21:00"}]
  }
}
```

`transfer_phone_number` is not on that schema — set it with
`deploy/seeds/mazcina-venue.sql`, which also serves as the whole-record fallback if the API
route is inconvenient from the staging network.

⚠️ **"Mediterranean" and "South American" did not exist as cuisine options until 18 Aug.**
The enum's closest matches were "Seafood" and "Other" — a real venue could not describe
itself. Both were added (backend enum + the onboarding form's duplicate list, now guarded by
`cuisineOptions.test.ts`). If the PATCH 400s on `cuisine_type`, staging is running an older
image.

**Through the API, never SQL.** The API invalidates the name cache; SQL does not. Since the
TTL fix that cache expires after 60s rather than persisting until the next deploy, but a SQL
rename still leaves every warm instance speaking the old name for up to a minute, and the
purge only reaches the process that served the write.

Keep `contact_email` **NULL** until the very end — binding the number fires a `number_ready`
notification, and a real address would email the venue mid-install.

## 3. Retire the fixture menu

```
psql -f deploy/seeds/mazcina-retire-fixture-menu.sql
```

Deactivates all five fixture items, then deletes only those no order references, then drops
the categories left empty. Proven against a replica carrying a real order pin: Fish & Chips
was retained deactivated (3 order_items), the other four deleted, `Breakfast` and `Drinks`
dropped, `Mains` kept because it still holds the retained row. Re-running is clean.

Retained-but-deactivated rows are expected. The check that matters is the API, not the table:

```
GET /api/menu   →   must contain no fixture item
```

## 4. Import Mazcina's menu

```
npm run menu:import --workspace=@vocotable/backend -- \
  --restaurant-id 33333333-3333-4333-8333-333333333333 \
  --file mazcina/mazcina-menu-voxtable-import.json --dry-run
```

Review the report, then re-run without `--dry-run`. Against a local database the dry run
reports **8 categories, 31 items, 0 renames, 0 dropped modifiers, 0 clamped groups** — any
other numbers mean the file changed and needs re-reading.

Staging's database is private-only, so use `--emit-sql <out.sql>` and apply the file through
the throwaway Cloud Run job instead of connecting directly. Note the emitted SQL is
insert-if-absent: it does not UPDATE existing rows, so for a price correction later, re-run
the direct-mode import rather than the SQL.

The menu JSON lives in `mazcina/`, which is **gitignored** — the source PDF is 433 MB of page
scans and per-venue collateral does not belong in this repo (same rule as `Cuban-Corner/`).
Keep it in Drive; regenerate from the PDF if lost.

## 5. Install the real floor plan

```
psql -f deploy/seeds/mazcina-tables.sql
```

10 tables, 36 seats: T1–T4 (1–2), T5–T8 (2–4), T9–T10 (4–6). Upserts by label and then
deactivates anything not in that set, so it lands correctly whether the venue currently
carries the staging fixture's `S1–S4` or an earlier `T1–T4`, and re-running changes nothing.

⚠️ **Never delete a table that has reservations.** `reservations.table_id` and
`orders.table_id` are `ON DELETE SET NULL`, **not** RESTRICT, so a delete does not error — it
silently nulls `table_id` on every booking, and migration 025's overlap guard is
`WHERE table_id IS NOT NULL`, so those bookings fall out of it and their seats become sellable
again. Proven on a replica: a plain `DELETE` succeeded and orphaned a confirmed booking.
Deactivating preserves everything.

⚠️ **The ceiling drops from 8 seats to 6.** Nothing in the platform combines tables, so a
party of 7+ cannot be booked by voice. That is now answered honestly rather than blamed on the
clock — `checkAvailability` returns `reason: "party_too_large"` and Bella offers a callback.
Leg 8 of the call battery is there to prove it.

Verify: 10 active tables with a ceiling of 6, `S1–S4` inactive rather than deleted, and **zero
reservations with `table_id IS NULL`** — that last one is the silent failure.

## 6. Build the Mazcina agent

One agent **and one LLM**, per [`venue-onboarding.md`](venue-onboarding.md) §1 and NAMES.md §6.
Build from the **live** staging config, not a snapshot — snapshots lack the AI + recording
disclosure.

- `agent_name`: `Mazcina (VoxTable)`
- Prompt carries **no venue name in prose**. Identity is `{{restaurant_name}}` and
  `{{owner_name}}`, injected fresh per call by `/retell/inbound`. Assert on the finished
  payload that "Natalia" appears nowhere.
- Remove the line *"You speak in a warm, calm, unmistakably Australian voice"* — `11labs-Anna`
  is catalogued **American**, so it claims something untrue and prompt text does not affect
  timbre anyway.
- `default_dynamic_variables`: **empty**.
- The prompt must consume **`{{venue_faq}}`** — answer from it when it covers the question,
  otherwise offer to take a message, and **never invent an answer** (§9). Ship the backend
  first and confirm the variable actually arrives; a prompt referencing a variable the backend
  does not send reads an empty placeholder to a caller.
- `webhook_url`: the staging API's `/retell/webhook` (API-created agents do not inherit it).

Snapshot before and after into `deploy/retell-snapshots/<ts>-mazcina-staging/`.

## 7. Bind

```
PATCH /api/admin/restaurants/33333333-.../provisioning
{ "twilio_phone_number": "+61468203234", "retell_agent_id": "<the new Mazcina agent>" }
```

Both fields together — the endpoint rejects one without the other. It also verifies the agent
exists in Retell and is named for this venue, so a leftover Natalia agent cannot be re-bound
by accident.

Record the new agent + LLM ids in NAMES.md §6 and in [`staging-venue.md`](staging-venue.md).

---

## 8. Voice configuration

Snapshot the live agent first (`GET /get-agent/<id>`) — **that snapshot is the rollback.**

### 8a. Pin the voice model

`voice_model` is unset on every agent in the repo's history, so Retell picks its own default
for `11labs-Anna` — the low-latency `eleven_flash_*` family, which is audibly flatter. That is
the "robotic" report.

The instability matters more than the flatness: an unpinned model is Retell's to change, with
no edit on our side and no movement in `last_modification_timestamp`. That is the most likely
mechanic behind "the voice changed", and pinning is the only fix.

```
voice_model:        "eleven_multilingual_v2"
fallback_voice_ids: [ … ]      # explicit, so a fallback lands somewhere we chose
voice_id:           "11labs-Anna"   # unchanged
```

`eleven_multilingual_v2` earns it twice over here: better prosody, and far better handling of
the Spanish and Chilean names all over Mazcina's menu. The flash family mangles them.

⚠️ It is slower than flash, against a sub-1s perceived-response budget
(`plan-phases/02-voice-agent-quality.md`). If latency regresses audibly, fall back to
`eleven_flash_v2_5` — still pinned, still stable, just flatter. **Pinning is the
non-negotiable part; which model is a tunable.**

### 8b. Restore `reminder_trigger_ms` — and only that

`20260529-busy-fix` set `reminder_trigger_ms: 18000` and `reminder_max_count: 1`; both are
absent from every snapshot since 13 Aug.

- `reminder_trigger_ms` — SDK default is **10000 ms**. Without the 18s setting Bella interjects
  a canned "are you still there?" after 10s of silence, and an availability check plus a
  booking write can exceed that — so the reminder fires *during* a tool call. A canned line in
  a different register, mid-conversation, is the best-evidenced explanation for "it changed in
  the middle". **Restore it.**
- `reminder_max_count` — SDK default is **already 1**. Re-setting it changes nothing. Skip it,
  so nobody re-adds it later believing it did something.

### 8c. Do NOT set `normalize_for_speech`

It vanishes in the same diff and looks like the same regression. It is not: the field **no
longer exists in Retell's API** (zero occurrences in retell-sdk 5.60.0), and
`venue-onboarding.md` §1 already lists it among fields that must not be copied from old
snapshots.

### 8d. Pronunciation dictionary

An American English voice will mangle most of this menu. `pronunciation_dictionary` takes
`{ word, alphabet: "ipa" | "cmu", phoneme }`. Seed at minimum: **Mazcina** (the venue's own
name on the greeting is the most damaging one to get wrong), then Sopaipillas, Chorrillana,
Celestinos, Barros Luco, Mechada, Provenzal, Chilena, Cancato.

Confirm the intended pronunciation of "Mazcina" with the venue rather than guessing.

---

## 9. What Bella can now answer about the venue

`restaurant_settings.faq_json` has existed since migration 001, has been seeded since day one,
and until now **nothing read it**. It is wired into the voice path as the `venue_faq` dynamic
variable, and populated for Mazcina from the OpenTable listing: parking, wheelchair access,
dogs, outdoor seating, BYO + corkage, dietary options, takeaway, dress code, payment methods,
the Sunday/public-holiday surcharge, and groups.

Two things to know before editing it:

- **It is injected into EVERY call's prompt**, answered or not, so it is capped at 12 entries
  and 800 characters (`apps/backend/src/services/venueFaq.ts`). Mazcina's currently renders at
  758 — there is room for a short edit, not a paragraph. Over budget, whole entries are
  dropped and the dropped keys are logged at `error`.
- **Happy hour times and the corkage amount are deliberately missing.** The listing says both
  exist but not what they are, and a specific wrong number read aloud is worse than "let me
  take a message". Add them when Camilo confirms.

The prompt must instruct Bella to answer from `venue_faq` when it covers the question and
otherwise offer to take a message — **never invent an answer**. Wheelchair access and dietary
claims are where a confident guess does real harm.

⚠️ **Order matters: backend first, prompt second.** Ship the backend, confirm `venue_faq`
appears in a real inbound response, and only then edit the prompt. A prompt referencing a
variable the backend does not send is the worse failure — Retell substitutes nothing and Bella
reads an empty or literal placeholder to a caller.

## 10. Prove it

**Machine.** `npm run check`, then `npm run smoke:staging` against the real staging API —
that is where the repointed order assertions actually run. `smoke:agent-routing` must stay
green: the rename must not disturb number → venue → agent routing.

**Human.** Dial `+61 468 203 234` and run
[`staging-call-battery.md`](staging-call-battery.md), filling in the results table. Leg 1
already requires Bella to name **this** venue — she must now say *Mazcina*, pronounced right.

**Judge the voice deliberately**, because "sounds better" is not actionable later. Per call:

- Did the register change mid-call at any point? (the reminder regression)
- Was the readback of times, dates, party size and prices flat or natural? (the model)
- Were Sopaipillas / Chorrillana / Celestinos / **Mazcina** pronounced correctly?
- Perceived lag after you stop speaking — better, same, or worse? This is what decides whether
  `eleven_multilingual_v2` stays.

**Abort criteria.** Revert to the §8 before-snapshot and stop if: the line does not answer;
latency is clearly worse; or the agent answers as anything other than Mazcina. Do not stack
further changes on a line that regressed — the last bug was hard to find precisely because
two things were wrong at once.

## 11. Finish

⚠️ **Go-live precondition — OpenTable coexistence, decided: both live.**

Mazcina keeps OpenTable running and takes VoxTable calls against the same floor. That is the
venue's call, and it is recorded here so go-live has an auditable answer to "who decided this":

| | |
|---|---|
| Decision | Run both; accept the double-booking risk |
| Accepted by | Camilo (Mazcina) — **confirmation to be recorded, with date** |
| Reviewed | 19 Aug 2026 |

What is being accepted, stated plainly: two systems booking one floor cannot see each other.
`reservations_no_overlap` protects our rows only, so two parties can be seated at one table
with both systems reporting success to their own caller.

**The reconciliation surface is human.** The dashboard live-feed shows VoxTable bookings;
OpenTable shows the rest; nothing merges them. Whoever works the floor is the integration
until the Partner API lands (`venue-onboarding.md` §5b).

**The mitigation deliberately not taken**, so it stays on the table: splitting inventory — a
disjoint subset of tables per system via the `is_active` flag — makes collision structurally
impossible with no integration, at the cost of some of Bella's inventory.

None of this blocks the staging test: Mazcina stays `provisioning` and staging-only, where
there are no real diners to collide with.



Backfill `contact_email`, `owner_name`, real hours and the real table layout once the venue
supplies them. Then `POST /api/admin/restaurants/:id/go-live`.

---

## Three things the venue's public listing tells us

1. 🚧 **OpenTable is LIVE — this is a hard go-live gate, not a note.** The listing is not a
   dormant link: it shows real inventory ("Booked 1 time today", next-available dates,
   15-minute slots). VoxTable and OpenTable would both write bookings against the same
   physical tables, and neither can see the other — migration 025's `reservations_no_overlap`
   protects **our** rows only, so it will happily seat two parties at one table and report
   success to both. Integration is explicitly out of scope (CLAUDE.md), so there are exactly
   two acceptable outcomes before Mazcina takes a real call: OpenTable is switched off, or
   the venue accepts the double-booking risk **in writing**.

   Until then Mazcina stays `onboarding_status = 'provisioning'` and staging-only, so the
   collision cannot happen during this work. Also recorded in `venue-onboarding.md` §5 as a
   step for every venue, because Mazcina will not be the last one already using something.

   Minor, related: our alternative-time suggestions step ±30/60/90/120 minutes
   (`suggestionOffsets` in `availabilityService.ts`) while OpenTable offers 15. An exactly
   requested time is always honoured, so this is a coarser *fallback*, not a wrong answer —
   it is why Bella offers 12:30 where OpenTable would offer 12:15.
2. **They do serve alcohol** — reviews single out "the pisco sour and the fruity wine jugs".
   The food-only PDF made the licensed-item path look academic; it is not. The bar list is a
   real dependency for leg 4, not a nice-to-have.
3. **Closed Tuesday and Wednesday.** Worth an explicit call-battery leg: ask for a Tuesday
   booking and confirm Bella declines and offers Thursday, rather than booking into a closed
   day. Nothing in the automated suite covers a fully-closed weekday.

## Known gaps this surfaces

- **No dietary or allergen modelling exists** anywhere in the schema. Mazcina tags nearly
  every item GF/DF/VG/VGN, and "is it gluten free?" is a routine question on a booking line.
  The import folds the tags into each item's `description` as plain sentences, which is the
  only reason Bella can answer at all. Model it properly before production.
- **No surcharge modelling.** The menu prints a **10% Sunday** and **15% public-holiday**
  surcharge; every price is a flat `base_price_cents`, so Bella quotes base prices on a
  Sunday. Not a staging blocker; a real wrongness before Mazcina takes live weekend orders.
- **The KDS reaches no environment through a pipeline.** Leg 2 of the battery needs it.
