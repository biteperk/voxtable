# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

**VoxTable** is a voice-AI booking platform for restaurants, built by **Biteperk Pty Ltd** (public brand site: `biteperk.com.au`). *(Product brand renamed VocoTable → PerkTable → **VoxTable**; the lowercase `vocotable` infra identity — subdomain, Firebase project id `vocotable`/`vocotable-497209`, `vocotable_number` API field, event/storage keys — is deliberately retained until a DNS migration. The VoxTable rename **shipped 22 July 2026**, after trademark clearance, alongside the Vox rename on biteperk.com.au. **Branching changed on 1 Aug 2026 — read this before opening a PR.** The default branch is now **`integration`**, and that is where work merges. `integration` deploys to **staging**; `main` deploys to **production** and is reached by promoting `integration`, not by pushing to it. CI (`ci.yml`) runs on every branch and PR — builds, tests, scans and publishes images to `australia-southeast1-docker.pkg.dev/bp-shared-artifacts/voxtable/*` — and the deploy workflows only run on a *successful* CI run (`workflow_run`), so nothing reaches a server without passing CI first. **Merged no longer means live:** work in `integration` sits in staging until someone promotes it. The pipeline is Abhishek's (Jul–Aug 2026) and its deploy half is still being finished — see the Collaboration section for what is not wired up yet.)* The original MVP target is **Natalia's Bistro** in Sydney. Customer dials a Twilio AU number, Retell AI's voice agent ("Bella") takes the booking, the backend writes it to Postgres, and the React dashboard renders calls + reservations live. Multi-tenant self-serve onboarding (create restaurant → profile → **agreement** → menu → trial → phone) is merged behind kill-switch flags — the agreement step (rev. 29 Jul 2026) is the legal layer: Order-Form elections + three separate consents recorded in the append-only `agreement_acceptances` ledger. The backend runs as **two processes since 29 Jul 2026**: `server.ts` (api) and `worker.ts` (all background workers), built as separate images (`Dockerfile.api`, `Dockerfile.worker`) and separate compose services. The original build plan lives in [`plan-phases/`](plan-phases/) (historical); the up-to-date architecture docs are in Confluence (Vocotable space) — `apps/backend/docs/architecture_diagram.md` is stale (see its banner).

## Commands

```bash
# First-time setup
npm install
cp .env.example .env                    # then fill real Retell/Twilio creds
cp apps/frontend/.env.example apps/frontend/.env.local   # REQUIRED — Firebase config; the frontend build refuses to run without it
npm run db:migrate                      # applies anything new in apps/backend/db/migrations/
npm run db:seed                         # idempotent — seeds Natalia's Bistro restaurant + tables

# Local dev
npm run dev:backend                     # tsx watch on apps/backend/src/server.ts (port 3050, api only)
npm run dev:worker                      # tsx watch on apps/backend/src/worker.ts (background workers)
npm run dev:frontend                    # vite dev server (port 3051)
npm run dev:kds                         # kitchen display app (separate Vite app)
npm run check                           # tsc backend + DB-free unit tests + vite build frontend + kds — the CI gate

# Smoke tests (product behaviour is smoke-tested, not unit-tested — see the
# testing rule under "Hard rules of thumb")
npm run smoke:backend                   # full lifecycle: health → availability → create → update → cancel
npm run smoke:legal                     # legal layer: unskippable agreement step, consent/ABN refusals, append-only ledger trigger
npm run smoke:retell                    # exercises /retell/inbound, /retell/webhook, /retell/tools/*
npm run smoke:twilio                    # exercises /twilio/voice, /twilio/status
npm run smoke:calcom                    # Cal.com outbox/inbox mirror
npm run smoke:orders                    # menu + order endpoints (KDS)
npm run smoke:isolation                 # multi-tenant onboarding isolation
# also: smoke:retell-signed, smoke:retell-dates, smoke:retell-orders, test:backend

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
- `services/` business logic. `bookingService.createBooking` is the canonical example of the transactional pattern: per-slot advisory lock (`hashtextextended('restaurant:date:time', 0)`), re-check availability inside the locked txn, insert, then attach to the call_log. The DB-level guarantee is migration 025's `reservations_no_overlap` gist exclusion constraint (same `table_id` + overlapping booked `tsrange`, active rows only) — overlap is impossible regardless of lock behaviour; the older partial `UNIQUE INDEX idx_reservations_no_double_book` (exact start time) remains as a second belt.
- **Multi-statement writes go through `withTransaction(async (client) => …)`** from `db/pool.ts`. Never juggle two pool connections for a single logical write — `modifyBooking`, `cancelBooking`, and the outbox executor all follow this pattern. Repositories accept an optional `DbClient` so they can join the caller's txn.
- `repositories/` raw SQL. Pool config (max 20, statement_timeout 15s, query_timeout 15s) is in `db/pool.ts` — the small default would starve under sustained call load. `db/pool.ts` also pins the pg type parser for `DATE` (OID 1082) to return strings, not JS `Date` — otherwise outbox payloads serialise weirdly.
- **All logging goes through `utils/logger.ts`** — structured JSON, AsyncLocalStorage-propagated `request_id` (via `http/requestLogger.ts`), and key/value PII redaction (`cal_live_*`, `Bearer …`, E.164 phones). Never `console.error(err)` directly; use `logger.error({ error })` so `sanitiseError` strips headers/secrets before they hit stdout.
- **Every external payload is Zod-validated at the boundary.** Retell tool args use `http/schemas.ts` (`modifyBookingRequestSchema`, etc.); Cal.com webhooks + create-booking responses use `services/calcomSchemas.ts`. Boot-time `verifyCalcomSchemasAgainstFixtures()` catches upstream schema drift before any traffic hits.
- `auth/firebaseAuth.ts` lazy-initialises Firebase Admin SDK from `GOOGLE_APPLICATION_CREDENTIALS`. Dashboard endpoints (`dashboardRouter`) require `Bearer <Firebase ID token>`; webhook endpoints use HMAC instead.
- `utils/time.ts` exposes TZ-aware date helpers (`todayInTz`, `tomorrowInTz`, `zonedWallClockToUtcISO`, `utcIsoToZonedWallClock`). The Retell agent's `default_dynamic_variables.{today, tomorrow}` are refreshed by `workers/retellVariablesWorker.ts` (2 Aug 2026) — a deliberate no-op unless `RETELL_LLM_ID` **and** `RETELL_API_KEY` are both set, so set them in prod or you are back to the manual `PATCH /update-retell-llm`.
- `utils/phone.ts` normalises caller-supplied phones to E.164 via `libphonenumber-js`. Returns null for `anonymous`/`unknown`/`private`/`blocked`/`restricted`.
- `workers/` — `calcomOutboxWorker` (2 s tick), `healthAlerter` (Slack on outbox depth / breaker open / inbox failures / Cal.com daily quota), `cleanupWorker` (6 h tick, deletes outbox + inbox rows older than 30 days), plus onboarding workers `menuOcrWorker`, `notificationWorker`, and `provisioningWorker` (each a no-op unless its kill-switch flag is on), and `retellVariablesWorker` (keeps the agent's dates fresh — see above). Leased job claims (`menu_ingestion_jobs`, `provisioning_jobs`) include a 10-min stuck-`processing` reaper so a crash mid-tick can't orphan a job. The worker process also serves its own HTTP health surface — `/livez` (process alive, touches nothing), `/readyz` (DB reachable, 2 s deadline), `/workerz` (per-worker tick counts + last-tick age, recorded in `withTickLogContext`) — on `WORKER_HEALTH_PORT` locally (must differ from the api's `PORT` on a shared host) and on the injected `PORT` in Cloud Run, where it also satisfies the listen-on-`$PORT` requirement and holds the event loop open.

### Tenancy: dashboard is multi-tenant, voice path is not (yet)

- **Dashboard/API**: fully tenant-scoped. `auth/tenantContext.ts` validates the `X-Restaurant-Id` header against the user's memberships (`resolveTenant` → 403 `NOT_A_MEMBER` on mismatch); all dashboard/menu/orders/billing routes chain `requireFirebaseAuth → resolveTenant → requireMemberRole(...)`.
- **Voice path**: `normalizeRestaurantId()` in `http/schemas.ts` and the Retell/Twilio handlers **ignore caller-supplied `restaurant_id`** — removes a category of "AI tricked into booking elsewhere" attacks. Since 2 Aug 2026 both Retell and Twilio resolve the restaurant from the **dialled number** (`To`/`Called` → `getRestaurantIdByDialedNumber`) and fail closed in production; `env.DEFAULT_RESTAURANT_ID` remains only the dev fallback and the Cal.com web-booking default (there is one global `CALCOM_EVENT_TYPE_ID`, so today every web booking genuinely belongs to that restaurant — the condition that makes this a bug is commented in place in `calcomService.ts`).
- **Onboarding Phases 0–5** (routes `onboarding.ts`/`restaurant.ts`/`me.ts`/`admin.ts`/`billing.ts`/`stripeWebhook.ts`, workers `menuOcrWorker`/`notificationWorker`/`provisioningWorker`) ship behind kill-switch flags that all default `false`: `STRIPE_BILLING_ENABLED`, `MENU_OCR_ENABLED`, `NOTIFICATIONS_ENABLED`, `PROVISIONING_AUTO_ENABLED`. (`MULTITENANCY_LEGACY_FALLBACK` was removed 2 Aug 2026 by migration 027 — dashboard access is `restaurant_members` and nothing else, so granting someone access means inserting a row.) Production `superRefine` in `config/env.ts` only demands the matching credentials once a flag is on. Local development has explicit non-production checkout/provisioning shortcuts when Stripe or automatic provisioning are disabled; those branches must stay gated by `env.APP_ENV !== "production"`.

### Frontend layout

`apps/frontend/src/main.jsx` is the SPA bootstrap + path-based router (no react-router) — the pages live under `src/pages/{landing,auth,dashboard,billing,onboarding}` with shared `components/`, `features/`, `hooks/`, and `lib/`. Routes: `/` (public landing), `/invite`, `/live-feed[/:id]`, `/live-tables[/:id]`, `/booking-log`, `/manage-menu`, `/kitchen-overview`, `/analytics`, `/billing`, `/manage-plan`, `/update-payment-details`, `/profile`, and `/onboarding` (wizard: CreateRestaurant → Profile → Menu → Trial → Phone steps in `pages/onboarding/steps/`). Dashboard routes are gated by `AuthProvider` + an onboarding gate in `AppRouter` (incomplete tenants are redirected to `/onboarding`; `/manage-menu` is reachable during onboarding). The wizard dispatches `vocotable:onboarding-status-changed` so the top-level gate updates immediately when onboarding advances. `api.js` attaches the Firebase ID token as Bearer, force-refreshes on 401 (single retry), and sends `X-Restaurant-Id` from the persisted active-restaurant selection (a selector only — the backend enforces membership). `firebase.js` tries `signInWithPopup` then falls back to `signInWithRedirect` if extensions block the popup network call. `apps/kds/` is a separate Vite app (kitchen display) that polls the backend.

## Database

Custom migration runner — **not Knex/Prisma**. `apps/backend/src/db/migrate.ts` walks `apps/backend/db/migrations/**` recursively, orders by numeric filename prefix, and records applied files in `schema_migrations` (root files by bare filename — backward-compatible with the pre-existing ledger). Each migration runs in one `client.query(sql)` call, so **multi-statement DDL with `GENERATED ALWAYS AS` expressions can trip node-pg with error `08P01` (invalid message format)** — when that happens, apply the SQL via `psql -f` directly and `INSERT INTO schema_migrations (filename) VALUES (…)` manually. Migration `003` hit this; it's now applied but worth knowing for future migrations.

**The chain is append-only (001–029 as of 5 Aug 2026) and must stay that way** — production records applied filenames in `schema_migrations`. `apps/backend/db/baseline-sydney/` is a **parked** fresh-install schema (domain folders, separate Postgres schemas) for the planned Iowa→Sydney database migration; it is NOT walked by the runner and must never be applied to the live database (its tables would be created empty next to the real `public` ones — see its README and the 29 Jul 2026 merge `c3cf71a`). New schema for shipped code goes in a numbered migration, even if the baseline also has it — `020_table_attributes.sql` exists because the seating-preference code shipped reading a column only the baseline defined.

**Cloud Run deploys migrate first**: `deploy-backend.yml` (rewritten 4 Aug 2026) executes the Cloud Run job `voxtable-stg-migrate` — the new api image with `APP_ENV=migration`, running `dist/db/migrate.js` — and only rolls the api/worker services after it succeeds, so new code never serves against an old schema. **Migrations must run as `voxtable_owner`, never `postgres`**: migration 029's `ALTER DEFAULT PRIVILEGES` attaches to the executing role, so the wrong role silently strips future tables of `voxtable_app` grants. (029 splits owner/runtime roles and adds the `BEFORE TRUNCATE` guard on `agreement_acceptances`; it is a guarded no-op where the roles don't exist, i.e. CI and dev.) The **VM path — production until the Phase 3 cutover — still migrates after restart**: for a migration whose enum values/tables the NEW code references at startup or on a worker tick, pre-apply it via psql (expand-first) before promoting; the runner then skips it by filename and there is no schema/code race window.

Schema is in `001_initial_schema.sql`. The interesting columns added in `003`:
- `call_logs.intent`, `booking_outcome`, `user_sentiment`, `in_voicemail`, `call_successful`, `special_requests`, `analysis_json` (JSONB), `duration_seconds` (GENERATED).
- `reservations` partial UNIQUE INDEX preventing double-booking at the same `(table_id, date, start_time)` for non-cancelled rows — superseded as the primary guard by 025's duration-aware `reservations_no_overlap` exclusion constraint (both remain).

Dates are TZ-naive `DATE` + `TIME` (correct — they're wall-clock at the restaurant). Lifecycle timestamps are `TIMESTAMPTZ`. The restaurant's TZ comes from `restaurants.timezone` (memoized in `repositories/restaurants.ts`).

## Deployment

- **Staging (from 4 Aug 2026): Cloud Run in `bp-voxtable-stg`** (australia-southeast1) — services `voxtable-stg-api` / `voxtable-stg-worker`, Cloud SQL `voxtable-stg-postgres` (private VPC), migration job `voxtable-stg-migrate`. Every CI-green push to `integration` deploys automatically (`deploy-backend.yml` / `deploy-frontend.yml`, gated on a successful CI `workflow_run`). **Env config lives on the Cloud Run services** — the workflow only swaps `--image`; secrets come from Secret Manager in `bp-voxtable-stg`. The fail-closed env gate applies in full (staging runs `APP_ENV=production` posture): a service missing a required var exits with `Refusing to start` — read the revision logs, don't guess. Frontend/KDS: Firebase Hosting in `bp-voxtable-stg`. Deployment logic belongs **in the workflow jobs only** — no deploy scripts in the repo (review decision, PR #93).
- **Production backend (VM until the Phase 3 cutover)**: GCP VM `core-central-vm` (project `vocotable-497209`, static IP `136.113.35.88`) running **two containers since 29 Jul 2026** — `api` (`Dockerfile.api`, serves HTTP) and `worker` (`Dockerfile.worker`, all background workers) — via `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.deploy.yml up -d api worker`. CI builds/pushes both images to Artifact Registry (`…/vocotable/api`, `…/vocotable/worker`); the VM only pulls. The `prod` override mounts `/opt/vocotable/firebase-admin.json` → `/secrets/firebase-admin.json` (read-only) into both. The base compose stays Firebase-Admin-free so local dev doesn't need a service-account JSON. **The VM's git checkout has no GitHub credentials** (`git pull` fails) — compose/env file updates reach the VM by `gcloud compute scp`, not git; images are the only automated artefact.
- **DOMAIN MIGRATION IN FLIGHT (from 3 Aug 2026) — read `deploy/runbooks/domain-migration.md` before touching hostnames.** The customer-facing surfaces are moving to company-native names: API `vocotable.algorythmos.com.au` → **`api.biteperk.com.au`**, dashboard `vocotable.biteperk.com.au`/`vocotable.web.app` → **`app.biteperk.com.au`**, KDS → **`kds.biteperk.com.au`**. It is deliberately **additive** — old hostnames keep serving, vendors (Stripe → Cal.com → Retell → Twilio) cut over one at a time, each verified with a live test call, because Retell/Twilio signature verification is URL-sensitive. The `SYNTH_EMAIL_DOMAIN` (`bookings.vocotable.algorythmos.com.au`, `calcomService.ts`) must NOT change — it is baked into existing Cal.com bookings. The Firebase project id, Artifact Registry path and `vocotable_number` API field are explicitly out of scope.
- **TLS** via nginx + certbot. Nginx config is in `deploy/nginx/vocotable.conf` — it serves BOTH the new and legacy `server_name` from one cert (`--cert-name api.biteperk.com.au`); rate limits at the top-level `http {}` scope (already correct), raw body buffering on webhook paths for signature verification. *(Note: the repo config was stale at `api.vocotable.com` until 3 Aug 2026 — the VM was the source of truth. Keep them in sync now.)*
- **Frontend** on Firebase Hosting target `app`. Build with `VITE_API_BASE_URL` (a GitHub repo variable) before `firebase deploy --only hosting:app`. KDS is the separate Firebase Hosting target `kds`.
- **DNS** managed in Cloudflare — legacy records under `algorythmos.com.au`, new ones under `biteperk.com.au` (both zones live in the same personal Cloudflare account). Any A record fronting the API must be **DNS-only (gray cloud)** — orange-cloud proxying breaks Let's Encrypt HTTP-01 and Retell/Twilio signature URLs. Adding a hostname to Firebase Auth's **authorized domains** is required or Google sign-in breaks on it.
- **Retell config snapshots** for rollback are kept in `deploy/retell-snapshots/<timestamp>-<reason>/{llm.json,agent.json}`. Re-apply via `PATCH /update-retell-llm/{llm_id}` and `/update-agent/{agent_id}`.
- **Failure-mode runbooks** live in `deploy/runbooks/` — `rollback.md` for image-crash / Cal.com misbehaving / migration-breaks-reads recovery (target ≤5 min revert), `backup-restore.md` for pg_dump verification + restore drills.
- **Cal.com-specific env vars** (required in prod when `CALCOM_SYNC_ENABLED=true`): `CALCOM_BASE_URL`, `CALCOM_API_KEY`, `CALCOM_WEBHOOK_SECRET`, `CALCOM_EVENT_TYPE_ID`, `CALCOM_OUTBOX_MAX_ATTEMPTS`, `CALCOM_REQUEST_TIMEOUT_MS`, `CALCOM_DAILY_QUOTA_THRESHOLD`. Slack alerting: `OPS_SLACK_WEBHOOK_URL`. See `.env.example` for the full list.

## Collaboration

**Two people work on this repo: Sam and Abhishek Yadav** (`abhishekyadav01`, active since Jul 2026 — the dev-experience fixes, the api/worker split, Manage Tables, and the CI/deploy pipeline are his). The former intern, Ali Ümit ALGAN, finished in July 2026.

**Branch etiquette (from 1 Aug 2026):** open PRs against **`integration`**, never `main`. `main` is release-only and is reached by promoting `integration`. Remember Abhishek's branches may assume a fresh database (the split-services branch shipped a full migration rebaseline that had to be parked — see the Database section).

**Pipeline state — verified 5 Aug 2026.** The deploy half was rewritten 4 Aug (#94/#95): `deploy-backend.yml`/`deploy-frontend.yml` deploy `integration` → Cloud Run staging and `main` → Cloud Run production, both gated on a successful CI `workflow_run`; the backend job runs the migration job before rolling services. Current gaps:
- Staging api/worker **refuse to boot**: the services are missing `PUBLIC_API_BASE_URL`, `RETELL_AGENT_ID`, `TWILIO_PHONE_NUMBER` plus the `RETELL_API_KEY` / `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` secrets (Secret Manager holds only the DB secrets so far). Until they're set, every staging backend deploy fails its health check by design.
- **Promoting `main` targets Cloud Run production (`voxtable-prod-*`), which does not exist yet.** Until `bp-voxtable-prd` is provisioned, production is still the VM and is deployed manually — a `main` merge does NOT reach the VM on its own.
- The image registry (`bp-shared-artifacts`) and the frontend artifact bucket (`voxtable-frontend-artifacts`) live outside the `vocotable-497209` project and were **not readable by Sam's account** as of 1 Aug — worth resolving for auditability and bus factor.

Standard hygiene before any backend deploy:

1. `git fetch origin && git log --oneline origin/integration -5` — confirm `integration` is where you expect (use `origin/main` when checking what is actually in production).
2. SSH the VM (`gcloud compute ssh core-central-vm --zone us-central1-a`) and `git -C /opt/vocotable status` — files there may be root-owned; `sudo tar --overwrite` is the safe way to push code without trampling.

## Hard rules of thumb

- The MVP plan (see `plan-phases/00-overview.md`) says **product behaviour is smoke-tested, not unit-tested**. Amended 29 Jul 2026: DB-free `node:test` unit tests for pure plumbing (migration discovery, worker lifecycle) are allowed and run in `npm run check`; everything that touches the DB or an integration stays a smoke script (`smoke:*`). Still no Jest.
- Stay in-scope: no multilingual, no outbound calling, no loyalty, no mobile, no ResDiary/OpenTable integration. Multi-tenant onboarding exists but stays behind its kill-switch flags until deliberately rolled out (see `deploy/runbooks/onboarding-rollout.md`).
- Dashboard auth is locked to an **email allowlist** (`DASHBOARD_ALLOWED_EMAILS`), enforced in `auth/firebaseAuth.ts` — a verified account whose email isn't listed gets `403 EMAIL_NOT_ALLOWLISTED` on every dashboard route. Editing the list is an env change, no code. Empty list = open to any verified Google account (dev only; `env.ts` refuses to boot with an empty list on any non-localhost host).
- **`APP_ENV` is required with no default, and the three security gates — `DASHBOARD_VERIFY_AUTH`, `RETELL_VERIFY_SIGNATURE`, `TWILIO_VALIDATE_SIGNATURE` — default to `true`.** They may only be `false` while `PUBLIC_API_BASE_URL` is localhost; `env.ts` refuses to start otherwise, keyed on the URL rather than on `APP_ENV` (2 Aug 2026). Feature flags and kill-switches still default `false` — `boolFlag()` for those, `gateFlag()` for gates; don't mix them up.
