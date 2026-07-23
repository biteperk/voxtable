# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

**VoxTable** is a voice-AI booking platform for restaurants, built by **Biteperk Pty Ltd** (public brand site: `biteperk.com.au`). *(Product brand renamed VocoTable → PerkTable → **VoxTable**; the lowercase `vocotable` infra identity — subdomain, Firebase project id `vocotable`/`vocotable-497209`, `vocotable_number` API field, event/storage keys — is deliberately retained until a DNS migration. The VoxTable rename **shipped 22 July 2026**, after trademark clearance, alongside the Vox rename on biteperk.com.au. Pushing to `main` auto-deploys via two GitHub Actions — `deploy-frontend.yml` (paths `apps/frontend/**`, `apps/kds/**`, `firebase.json`, `.firebaserc`, `package*.json`) and `deploy-backend.yml` (paths `apps/backend/**`, `package*.json`, `Dockerfile`, `docker-compose*.yml`) — so a change touching only one side deploys only that side.)* The original MVP target is **Natalia's Bistro** in Sydney. Customer dials a Twilio AU number, Retell AI's voice agent ("Bella") takes the booking, the backend writes it to Postgres, and the React dashboard renders calls + reservations live. Multi-tenant self-serve onboarding (Phases 0–5: create restaurant → profile → menu → trial → phone) is merged behind kill-switch flags. The original build plan lives in [`plan-phases/`](plan-phases/) (historical); the up-to-date architecture docs are in Confluence (Vocotable space) — `apps/backend/docs/architecture_diagram.md` is stale (see its banner).

## Commands

```bash
# First-time setup
npm install
cp .env.example .env                    # then fill real Retell/Twilio creds
npm run db:migrate                      # applies anything new in apps/backend/db/migrations/
npm run db:seed                         # idempotent — seeds Natalia's Bistro restaurant + tables

# Local dev
npm run dev:backend                     # tsx watch on apps/backend/src/server.ts (port 3050)
npm run dev:frontend                    # vite dev server (port 3051)
npm run dev:kds                         # kitchen display app (separate Vite app)
npm run check                           # tsc backend + vite build frontend + kds — no tests, this is the CI gate

# Smoke tests (no automated test suite by design — see plan-phases speed levers)
npm run smoke:backend                   # full lifecycle: health → availability → create → update → cancel
npm run smoke:retell                    # exercises /retell/inbound, /retell/webhook, /retell/tools/*
npm run smoke:twilio                    # exercises /twilio/voice, /twilio/status
npm run smoke:calcom                    # Cal.com outbox/inbox mirror
npm run smoke:orders                    # menu + order endpoints (KDS)
npm run smoke:isolation                 # multi-tenant onboarding isolation
# also: smoke:retell-signed, smoke:retell-dates, smoke:retell-orders

# Production builds (used inside the Dockerfile)
npm run build:backend                   # tsc → apps/backend/dist
npm run build:frontend                  # vite build → apps/frontend/dist
npm run build:kds                       # vite build → KDS dist
npm run start:backend                   # node apps/backend/dist/server.js
npm run db:migrate:prod                 # node ... migrate.js (pre-built JS)
```

To exercise a single integration without a real phone call, hit the routes directly with `curl` — e.g. `curl -X POST localhost:3050/availability/check -d '{"date":"2026-06-01","time":"19:00","party_size":4}' -H 'Content-Type: application/json'`. The `/retell/*` and `/twilio/*` paths require HMAC signatures in production (`RETELL_VERIFY_SIGNATURE=true`, `TWILIO_VALIDATE_SIGNATURE=true`); leave both `false` in dev or use the smoke scripts.

## Architecture

### Call lifecycle (the only flow that matters)

