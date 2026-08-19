# Venue onboarding — the repeatable checklist

How a real restaurant gets onto VoxTable (+ VoxOrder) today, distilled from the
Cuban Corner install (13 Aug 2026). This is the **manual** path;
`provisioningWorker` automates buy-number → create-agent → bind when
`PROVISIONING_AUTO_ENABLED` is on, but every step below still describes what
must exist and why.

**The operating model, so nobody reinvents it per venue:** one shared
platform — a tenant is *data*, never infrastructure. No per-venue GCP
projects, repos, or branches. The `restaurants` row is the registry; every
vendor resource hangs off it (`twilio_phone_number`, `retell_agent_id`,
`stripe_customer_id`, `stripe_connect_account_id`). Naming conventions live in
NAMES.md §per-venue resources.

## 0. Before anything: the two slow vendors

- **Twilio number.** An AU number cannot be bought without an approved
  Regulatory Bundle matching country AND type. **Approval is fast if the account
  already has a verified customer profile** (instant, observed 13 Aug 2026) or if
  you clone an approved bundle from another account in the org (instant, no
  review queue); it is ~1–3 days only when building a bundle from documents on an
  account with no profile. Voice-only venues need a **Local** number ($3/mo, needs
  an AU address record); SMS needs **Mobile** ($8.25/mo — the only AU type doing
  voice *and* SMS). Check the bundle BEFORE promising a go-live date.
  Friendly-name the number `voxtable: <venue-slug> <uuid8>`.
  ⚠️ **Before the first auto-provisioned venue**, settle the Direct Customer vs
  ISV/Reseller question — per-venue numbers may need per-venue End User objects,
  in which case bundle cloning does not help. See
  [`twilio-account-topology.md`](twilio-account-topology.md).
- **Terms.** The agreement documents live in a versioned GCS bucket published
  by `publish-legal-documents.yml`; the wizard reads `current/manifest.json`
  and the backend verifies every acceptance against the same manifest
  (`LEGAL_DOCUMENTS_MANIFEST_URL` — mismatch 409, unreachable 503). While the
  published set is still `SAMPLE-*`, acceptance is refused unless
  `TERMS_ALLOW_UNPUBLISHED_DOCS=true` (staging only) — commercial terms are
  handled on paper/email until the real CSA publishes (#164). Track the
  acceptance backfill for paper/email venues (no route writes
  `channel='offline'` rows yet).

## 1. Retell agent — one agent AND one LLM per venue

⚠️ Traps, all proven the hard way:

1. **Never "clone" with `agent.create({response_engine: template.response_engine})`**
   — that copies the LLM **by reference**: the new agent shares the template's
   LLM, and editing "its" prompt rewrites every other venue's live agent.
   Create a **new LLM** (`POST /create-retell-llm`) and point the new agent at
   that id. Verify afterwards that the two agents hold different `llm_id`s.
2. **Build from the LIVE config, never from a snapshot.** Snapshots drift —
   the live greeting carries the AI + recording disclosure that no committed
   snapshot had, so a snapshot rebuild would silently strip a legal
   disclosure off a customer-facing line. `GET /get-retell-llm/<id>` and
   `/get-agent/<id>` first, then diff.
3. **De-venue the prompt properly — the prompt must carry NO venue name at all.**
   Replacing the restaurant name is not enough: the live prompt also names the
   *owner* ("let me get Natalia to ring you back"). Use the dynamic variables
   instead — `{{restaurant_name}}` and `{{owner_name}}`, both injected fresh per
   call by `/retell/inbound` — in the system prompt, the greeting AND the
   callback line. Assert on the finished payload that no previous venue's name
   survives anywhere.

   This is the 18 Aug 2026 failure. The staging venue was bound to Natalia's
   staging agent; the number resolved to the right venue and the webhook sent
   the right `restaurant_name`, and the caller was still greeted with "Natalia's
   Bistro" because the greeting ignored the variable and said it in prose. A
   parameterised prompt cannot fail that way: a mis-bind then produces a
   wrong-but-generic call instead of a confident lie.

   `createVenueLlm` now refuses a template whose prompt has no
   `{{restaurant_name}}` placeholder, so auto-provisioning cannot clone a
   venue-specific prompt.

   The prompt is not the only place a venue name hides: **`boosted_keywords` on
   the agent** carries the venue's name and its menu vocabulary for the STT.
   A clone inherits the previous venue's list, which both leaks the name and
   mis-biases transcription toward the wrong menu. Rewrite it per venue: the
   venue's own name plus the dishes a caller will actually say (found on
   Mazcina 19 Aug 2026 — the clone still boosted "Natalia's Bistro" and
   "fish and chips").
