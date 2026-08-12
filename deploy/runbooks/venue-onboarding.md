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
  Regulatory Bundle matching country AND type (~3 business days to approve).
  Voice-only venues need a **Local** number ($3/mo, needs an AU address
  record); SMS needs **Mobile** ($8.25/mo). Check the bundle BEFORE promising
  a go-live date. Friendly-name the number `voxtable: <venue-slug> <uuid8>`.
- **Terms.** While `TERMS_DOCUMENT_SET_VERSION=DRAFT`, the API agreement step
  refuses in production — commercial terms are handled on paper/email until
  the versioned CSA publishes. Track the acceptance backfill.

## 1. Retell agent — one agent AND one LLM per venue

⚠️ Two traps, both proven the hard way:

1. **Never "clone" with `agent.create({response_engine: template.response_engine})`**
   — that copies the LLM **by reference**: the new agent shares the template's
   LLM, and editing "its" prompt rewrites every other venue's live agent.
   In the Retell dashboard, duplicate the **agent AND the LLM**, then point
   the duplicate agent at the duplicate LLM.
2. **The prompt must not hard-code a venue name.** Use `{{restaurant_name}}`
   (injected per call by `/retell/inbound`) — the original prompt said
   "Natalia's Bistro" three times.

Also: confirm `webhook_url` (`<api>/retell/webhook`) is set on the new agent
(SDK-created agents don't inherit it), name it `"<Venue> (VoxTable)"`, and
snapshot before/after to `deploy/retell-snapshots/`.

Prompt content per venue: pickup-order guidance (name + time), the
licensed-drinks line (matches the API's `RESTRICTED_ITEM` refusal), function
enquiries → take a message, AI + recording disclosure.

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
2. **Dress-rehearsal call** — the go/no-go gate: disclosure heard, booking
   lands on the dashboard mid-call, menu question answered, pickup order hits
   the KDS, a licensed drink is refused with the licensing line.
3. `POST /api/admin/restaurants/:id/go-live`.
4. Backfill `contact_email`; Stripe checkout with the owner (trial days per
   `STRIPE_TRIAL_DAYS`; checkout is safe from `provisioning`/`live` status).

## 6. After the install

- Record the venue's vendor identifiers ONLY in the `restaurants` row (and
  `deploy/runbooks/vendor-accounts.local.md` for account-level logins).
- Customer collateral (menu exports, talk tracks, account plans) goes to the
  private customers repo / Drive — never this repo (`.gitignore` blocks the
  per-venue folders).
- New naming? Extend NAMES.md in the same PR.