1. Caller dials the AU number → **Twilio** receives it.
2. Twilio's SIP trunk `algorythmos` forwards to `sip.retellai.com`. The trunk's Termination URI is set in the Twilio console, not in this repo.
3. **Retell** matches the called number to the registered `Natalia's Bistro` agent (`inbound_agent_id` on the phone number, set via Retell API). Dynamic variables (`today`, `tomorrow`, `restaurant_name`, etc.) come from the LLM's `default_dynamic_variables` — **not** from our `/retell/inbound` webhook, which only fires when the phone number is registered with a webhook URL rather than a static `inbound_agent_id`.
4. The Retell LLM (GPT-4.1, single-prompt, voice 11labs-Anna en-AU) calls our **custom function** endpoints at `/retell/tools/check-availability` and `/retell/tools/create-booking`. These return snake_case JSON the LLM can read out (`confirmation_message`, `natural_alternatives_message`).
5. Retell sends lifecycle events to **`/retell/webhook`** (signed). Final `call_analyzed` event includes `call_analysis.custom_analysis_data.{intent, booking_outcome, special_requests, caller_satisfied}` — the keys are configured on the agent via `post_call_analysis_data`.
6. `apps/backend/src/services/retellService.ts::persistRetellCall` extracts those fields and upserts into `call_logs` (unique on `(provider, provider_call_id)`).
7. The React dashboard (Firebase Hosting `vocotable.web.app`; public brand site `biteperk.com.au`) fetches from `/api/reservations`, `/api/call-logs`, `/api/analytics` (all Firebase-ID-token-gated) and renders.

### Cal.com mirror (durable outbox + inbox)

Bookings created by the voice path are mirrored to Cal.com asynchronously — the voice path **never blocks on Cal.com**. The pattern:

- `bookingService.createBooking` enqueues an `outbox_calcom` row in the same DB txn as the reservation insert. If Cal.com is down, the booking still lands in Postgres and the caller hears a confirmation.
- `workers/calcomOutboxWorker.ts` ticks every 2 s, pulls due rows, posts to Cal.com v2 with an `Idempotency-Key` header (the outbox row UUID), and updates `succeeded_at` / `next_attempt_at` with exponential backoff. Errors classified as transient retry; permanent ones short-circuit. A circuit breaker in `services/calcomClient.ts` trips after consecutive failures.
- Inbound Cal.com webhooks land at `POST /cal/webhook` (HMAC + 5-min replay window), dedupe via `inbox_calcom_events`, and reconcile back into `reservations` (loop guard: skip events whose `metadata.vocotable_source = "voice"`).
- Kill switch: `CALCOM_SYNC_ENABLED=false` disables the outbox executor AND `/cal/webhook` (returns 410). Voice path keeps working. Health endpoint: `GET /api/ops/calcom-health` returns outbox depth, breaker state, voice_today, and quota.

### Backend layout — what reads which

- `routes/` thin handlers; signature middleware is scoped per-router (`retellRouter.use("/retell", …)`) — **don't drop the path prefix**, doing so applies the signature check app-wide and breaks every other endpoint.
- `services/` business logic. `bookingService.createBooking` is the canonical example of the transactional pattern: per-slot advisory lock (`hashtextextended('restaurant:date:time', 0)`), re-check availability inside the locked txn, insert, then attach to the call_log. A partial `UNIQUE INDEX idx_reservations_no_double_book` is the DB-level safety net.
- **Multi-statement writes go through `withTransaction(async (client) => …)`** from `db/pool.ts`. Never juggle two pool connections for a single logical write — `modifyBooking`, `cancelBooking`, and the outbox executor all follow this pattern. Repositories accept an optional `DbClient` so they can join the caller's txn.
- `repositories/` raw SQL. Pool config (max 20, statement_timeout 15s, query_timeout 15s) is in `db/pool.ts` — the small default would starve under sustained call load. `db/pool.ts` also pins the pg type parser for `DATE` (OID 1082) to return strings, not JS `Date` — otherwise outbox payloads serialise weirdly.
- **All logging goes through `utils/logger.ts`** — structured JSON, AsyncLocalStorage-propagated `request_id` (via `http/requestLogger.ts`), and key/value PII redaction (`cal_live_*`, `Bearer …`, E.164 phones). Never `console.error(err)` directly; use `logger.error({ error })` so `sanitiseError` strips headers/secrets before they hit stdout.
- **Every external payload is Zod-validated at the boundary.** Retell tool args use `http/schemas.ts` (`modifyBookingRequestSchema`, etc.); Cal.com webhooks + create-booking responses use `services/calcomSchemas.ts`. Boot-time `verifyCalcomSchemasAgainstFixtures()` catches upstream schema drift before any traffic hits.
- `auth/firebaseAuth.ts` lazy-initialises Firebase Admin SDK from `GOOGLE_APPLICATION_CREDENTIALS`. Dashboard endpoints (`dashboardRouter`) require `Bearer <Firebase ID token>`; webhook endpoints use HMAC instead.
- `utils/time.ts` exposes TZ-aware date helpers (`todayInTz`, `tomorrowInTz`, `zonedWallClockToUtcISO`, `utcIsoToZonedWallClock`). The Retell agent's `default_dynamic_variables.{today, tomorrow}` need to be refreshed daily — currently a manual `PATCH /update-retell-llm` (no cron yet).
- `utils/phone.ts` normalises caller-supplied phones to E.164 via `libphonenumber-js`. Returns null for `anonymous`/`unknown`/`private`/`blocked`/`restricted`.
- `workers/` — `calcomOutboxWorker` (2 s tick), `healthAlerter` (Slack on outbox depth / breaker open / inbox failures / Cal.com daily quota), `cleanupWorker` (6 h tick, deletes outbox + inbox rows older than 30 days), plus onboarding workers `menuOcrWorker`, `notificationWorker`, and `provisioningWorker` (each a no-op unless its kill-switch flag is on). Leased job claims (`menu_ingestion_jobs`, `provisioning_jobs`) include a 10-min stuck-`processing` reaper so a crash mid-tick can't orphan a job.