3b. **Every functional tool needs `speak_after_execution: true`.** With `false`,
   no LLM generation is triggered when a tool result arrives — the agent holds
   the answer silently unless its own turn happens to still be open, which
   turns "let me check the menu…" into 18 seconds of dead air and a hangup
   (observed live, 19 Aug 2026: backend answered in 95 ms; the agent never
   spoke it; identical durations on back-to-back calls because callers give up
   at the same point). Both existing workspaces were built with `false`, so
   **any agent built by copying inherits the dead air** — assert the flag on
   every functional tool after building, and leave it `false` only on tools
   whose result genuinely needs no spoken reply. The staging LLMs were fixed
   19 Aug 2026; ⚠️ **the live pilot LLM (`llm_2cad4da6…`, Algorythmos
   workspace) still carries `false` everywhere** — fix at the production
   cutover, not before (it is another company's workspace).
4. **Leave `default_dynamic_variables` empty.** Production has no worker that
   refreshes them (`RETELL_LLM_ID` is unreferenced on `main`), so anything set
   there is frozen forever and surfaces only when the inbound webhook fails —
   i.e. it greets the caller with the wrong venue name and stale dates at
   exactly the worst moment.

Also: set `webhook_url` (`<api>/retell/webhook`) explicitly (API-created agents
don't inherit it), name it `"<Venue> (VoxTable)"`, carry `data_storage_setting`,
`data_storage_retention_days` and `pii_config` across deliberately (they are
part of our data-handling posture, not defaults to inherit), and snapshot
before/after to `deploy/retell-snapshots/`.

Fields that no longer exist and must not be copied from old snapshots:
`normalize_for_speech`, and the deprecated single-agent phone field
`inbound_agent_id` (removed 31 Mar 2026 in favour of weighted `inbound_agents`).

Prompt content per venue: the licensed-drinks refusal, function enquiries →
take a message, AI + recording disclosure. Add pickup-order guidance (name +
time) **only once the backend serving that venue actually supports orders
without a booking** — on a backend that still enforces `ORDER_REQUIRES_BOOKING`,
Bella would take a full takeaway order and then apologise.

## 2. Phone number wiring

Proven pattern (same as the first venue): number → Elastic SIP trunk →
`sip.retellai.com`, then import the number to Retell:

- `termination_uri`: `<trunk>.pstn.twilio.com`
- `inbound_agents`: `[{agent_id: <venue agent>, weight: 1}]`
- `inbound_webhook_url`: `<api>/retell/inbound` — **webhook mode, not a static
  agent binding**: one webhook serves every venue (tenant resolved from the
  dialled number, `override_agent_id` + fresh per-call dynamic variables
  returned). A static binding silently reverts to single-tenant defaults.

The venue itself just forwards its existing line to the new number — nothing
installs on site, and turning the forward off restores the old world.

## 3. The database row (the registry entry)

Template: `deploy/seeds/synthetic_test_restaurants.sql` (fixed UUID,
`ON CONFLICT DO NOTHING`, prod-safe). Insert:

- `restaurants`: name, `timezone`, the venue's existing public number as
  profile phone, `onboarding_status = 'provisioning'` (direct SQL legitimately
  bypasses the wizard's event state machine), **`contact_email = NULL` until
  setup is done** — that cleanly suppresses the `number_ready`/`live` emails
  firing mid-install.
- `restaurant_settings`: real opening hours, booking duration.
- `tables`: the real floor (confirm count/capacities with the venue).
- `restaurant_members`: an owner row admits a signed-in user to the dashboard
  **without any env change** (membership passes the allowlist check); the
  `DASHBOARD_ALLOWED_EMAILS` edit + container recreate is the fallback.

## 4. Menu

`npm run menu:import` (`apps/backend/scripts/import-menu.ts`) with the venue's
menu JSON: `--dry-run` first, review the report (renamed duplicates, dropped
duplicate modifiers, clamped groups, windowed/restricted counts), then run
for real. `--emit-sql` produces an insert-if-absent SQL file for hosts only
psql reaches. Re-running is safe: upserts, never delete-and-recreate.

Windows (`available_from/until`) and `is_restricted` come from the import;
Bella enforces both on the voice path only.

## 5. Bindings → rehearsal → go-live

1. `PATCH /api/admin/restaurants/:id/provisioning` with `twilio_phone_number`
   (the trusted dialled-number key, E.164-normalised) and `retell_agent_id`.
   **Both together — the endpoint now rejects one without the other**, because
   the UPDATE is COALESCE-only and a lone number kept the *previous* venue's
   agent. The endpoint also verifies the agent against Retell before storing it:
   `409 RETELL_AGENT_NOT_FOUND` if it does not exist, `409
   RETELL_AGENT_ALREADY_BOUND` if another venue holds it (migration 034 makes
   that impossible at the database too), and `409 RETELL_AGENT_VENUE_MISMATCH`
   if its `agent_name` names a different venue — override that last one with
   `?allow_name_mismatch=true`, which is recorded in `admin_actions`.
2. ⚠️ **Confirm no other booking system writes to these tables.** Mazcina was
   already live on OpenTable when we started onboarding it — real inventory,
   real bookings. Two systems booking the same floor cannot see each other:
   migration 025's `reservations_no_overlap` protects OUR rows only, so it will
   seat two parties at one table and report success. Integration is out of scope,
   so there are exactly two acceptable outcomes: the other system is switched
   off, or the venue accepts the double-booking risk **in writing**. Check this
   before the rehearsal call, not after.
3. **Dress-rehearsal call** — the go/no-go gate: **Bella names THIS venue**,
   disclosure heard, booking lands on the dashboard mid-call, menu question
   answered, pickup order hits the KDS, a licensed drink is refused with the
   licensing line. The venue name is first on that list deliberately: every
   other item can pass while the caller is told they have reached somewhere
   else.
4. `POST /api/admin/restaurants/:id/go-live`.
5. Backfill `contact_email`; Stripe checkout with the owner (trial days per
   `STRIPE_TRIAL_DAYS`; checkout is safe from `provisioning`/`live` status).

## 5b. If the venue already uses another booking platform

Mazcina was live on OpenTable before we started, and this will not be the last venue that
arrives already using something. Two systems booking one floor cannot see each other:
migration 025's `reservations_no_overlap` protects **our** rows only, so two parties can be
seated at one table with both systems reporting success.

Three outcomes, and only these three:

1. **The other system is switched off** at go-live. Cleanest; a commercial conversation.
2. **Inventory is split** — a disjoint subset of tables per system, via the `is_active` flag
   that already exists. Collision becomes structurally impossible with no integration, at the
   cost of some of Bella's inventory.
3. **The risk is accepted in writing by the venue**, recorded with a date. Only defensible at
   low volume, and it must be their decision, not ours.

**The OpenTable Partner API would solve it properly** — OAuth2 with a sandbox, covering
availability, **slot locks**, create/modify/cancel, guest records, webhooks and partner sync
feeds. Two-way, so it prevents collisions rather than reporting them. Access is the obstacle,
not capability: no self-serve signup and no public developer portal — you apply, present a
business case, and sign a commercial agreement before documentation is shared. Partners are
either restaurant-side software (POS, guest management) or booking partners (established
consumer apps); "data-only use cases generally don't qualify".

**Apply as restaurant-side software, with the venue sponsoring.** That framing is honest:
VoxTable answers the venue's phone, it is not a consumer marketplace competing for diners.
Treat it as a BD track measured in weeks-to-months, not sprint work.

⚠️ Do **not** substitute the third-party OpenTable data APIs that surface in search results.
They are read-only and unofficial, and without slot lock they cannot prevent a collision —
which is the only thing that would matter.

## 6. After the install

- Record the venue's vendor identifiers ONLY in the `restaurants` row (and
  `deploy/runbooks/vendor-accounts.local.md` for account-level logins).
- Customer collateral (menu exports, talk tracks, account plans) goes to the
  private customers repo / Drive — never this repo (`.gitignore` blocks the
  per-venue folders).
- New naming? Extend NAMES.md in the same PR.