### Tenancy: dashboard is multi-tenant, voice path is not (yet)

- **Dashboard/API**: fully tenant-scoped. `auth/tenantContext.ts` validates the `X-Restaurant-Id` header against the user's memberships (`resolveTenant` → 403 `NOT_A_MEMBER` on mismatch); all dashboard/menu/orders/billing routes chain `requireFirebaseAuth → resolveTenant → requireMemberRole(...)`.
- **Voice path**: `normalizeRestaurantId()` in `http/schemas.ts` and the Retell/Twilio handlers **ignore caller-supplied `restaurant_id`** and hard-bind `env.DEFAULT_RESTAURANT_ID`. Intentional — removes a category of "AI tricked into booking elsewhere" attacks. Inbound phone-number → restaurant routing is the missing piece before voice goes multi-tenant.
- **Onboarding Phases 0–5** (routes `onboarding.ts`/`restaurant.ts`/`me.ts`/`admin.ts`/`billing.ts`/`stripeWebhook.ts`, workers `menuOcrWorker`/`notificationWorker`/`provisioningWorker`) ship behind kill-switch flags that all default `false`: `STRIPE_BILLING_ENABLED`, `MENU_OCR_ENABLED`, `NOTIFICATIONS_ENABLED`, `PROVISIONING_AUTO_ENABLED`, `MULTITENANCY_LEGACY_FALLBACK`. Production `superRefine` in `config/env.ts` only demands the matching credentials once a flag is on. Local development has explicit non-production checkout/provisioning shortcuts when Stripe or automatic provisioning are disabled; those branches must stay gated by `env.APP_ENV !== "production"`.

### Frontend layout

`apps/frontend/src/main.jsx` is the SPA bootstrap + path-based router (no react-router) — the pages live under `src/pages/{landing,auth,dashboard,billing,onboarding}` with shared `components/`, `features/`, `hooks/`, and `lib/`. Routes: `/` (public landing), `/invite`, `/live-feed[/:id]`, `/live-tables[/:id]`, `/booking-log`, `/manage-menu`, `/kitchen-overview`, `/analytics`, `/billing`, `/manage-plan`, `/update-payment-details`, `/profile`, and `/onboarding` (wizard: CreateRestaurant → Profile → Menu → Trial → Phone steps in `pages/onboarding/steps/`). Dashboard routes are gated by `AuthProvider` + an onboarding gate in `AppRouter` (incomplete tenants are redirected to `/onboarding`; `/manage-menu` is reachable during onboarding). The wizard dispatches `vocotable:onboarding-status-changed` so the top-level gate updates immediately when onboarding advances. `api.js` attaches the Firebase ID token as Bearer, force-refreshes on 401 (single retry), and sends `X-Restaurant-Id` from the persisted active-restaurant selection (a selector only — the backend enforces membership). `firebase.js` tries `signInWithPopup` then falls back to `signInWithRedirect` if extensions block the popup network call. `apps/kds/` is a separate Vite app (kitchen display) that polls the backend.

## Database

Custom migration runner — **not Knex/Prisma**. `apps/backend/src/db/migrate.ts` reads `apps/backend/db/migrations/*.sql` in lexical order and records applied files in `schema_migrations`. Each migration runs in one `client.query(sql)` call, so **multi-statement DDL with `GENERATED ALWAYS AS` expressions can trip node-pg with error `08P01` (invalid message format)** — when that happens, apply the SQL via `psql -f` directly and `INSERT INTO schema_migrations (filename) VALUES (…)` manually. Migration `003` hit this; it's now applied but worth knowing for future migrations.

Schema is in `001_initial_schema.sql`. The interesting columns added in `003`:
- `call_logs.intent`, `booking_outcome`, `user_sentiment`, `in_voicemail`, `call_successful`, `special_requests`, `analysis_json` (JSONB), `duration_seconds` (GENERATED).
- `reservations` partial UNIQUE INDEX preventing double-booking at the same `(table_id, date, start_time)` for non-cancelled rows.

Dates are TZ-naive `DATE` + `TIME` (correct — they're wall-clock at the restaurant). Lifecycle timestamps are `TIMESTAMPTZ`. The restaurant's TZ comes from `restaurants.timezone` (memoized in `repositories/restaurants.ts`).

## Deployment

- **Backend**: GCP VM `core-central-vm` (project `vocotable-497209`, static IP `136.113.35.88`) running `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. The `prod` override mounts `/opt/vocotable/firebase-admin.json` → `/secrets/firebase-admin.json` (read-only) and sets `GOOGLE_APPLICATION_CREDENTIALS`. The base compose stays Firebase-Admin-free so local dev doesn't need a service-account JSON.
- **TLS** via nginx + certbot at `https://vocotable.algorythmos.com.au`. Nginx config is in `deploy/nginx/vocotable.conf` — rate limits at the top-level `http {}` scope (already correct), raw body buffering on webhook paths for signature verification.
- **Frontend** on Firebase Hosting target `app` (`vocotable.web.app`). Build with `VITE_API_BASE_URL=https://vocotable.algorythmos.com.au` before `firebase deploy --only hosting:app`. KDS is the separate Firebase Hosting target `kds`.
- **DNS** managed in Cloudflare under `algorythmos.com.au`. The `vocotable` A record must be **DNS-only (gray cloud)** — orange-cloud proxying breaks Let's Encrypt HTTP-01 and Retell/Twilio signature URLs.
- **Retell config snapshots** for rollback are kept in `deploy/retell-snapshots/<timestamp>-<reason>/{llm.json,agent.json}`. Re-apply via `PATCH /update-retell-llm/{llm_id}` and `/update-agent/{agent_id}`.
- **Failure-mode runbooks** live in `deploy/runbooks/` — `rollback.md` for image-crash / Cal.com misbehaving / migration-breaks-reads recovery (target ≤5 min revert), `backup-restore.md` for pg_dump verification + restore drills.
- **Cal.com-specific env vars** (required in prod when `CALCOM_SYNC_ENABLED=true`): `CALCOM_BASE_URL`, `CALCOM_API_KEY`, `CALCOM_WEBHOOK_SECRET`, `CALCOM_EVENT_TYPE_ID`, `CALCOM_OUTBOX_MAX_ATTEMPTS`, `CALCOM_REQUEST_TIMEOUT_MS`, `CALCOM_DAILY_QUOTA_THRESHOLD`. Slack alerting: `OPS_SLACK_WEBHOOK_URL`. See `.env.example` for the full list.

## Collaboration

Sam is currently the only person working on the repo (the former intern, Ali Ümit ALGAN, finished his internship in July 2026 — his remote `feature/*` branches may still hold unmerged work). Standard hygiene before any backend deploy:

1. `git fetch origin && git log --oneline origin/main -5` — confirm main is where you expect.
2. SSH the VM (`gcloud compute ssh core-central-vm --zone us-central1-a`) and `git -C /opt/vocotable status` — files there may be root-owned; `sudo tar --overwrite` is the safe way to push code without trampling.

## Hard rules of thumb

- The MVP plan (see `plan-phases/00-overview.md`) explicitly says **no automated tests, manual smoke tests only**. Stick to that; don't add Jest unless a paying customer is asking for stability.
- Stay in-scope: no multilingual, no outbound calling, no loyalty, no mobile, no ResDiary/OpenTable integration. Multi-tenant onboarding exists but stays behind its kill-switch flags until deliberately rolled out (see `deploy/runbooks/onboarding-rollout.md`).
- Dashboard auth is locked to an **email allowlist** (`DASHBOARD_ALLOWED_EMAILS`), enforced in `auth/firebaseAuth.ts` — a verified account whose email isn't listed gets `403 EMAIL_NOT_ALLOWLISTED` on every dashboard route. Editing the list is an env change, no code. Empty list = open to any verified Google account (dev only; prod env validation forbids the empty case via `env.ts` superRefine).
