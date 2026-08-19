# CLAUDE.md

> 🏷️ **Naming anything — a hostname, GCP project, Cloud Run service, image, repo,
> env var, or product? Read [`NAMES.md`](NAMES.md) first.** It is the naming SSOT
> for the whole BitePerk/VoxTable estate (products, the `vocotable.*` →
> `*.biteperk.com.au` domain migration, the `bp-*` Terraform world, and the legacy
> identities that must NEVER rename). This file only narrates; when they disagree,
> NAMES.md wins.

> ☎️ **Touching a phone number — quoting one, wiring one, sending an SMS, testing a call,
> or saying a number "works"? Read [`NUMBERS.md`](NUMBERS.md) first.** It is the telephony
> inventory SSOT: **BitePerk owns exactly two numbers**, which Twilio account each sits on,
> what each can actually do today, and what is still unwired. Anything else you have seen
> called "the BitePerk number" is either marketing or another company's infrastructure —
> NUMBERS.md deliberately scopes those out, and wiring one is a mistake. The two we own are
> **not interchangeable**: one is staging-only and one is production. This file only
> narrates; when they disagree, NUMBERS.md wins.

> 🚦 **About to change anything outside your own machine — merge, deploy, click a vendor
> console, run SQL, buy a number? Read [Environments and promotion](#environments-and-promotion)
> below.** It is the SSOT for what "staging first" actually means here, which things
> genuinely **cannot** be rehearsed in staging, and the rules an agent must follow before
> touching a live account.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Environments and promotion

**The rule: prove it in staging, then repeat it in production.** The rest of this section
exists because that sentence is not self-executing — "promotion" means five different things
here, only one is automatic, and a few things cannot be rehearsed at all.

### A. What "promote" means, per plane

Most confusion comes from assuming a merge to `main` moves everything. It moves code.

| Plane | How it reaches production | Automatic? |
|---|---|---|
| Application code | merge `integration` → `main` | ✅ CI-gated |
| Container image | **rebuilt on `main` under a semver tag** — *not* the sha-tagged image staging proved | ⚠️ automatic but **not the same artifact** |
| Infrastructure | Terraform apply in `biteperk/biteperk-cloud-platform` | ❌ separate repo, manual |
| Database **schema** | migration job runs before services roll (staging); the VM migrates on restart | ⚠️ partly |
| Database **data** — venues, menus, bindings | inserted separately in each environment | ❌ **never promotes** |
| Retell / Twilio / Stripe config | repeated by hand in the other account | ❌ no promote exists |

Two consequences worth internalising. **Seeding a venue in staging does not create it in
production** — every venue is inserted twice, deliberately. And **production runs an image
staging never tested**: staging deploys `api:<sha>`, `main` rebuilds as `api:<version>`. Until
that is promotion-by-digest, "it passed staging" is a statement about the source, not the
artifact.

### B. Which environment am I touching?

| | Staging | Production |
|---|---|---|
| Branch | `integration` | `main` |
| GCP project | `bp-voxtable-stg` | `bp-voxtable-prod` — **an empty shell**, Cloud Run API not enabled |
| Backend runtime | Cloud Run (`voxtable-stg-api` / `-worker`) | **The VM** `core-central-vm`, `docker compose`, deployed by hand |
| API hostname | `voxtable-stg-api-…run.app` | `api.biteperk.com.au` (also `vocotable.algorythmos.com.au`) |
| Database | Cloud SQL `voxtable-stg-postgres`, private VPC | Postgres on the VM |
| Retell workspace | **Staging** | **Biteperk** (production) — see [`NAMES.md`](NAMES.md) §6 |
| Twilio account | `Biteperk-staging` | `Biteperk-production` — see [`NUMBERS.md`](NUMBERS.md) |
| Phone number | `+61 468 203 234` (bound and answering) | `+61 468 202 846` — ⚠️ **owned and Twilio-wired, but NOT live**: no Retell agent, no `restaurants` row, so a call reaches nothing. Production voice today is the pilot line `+61 2 7501 1140` on the suspended Algorythmos account. See [`NUMBERS.md`](NUMBERS.md) §2. |
| Stripe | test mode / sandbox | **live mode, same account** |

Vendor state (SIDs, balances, approval statuses) lives in `NUMBERS.md` and is deliberately
**not duplicated here** — copied state is stale state.

### C. What cannot be rehearsed in staging

This register is the honest part. Claiming universal staging coverage would contradict our own
runbooks, and an agent that believes the claim will take a risk it does not know it is taking.

| Cannot be staged | Why | Compensating control |
|---|---|---|
| Branded SMS (`BitePerk` sender ID) | Sender IDs are bound per Account SID with no clone API; a staging send reads `Unverified`, indistinguishable from a failed registration | `acma-sender-id-registration.md`; add staging's SID to the ticket, or don't test it there |
| Buying a phone number | One-way, and numbers are not reserved between selection and payment — two were lost mid-purchase | Buy from the unfiltered pool; never promise a specific number |
| Regulatory bundles / customer profiles | Account-scoped; approval latency differs by account | Repeat the exact field entry recorded in `twilio-account-topology.md` |
| Direct Customer vs ISV identity model | Explicitly "one of the few places where staging genuinely does not rehearse production" | Settle with Twilio **before** the first auto-provisioned venue |
| Natalia's number cutover | Deliberately production-first, **no rollback** | Prove the number against a *throwaway* `restaurants` row first — `NUMBERS.md` §8 |
| Stripe live mode | One account; no "send test event"; live Connect, payouts and refunds cannot be replayed | Sandbox proves the code path; live proves nothing until it runs |
| Append-only legal ledgers | `agreement_acceptances` has a `BEFORE TRUNCATE` guard (migration 029) | Rehearse on staging data only; production writes are permanent |
| The venue dress-rehearsal call | It is a production activity by definition — the venue's real line | It *is* the go/no-go gate; treat it as such |
| DNS, TLS, Cloudflare, Firebase authorized domains | Single-instance, no second copy to practise on | Additive changes only; rollback = point the vendor back |

### D. Rules for agents

Each of these is here because it went wrong, not because it might.

1. **Say which environment and account you are in** before any vendor console or API action.
2. **After copying config between environments, assert the other environment's identifiers
   appear nowhere in the result.** Do not trust the rewrite. Cloned staging agents once carried
   production URLs — a staging test call would have written real bookings.
3. **Match on unambiguous identifiers.** `vocotable` appears in every frontend bundle
   regardless of environment (legacy storage keys, NAMES.md §4), so it cannot prove which
   environment built it. Use the auth domain or the API host.
4. **Data does not promote.** Seeding staging changes nothing in production.
5. **Read config back from the API after writing it.** Never trust the write response.
6. **"Enabled" is not "works."** Only a real call, or a delivered message, proves a path.
   Both platform numbers report SMS enabled and neither has ever sent one.
7. **A number lives in exactly one Retell workspace**; importing is delete-then-import with a
   24–48h support ticket if it fails, and no way back.
8. **Never point a staging agent, webhook or build at a production hostname** — the reverse is
   equally true and less obvious.

### E. What is actually enforced

Convention that only lives in prose gets skipped. Enforced today (GitHub Team, since 13 Aug 2026):

- **`main` is protected** — PR required, force-push and deletion blocked, conversation
  resolution required, and CI's `Validate code and migrations` + `Build, scan, and publish
  Docker images` must pass. Those two are required precisely because they run on
  `pull_request`; `frontend-artifacts` does **not**, so requiring it would deadlock every PR.
- **The `production` environment only accepts deployments from `main`.** This closes a real
  hole: on 1 Aug, `integration` deployed to the production environment via `workflow_dispatch`.
- **CI refuses to build** if the environment it is running in has not defined its own frontend
  config, and **fails if the built bundle contains the other environment's identifiers.**

Deliberately **not** enabled: required reviewers on `production`. CI's `frontend-artifacts` job
declares `environment: production`, so a reviewer rule would pause CI itself — and with
`cancel-in-progress: true`, a parked run gets cancelled, `workflow_run.conclusion` becomes
`cancelled`, and both deploy workflows **skip silently**. Someone would approve a deploy that
never happened. Fix the concurrency interaction first.

Honest limit: the controls above govern git. **Most production mutations do not go through
git** — VM `scp` deploys, Twilio and Retell console edits, live SQL, the number cutover. For
those, §C and §D are the only controls that exist.

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
npm run check                           # lint + build (tsc backend, vite frontend + kds) + DB-free unit tests
                                        # `lint` is `eslint . --max-warnings 27` — a ratchet, so a NEW warning fails.
                                        # NOTE: this is not what CI runs. CI's `validate` job has its own step list
                                        # (build, migrate twice, test, 14 smoke scripts, seed, npm audit).

# Smoke tests (product behaviour is smoke-tested, not unit-tested — see the
# testing rule under "Hard rules of thumb").
#
# ⚠️ Two sets, and it matters which directory you are in. These run from the
# REPO ROOT:
npm run smoke:legal                     # legal layer: unskippable agreement step, consent/ABN refusals, append-only ledger trigger
npm run smoke:admin                     # platform admin API incl. stuck-job re-enqueue
npm run smoke:isolation                 # multi-tenant onboarding isolation
npm run smoke:double-booking            # the advisory lock + gist exclusion constraint
npm run smoke:payments                  # voice-order payment links (Stripe)
npm run smoke:staging                   # the whole battery against real staging — see deploy/runbooks/staging-call-battery.md
# plus: smoke:menu-ocr, smoke:retry-idempotency, smoke:tenant-attribution,
#       smoke:calcom-mirror, smoke:outbox-deadletter, smoke:solo-diner,
#       smoke:ops-state, smoke:business-alerts, smoke:voice-kill-switch,
#       smoke:notification-lease

# These exist ONLY in apps/backend and are NOT forwarded to the root, so they
# need --workspace (or a cd). Copy-pasting them at the root fails:
npm run smoke:backend --workspace=@vocotable/backend   # full lifecycle: health → availability → create → update → cancel
npm run smoke:retell  --workspace=@vocotable/backend   # exercises /retell/inbound, /retell/webhook, /retell/tools/*
npm run smoke:twilio  --workspace=@vocotable/backend   # exercises /twilio/voice, /twilio/status
npm run smoke:calcom  --workspace=@vocotable/backend   # Cal.com outbox/inbox mirror
npm run smoke:orders  --workspace=@vocotable/backend   # menu + order endpoints (KDS)
# plus: smoke:retell-signed, smoke:retell-dates, smoke:retell-orders, smoke:verify-email

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
3. **Retell** matches the called number and asks **our `/retell/inbound` webhook** which agent to use. The webhook resolves the venue from the *dialled* number (`getRestaurantIdByDialedNumber`) and returns `override_agent_id` plus **freshly computed** `dynamic_variables` (`restaurant_name`, `restaurant_timezone`, `today`, `tomorrow`, `caller_phone`). Verified end-to-end on a real staging call, 13 Aug 2026. *(An earlier version of this file said variables came from the LLM's `default_dynamic_variables` and that the agent was bound by `inbound_agent_id`. Both are wrong: `inbound_agent_id` was **removed by Retell on 31 Mar 2026** in favour of weighted `inbound_agents`, and `default_dynamic_variables` is only a **fallback** that fires when the webhook fails — which is exactly why we keep it empty. See [`NUMBERS.md`](NUMBERS.md) §6.)*
4. The Retell LLM (GPT-4.1, single-prompt, voice 11labs-Anna en-AU) calls our **custom function** endpoints at `/retell/tools/check-availability` and `/retell/tools/create-booking`. These return snake_case JSON the LLM can read out (`confirmation_message`, `natural_alternatives_message`).
5. Retell sends lifecycle events to **`/retell/webhook`** (signed). Final `call_analyzed` event includes `call_analysis.custom_analysis_data.{intent, booking_outcome, special_requests, caller_satisfied}` — the keys are configured on the agent via `post_call_analysis_data`.
6. `apps/backend/src/services/retellService.ts::persistRetellCall` extracts those fields and upserts into `call_logs` (unique on `(provider, provider_call_id)`).
7. The React dashboard (Firebase Hosting `vocotable.web.app` — legacy name, moving to `app.biteperk.com.au`, see NAMES.md §2; public brand site `biteperk.com.au`) fetches from `/api/reservations`, `/api/call-logs`, `/api/analytics` (all Firebase-ID-token-gated) and renders.

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
- `workers/` — `calcomOutboxWorker` (2 s tick), `healthAlerter` (Slack on outbox depth / breaker open / inbox failures / Cal.com daily quota), `cleanupWorker` (6 h tick — retention sweep across Cal.com outbox/inbox, notifications, ops state, KDS heartbeats and Retell auth buckets, and it cancels abandoned onboardings; it deliberately never touches `order_payments`, and since #214 it will not delete an inbox row nobody has successfully handled — an unprocessed cancellation is evidence, not litter), plus onboarding workers `menuOcrWorker`, `notificationWorker`, and `provisioningWorker` (each a no-op unless its kill-switch flag is on), `orderPaymentReaper` (expires unpaid voice-order payment links), and `retellVariablesWorker` (keeps the agent's dates fresh — see above). Leased job claims (`menu_ingestion_jobs`, `provisioning_jobs`) include a 10-min stuck-`processing` reaper so a crash mid-tick can't orphan a job. The worker process also serves its own HTTP health surface — `/livez` (process alive, touches nothing), `/readyz` (DB reachable, 2 s deadline), `/workerz` (per-worker tick counts + last-tick age, recorded in `withTickLogContext`) — on `WORKER_HEALTH_PORT` locally (must differ from the api's `PORT` on a shared host) and on the injected `PORT` in Cloud Run, where it also satisfies the listen-on-`$PORT` requirement and holds the event loop open.

### Tenancy: dashboard is multi-tenant, voice path is not (yet)

- **Dashboard/API**: fully tenant-scoped. `auth/tenantContext.ts` validates the `X-Restaurant-Id` header against the user's memberships (`resolveTenant` → 403 `NOT_A_MEMBER` on mismatch); all dashboard/menu/orders/billing routes chain `requireFirebaseAuth → resolveTenant → requireMemberRole(...)`.
- **Voice path**: `normalizeRestaurantId()` in `http/schemas.ts` and the Retell/Twilio handlers **ignore caller-supplied `restaurant_id`** — removes a category of "AI tricked into booking elsewhere" attacks. Since 2 Aug 2026 both Retell and Twilio resolve the restaurant from the **dialled number** (`To`/`Called` → `getRestaurantIdByDialedNumber`) and fail closed in production; `env.DEFAULT_RESTAURANT_ID` remains only the dev fallback and the Cal.com web-booking default (there is one global `CALCOM_EVENT_TYPE_ID`, so today every web booking genuinely belongs to that restaurant — the condition that makes this a bug is commented in place in `calcomService.ts`).
- **Onboarding Phases 0–5** (routes `onboarding.ts`/`restaurant.ts`/`me.ts`/`admin.ts`/`billing.ts`/`stripeWebhook.ts`, workers `menuOcrWorker`/`notificationWorker`/`provisioningWorker`) ship behind kill-switch flags that all default `false`: `STRIPE_BILLING_ENABLED`, `MENU_OCR_ENABLED`, `NOTIFICATIONS_ENABLED`, `PROVISIONING_AUTO_ENABLED` — plus, added since, `SELF_SERVE_SIGNUP_ENABLED` (gates the whole self-serve wizard), `EMAIL_VERIFICATION_CODE_ENABLED`, `ORDER_PAYMENTS_ENABLED`, `STRIPE_CONNECT_ENABLED`, `SERVICES_VOXCONCIERGE_ENABLED`, and `TERMS_ALLOW_UNPUBLISHED_DOCS` (staging only — production must never set it). ⚠️ **`VOICE_BOOKING_ENABLED` is the exception**: it is a kill switch built on `gateFlag()`, so it defaults **true** — a forgotten env var must never silence the phone line. (`MULTITENANCY_LEGACY_FALLBACK` was removed 2 Aug 2026 by migration 027 — dashboard access is `restaurant_members` and nothing else, so granting someone access means inserting a row.) Production `superRefine` in `config/env.ts` only demands the matching credentials once a flag is on. Local development has explicit non-production checkout/provisioning shortcuts when Stripe or automatic provisioning are disabled; those branches must stay gated by `env.APP_ENV !== "production"`.

### Platform admin (`/admin`) — cross-tenant, added 17 Aug 2026

A second, separate authorisation tier above tenancy. Everything else in the dashboard is
scoped to one restaurant; this is deliberately not.

- **Backend** `routes/admin.ts`, all under `/api/admin/*`, gated by
  `requireFirebaseAuth → requireAdminRole` applied **path-scoped** to that prefix. The gate
  is the `DASHBOARD_ADMIN_EMAILS` allowlist (trimmed, lowercased, deduped in
  `auth/firebaseAuth.ts`). An **empty allowlist fails closed with `503
  ADMIN_ROLE_NOT_CONFIGURED`** — that is a missing env var, not a broken deploy, and it is
  what an unconfigured environment looks like. Surfaces: venue list/detail (with terms drift
  and billing presence), guarded unbind, provisioning queue + bind + go-live, stuck-job list
  and safe re-enqueue, ops health, support-request inbox, and a kill-switch flag readout.
- **Every mutating admin action writes an `admin_actions` row** (migration `033`) recording
  who did it. `GET /api/me` returns `is_admin`.
- **Frontend** `pages/admin/*` inside the existing SPA; the sidebar link renders only for
  platform admins. There is no separate deployment — the API ships in the api image and the
  page ships with the normal dashboard deploy.
- ⚠️ `DASHBOARD_ADMIN_EMAILS` is **not** demanded by any boot gate, so a deployment that
  omits it starts cleanly and then 503s every admin call. Add it to the Terraform env map.
- ⚠️ Binding a phone number here is the one place a venue's dialled-number routing can be
  changed by hand, and it is now **enforced rather than merely documented** (18 Aug 2026):
  the PATCH rejects `twilio_phone_number` without `retell_agent_id` or vice versa (the
  COALESCE half-bind used to leave the *previous* venue's agent bound, and the wizard stuck
  with no error anywhere), and it verifies the agent against Retell before storing it —
  `409` if it does not exist, if another venue already holds it, or if its `agent_name`
  names a different venue (override with `?allow_name_mismatch=true`, audited).
- ⚠️ **A venue must never share another venue's Retell agent.** The agent carries the
  venue's identity, prompt and tool endpoints, so a shared one answers in the wrong venue's
  voice — with the right venue's data underneath, which is why it reads as a mystery rather
  than a bug. Migration `034` adds the partial unique index on `retell_agent_id` that `008`
  omitted. Prompts must carry **no** venue name in prose: identity comes from the
  `{{restaurant_name}}` / `{{owner_name}}` dynamic variables that `/retell/inbound` injects
  fresh per call. See `deploy/runbooks/venue-onboarding.md` §1 trap 3.

### Legal documents and the acceptance ledger (#195 / #201, Aug 2026)

The agreement step records Order-Form elections plus three separate consents into the
append-only `agreement_acceptances` ledger. What changed in August is **who decides what was
accepted**:

- Documents are published by `.github/workflows/publish-legal-documents.yml` to a versioned
  GCS bucket (`<project>-legal-documents`) with immutable version folders and a
  `current/manifest.json`. The workflow enforces branch↔environment (`integration`→staging,
  `main`→production).
- `services/legalDocuments.ts` fetches that manifest and verifies the submitted version, URLs
  and SHA-256 digests **server-side** before anything is written. Mismatch → `409`; manifest
  unreachable → `503`. The browser used to supply those values with shape-only validation,
  which meant the ledger recorded whatever it was told.
- `LEGAL_DOCUMENTS_MANIFEST_URL` is **required in production** — without it the route would
  record unverifiable evidence, and an append-only row cannot be corrected later, only
  annotated. `TERMS_ALLOW_UNPUBLISHED_DOCS=true` permits accepting a `SAMPLE-*`/`DRAFT-*` set
  and is **staging-only; production must never set it**.
- Migration `032` stores the document URLs alongside the digests.

### Frontend layout

`apps/frontend/src/main.jsx` is the SPA bootstrap + path-based router (no react-router) — the pages live under `src/pages/{landing,auth,dashboard,billing,onboarding,admin}` with shared `components/`, `features/`, `hooks/`, and `lib/`. Routes: `/` (public landing), `/invite`, `/verify-email`, `/live-feed[/:id]`, `/live-tables[/:id]`, `/booking-log`, `/manage-menu`, `/manage-tables`, `/kitchen-overview`, `/analytics`, `/billing`, `/manage-plan`, `/update-payment-details`, `/profile`, `/order/paid`, `/order/cancelled`, `/onboarding` (wizard: CreateRestaurant → Profile → Menu → Trial → Phone steps in `pages/onboarding/steps/`), and `/admin[/venues|/jobs|/ops|/support]` (platform admin — see below). Dashboard routes are gated by `AuthProvider` + an onboarding gate in `AppRouter` (incomplete tenants are redirected to `/onboarding`; `/manage-menu` is reachable during onboarding). The wizard dispatches `vocotable:onboarding-status-changed` so the top-level gate updates immediately when onboarding advances. `api.js` attaches the Firebase ID token as Bearer, force-refreshes on 401 (single retry), and sends `X-Restaurant-Id` from the persisted active-restaurant selection (a selector only — the backend enforces membership). `firebase.js` tries `signInWithPopup` then falls back to `signInWithRedirect` if extensions block the popup network call. `apps/kds/` is a separate Vite app (kitchen display) that polls the backend.

## Database

Custom migration runner — **not Knex/Prisma**. `apps/backend/src/db/migrate.ts` walks `apps/backend/db/migrations/**` recursively, orders by numeric filename prefix, and records applied files in `schema_migrations` (root files by bare filename — backward-compatible with the pre-existing ledger). Each migration runs in one `client.query(sql)` call, so **multi-statement DDL with `GENERATED ALWAYS AS` expressions can trip node-pg with error `08P01` (invalid message format)** — when that happens, apply the SQL via `psql -f` directly and `INSERT INTO schema_migrations (filename) VALUES (…)` manually. Migration `003` hit this; it's now applied but worth knowing for future migrations.

**The chain is append-only (001–033 as of 18 Aug 2026) and must stay that way** — production records applied filenames in `schema_migrations`. `apps/backend/db/baseline-sydney/` is a **parked** fresh-install schema (domain folders, separate Postgres schemas) for the planned Iowa→Sydney database migration; it is NOT walked by the runner and must never be applied to the live database (its tables would be created empty next to the real `public` ones — see its README and the 29 Jul 2026 merge `c3cf71a`). New schema for shipped code goes in a numbered migration, even if the baseline also has it — `020_table_attributes.sql` exists because the seating-preference code shipped reading a column only the baseline defined.

**Cloud Run deploys migrate first**: `deploy-backend.yml` (rewritten 4 Aug 2026) executes the Cloud Run job `voxtable-stg-migrate` — the new api image with `APP_ENV=migration`, running `dist/db/migrate.js` — and only rolls the api/worker services after it succeeds, so new code never serves against an old schema. **Migrations must run as `voxtable_owner`, never `postgres`**: migration 029's `ALTER DEFAULT PRIVILEGES` attaches to the executing role, so the wrong role silently strips future tables of `voxtable_app` grants. (029 splits owner/runtime roles and adds the `BEFORE TRUNCATE` guard on `agreement_acceptances`; it is a guarded no-op where the roles don't exist, i.e. CI and dev.) The **VM path — production until the Phase 3 cutover — still migrates after restart**: for a migration whose enum values/tables the NEW code references at startup or on a worker tick, pre-apply it via psql (expand-first) before promoting; the runner then skips it by filename and there is no schema/code race window.

Schema is in `001_initial_schema.sql`. The interesting columns added in `003`:
- `call_logs.intent`, `booking_outcome`, `user_sentiment`, `in_voicemail`, `call_successful`, `special_requests`, `analysis_json` (JSONB), `duration_seconds` (GENERATED).
- `reservations` partial UNIQUE INDEX preventing double-booking at the same `(table_id, date, start_time)` for non-cancelled rows — superseded as the primary guard by 025's duration-aware `reservations_no_overlap` exclusion constraint (both remain).

Dates are TZ-naive `DATE` + `TIME` (correct — they're wall-clock at the restaurant). Lifecycle timestamps are `TIMESTAMPTZ`. The restaurant's TZ comes from `restaurants.timezone` (memoized in `repositories/restaurants.ts`).

## Deployment

- **Staging (from 4 Aug 2026): Cloud Run in `bp-voxtable-stg`** (australia-southeast1) — services `voxtable-stg-api` / `voxtable-stg-worker`, Cloud SQL `voxtable-stg-postgres` (private VPC, automated backups + PITR), migration job `voxtable-stg-migrate`. Every CI-green push to `integration` deploys automatically (`deploy-backend.yml` / `deploy-frontend.yml`, gated on a successful CI `workflow_run`). **Infrastructure — services, env vars, secrets, Cloud SQL, Firebase Hosting/Auth — is Terraform in `biteperk/biteperk-cloud-platform`** (`roots/products/voxtable/{stg,prod}`, applied via that repo's manual `terraform.yml` workflow); the deploy workflow only swaps `--image`, and the Cloud Run modules `ignore_changes` on image so the two never fight. A new required env var MUST be added to the Terraform env map or staging boots die on the fail-closed gate (staging runs `APP_ENV=production` posture — a service missing a required var exits with `Refusing to start`; read the revision logs, don't guess). Frontend/KDS: Firebase Hosting in `bp-voxtable-stg`. Deployment logic belongs **in the workflow jobs only** — no deploy scripts in the repo (review decision, PR #93).
- **Production backend (VM until the Phase 3 cutover)**: GCP VM `core-central-vm` (project `vocotable-497209`, static IP `136.113.35.88`) running **two containers since 29 Jul 2026** — `api` (`Dockerfile.api`, serves HTTP) and `worker` (`Dockerfile.worker`, all background workers) — via `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.deploy.yml up -d api worker`. CI builds/pushes both images to Artifact Registry (`…/vocotable/api`, `…/vocotable/worker`); the VM only pulls. The `prod` override mounts `/opt/vocotable/firebase-admin.json` → `/secrets/firebase-admin.json` (read-only) into both. The base compose stays Firebase-Admin-free so local dev doesn't need a service-account JSON. **The VM's git checkout has no GitHub credentials** (`git pull` fails) — compose/env file updates reach the VM by `gcloud compute scp`, not git; images are the only automated artefact.
- **Twilio: THREE accounts, and the rule is staging first.** 📖 **The number inventory — which number is on which account, what each can do, and what is still unwired — is [`NUMBERS.md`](NUMBERS.md); read it before quoting, wiring or testing any number.** The two BitePerk accounts below sit under one Twilio Organization ("My Organization") and are swapped with the account picker at the top-left of the console — **check which account is selected before you change anything.** The console gives almost no visual difference between them. The third account (Algorythmos) holds the only *live* number and is covered further down.
  - **Both accounts are owned by `twilio@biteperk.com.au`** (13 Aug 2026) — the Account SIDs did not change, so every SID, trunk, bundle, address and Messaging Service already recorded stays valid; only the credential record moved.
  - `Biteperk-staging` — `AC8116857da2064ef3251533f3ade56f32` — **Active**, owns `+61 468 203 234`, balance **$11.75** and **no auto-recharge**.
  - `Biteperk-production` — `ACd423bd09e9649e552a0b6d19a9eed338` — **Active (upgraded off trial)**, owns `+61 468 202 846`, balance **$11.75** and **no auto-recharge**. ⚠️ A zero balance suspends the account and every call and test fails in ways that look like a code bug — that is exactly how the Algorythmos account took Natalia's line down. Auto-recharge on both is the highest-value open action in [`NUMBERS.md`](NUMBERS.md) §8.
  - **Australian number types are not interchangeable, and this constrains the SMS design** (verified in the Twilio console 10 Aug 2026, AU + destination Australia): a **Local `02` number is voice-only — it cannot send SMS at all** (searching Local with the SMS capability returns zero results), at **$3.00/mo**. Only a **Mobile `+61 4` number does both voice and SMS**, at **$8.25/mo**. So there is no single geographic number that answers calls *and* texts: voice on a local number means outbound SMS must come from either a mobile number or the (one-way) `BitePerk` alphanumeric sender ID. Local numbers additionally require an address record on the account.
  - **Convention: every Twilio change is proven in `Biteperk-staging` before it is repeated in `Biteperk-production`.** That covers number purchases, Messaging Services, alphanumeric sender IDs, SIP trunks, and webhook URLs. Twilio has no promote/merge — "promotion" means *making the same change again in the other account*, so record what you did in staging well enough to repeat it exactly.
  - **An AU number cannot be bought without an approved Regulatory Bundle.** Approval is **instant when the account already has a verified customer profile** (observed 13 Aug 2026, production) and took **~1 day** when built from documents on an account with no profile (staging) — the "~3 business days" originally budgeted never materialised, but do not promise a go-live date on the fast path. The Buy button stays greyed out until a bundle matching the number's country **and type** (`AUSTRALIA MOBILE BUSINESS` for a `+61 4`) is assigned, and bundles do **not** cross accounts — the Trust Hub profile `BU975db7…` on production is a different object on a different account and is no help in staging. Staging bundle **`BUd5fe40c147a21757f04616a1180cdd89`** ("BitePerk staging - AU Mobile Business") on account `AC8116857da2064ef3251533f3ade56f32` — lodged 12 Aug 2026, **APPROVED 13 Aug 2026** (~1 day, not the ~3 business days budgeted; plan production on the same assumption but don't rely on it). Notification email `sam@biteperk.com.au`. Approval alone buys nothing: the bundle must be **assigned to a number at purchase**, and staging still owns no number. What the form wanted, so production can be repeated exactly: identity **Direct Customer** + end user **Business**; `BITEPERK PTY LTD`; business ID `36 700 831 303`; address Level 1 / 457-459 Elizabeth Street / Surry Hills / NSW / 2010 (a serviced office — fine, AU *mobile* explicitly allows an address anywhere in the world, unlike Local which needs an in-country address record); then **three** supporting-document slots — Business Name, Business Address, Business ID Number. `asic/01-register/2026-07-29_ABR_ABN_Advice_36700831303.pdf` satisfies the last two on its own (it shows both the address and the ABN) under document type *"Commercial registry or equivalent showing address"* — **confirmed on the approved bundle**, which shows a single *Commercial registry or equivalent* document clearing all three requirements (Business Name, Business Address, Business ID Number) in one upload. Exact field entry, to be mirrored in production: Business Name `BITEPERK PTY LTD`, Business ID `36 700 831 303`, **Street line 1 `457-459 Elizabeth Street`, Street line 2 `Level 1`** (note the inversion — the canonical NAP reads "Level 1, 457-459 Elizabeth Street", but Twilio's two-line form takes the unit on line 2), Surry Hills / NSW / 2010 / AU. Staging Address SID `AD0b3b71dc0a972ac2e678cb633e3a2c3d`. Console renders the approved state as **"Accepted"**, not "Approved" as the notification email says — same state, different vocabulary. The ASIC **Certificate of Registration carries no address** and the **Occupier Consent (s100, Bustle Studios) is not one of the offered document types** — neither is usable for the address slot. After approval the bundle must still be *assigned* to the number, and only then can the number be bought; approval does not purchase anything, and a shortlisted number is never reserved while you wait.
  - ⚠️ **`Direct Customer` is right for our own numbers and will be wrong for venue numbers.** Twilio's ISV/Reseller option is "I integrate Twilio in a product that I sell to my customers", which is exactly VoxTable once `provisioningWorker` buys numbers on behalf of restaurants — each venue would then likely need its own End-User record. Both bundles are deliberately Direct Customer because BitePerk really is the end user today. **Confirm the correct model with Twilio before the first venue is auto-provisioned** — this is one of the few places where staging does *not* rehearse production. 📖 **Account/bundle/profile scoping, the Bundle Clone recipe, the ISV decision and the cost arithmetic are all in [`deploy/runbooks/twilio-account-topology.md`](deploy/runbooks/twilio-account-topology.md) — read it before creating an account, buying a number, or designing per-venue provisioning.** Two facts from it that agents keep getting wrong: **customer profiles are account-scoped, not org-shared** (production's instant bundle approval was same-account reuse of `BU975db7…`; staging had no profile and waited a day), and **the Clone API does not clone sender IDs** — bundles and sender IDs are separate objects needing separate actions. Production's approved AU Mobile bundle is **`BU8cb2353e1b34a75c6ed0cec20e163356`**, and production owns **`+61 468 202 846`** (Voice + SMS, $8.25/mo, bought 13 Aug 2026 — Twilio side fully wired, Retell and `restaurants` still unbound; see the next bullet and [`NUMBERS.md`](NUMBERS.md) §2). ⚠️ **Numbers are not reserved between selection and payment and the search index is stale** — two vanity numbers were lost mid-purchase before this one succeeded; buy from the unfiltered pool and don't chase a specific tail.
  - ✅ **RESOLVED 13 Aug 2026 — there are THREE Twilio accounts, not two.** The live AU voice number behind the `algorythmos` SIP trunk sits on the **original Algorythmos account `AC949756ac8dc4aced25b15b2e0bbb3a61`** (`+61 2 7501 1140`, Bella / Natalia's Bistro), **not** on either BitePerk account — and that account is 🔴 **suspended for lack of funds** as at 5 Aug 2026, so production voice is down until it is recharged. `AC8116857da…` (documented in `vendor-accounts.local.md` as "the BitePerk account created 5 Aug") **is now named Biteperk-staging** and owns no number. `ACd423bd09…` is Biteperk-production. Full three-account mapping, SIDs and number inventory: [`deploy/runbooks/vendor-accounts.local.md`](deploy/runbooks/vendor-accounts.local.md).
  - **Production's own AU mobile number is `+61 468 202 846`** (Voice + SMS, $8.25/mo, bought 13 Aug 2026 on `ACd423bd09…`). It is a clean company-owned number and **the Twilio side is now wired** (13 Aug 2026): Elastic SIP Trunk **`TK6fcd3c96ea8317181d4049ce6f938f10`** (`voxtable-prod-au1`, **AU1**) with origination `sip:sip.retellai.com;transport=tls`, the number attached and showing **Voice enabled**, plus Messaging Service **`MG7ceaa2aaa3cea6195ea7979d57b78b14`** (`voxtable-prod-notifications`, US1) with the number as sender. **The Retell side is still untouched** — no agent bound, no `restaurants` row, so `getRestaurantIdByDialedNumber` will not resolve it, and it does not replace `+61 2 7501 1140` until deliberately cut over. ⚠️ **The number's region is deliberately split — Voice on AU1, Messaging on US1** (Twilio has no AU1 messaging), and **a US1 number is invisible to an AU1 trunk**, so always change region *before* attaching. **AU1 is not onshore call processing** — Retell is US-based and audio still leaves Australia; do not restate this as onshore. Full wiring detail: [`deploy/runbooks/twilio-account-topology.md`](deploy/runbooks/twilio-account-topology.md).
  - **Staging owns `+61 468 203 234`** (Voice + SMS, $8.25/mo, bought 13 Aug 2026 on `AC8116857da…`, number SID `PN5a99b73b6f6a9e9a1cc40f7eb7feba42`), wired the same way: trunk **`TKdebe2aa1a4287ca4b2f22da0e9d10ed7`** (`voxtable-staging-au1`, **AU1**, origination `sip:sip.retellai.com;transport=tls`, Voice enabled) and Messaging Service **`MG692c54a793f914c2e43c7d691f4cb41e`** (`voxtable-staging-notifications`, US1), reusing bundle `BUd5fe40c…` and address `AD0b3b71dc…` — no new compliance objects. **Internal end-to-end testing only; never customer-facing.** Unlike production's number, staging's **is** bound end to end — Retell agent imported and a `restaurants` row resolving (see the Retell section below); this line used to say otherwise and was wrong. ⚠️ **SMS sent from staging is stamped `Unverified` on the handset** — the `BitePerk` sender ID is bound to the *production* Account SID and there is no clone API for sender IDs, so a branded-SMS test on staging measures the wrong thing until `AC8116857da…` is added to ticket 28926493.
  - **Neither new number has a Disaster Recovery URL**, so a Retell outage would give callers dead air rather than a message. Per-number status and the full open-actions list: [`NUMBERS.md`](NUMBERS.md).
- **Branded SMS (ACMA sender ID) — IN FLIGHT, read `deploy/runbooks/acma-sender-id-registration.md` before touching SMS senders.** Australia's SMS Sender ID Register went live 1 Jul 2026: any *alphanumeric* sender ID not registered with ACMA is overstamped **`Unverified`** on the handset. **We have no exposure today** — SMS goes out from the Twilio number, not a sender ID — so this is pre-emptive, and the order is register first, flip config second. Progress as of 10 Aug 2026: `Biteperk-production` upgraded off trial; Trust Hub **Primary Customer Profile APPROVED** — Bundle SID `BU975db7eebfb0b5525d6762f3d77e2087` on Account SID `ACd423bd09e9649e552a0b6d19a9eed338` (business verification ran through Persona, `inquiry.withpersona.com`, not Twilio directly); the `BitePerk` sender ID application was **lodged 11 Aug 2026 and is in review** — Twilio ticket **28926493**, sender-ID Bundle SID **`BUce1fa0ad6053c4444f3faca4c7957f25`** (a *different* object from the customer-profile bundle above — don't conflate them), correspondence `senderid@twilio.com` ↔ `sam@biteperk.com.au`. Review is Twilio → carrier/regulator; a fee on approval is possible but unconfirmed. ⚠️ **The sender ID is bound per Account SID**: it is registered against production `ACd423bd09…` only, so any send from another account — including `Biteperk-staging` — is stamped `Unverified` regardless of approval. Adding staging's SID is an open action; see the runbook §5 before planning any staging SMS test. Twilio Inc. is a **Certified telco** on ACMA's approved list, so it can register on our behalf. Two prerequisites are still outstanding and both are slow, so start them early: the **ABR** authorised-contact / service-of-notice email must be current for ABN `36 700 831 303` (ACMA verifies authority there, *not* via RAM — a stale address stalls the application silently), and the signing individual needs a **myID** identity. Nothing in the repo changes until a sender ID is approved; when it is, set it on the Messaging Service used by `notificationWorker`, keep the number as fallback, and remember alphanumeric SMS is **one-way** — no notification copy may invite a reply.
- **DOMAIN MIGRATION IN FLIGHT (from 3 Aug 2026) — read `deploy/runbooks/domain-migration.md` before touching hostnames.** The customer-facing surfaces are moving to company-native names: API `vocotable.algorythmos.com.au` → **`api.biteperk.com.au`**, dashboard `vocotable.biteperk.com.au`/`vocotable.web.app` → **`app.biteperk.com.au`**, KDS → **`kds.biteperk.com.au`**. It is deliberately **additive** — old hostnames keep serving, vendors (Stripe → Cal.com → Retell → Twilio) cut over one at a time, each verified with a live test call, because Retell/Twilio signature verification is URL-sensitive. The `SYNTH_EMAIL_DOMAIN` (`bookings.vocotable.algorythmos.com.au`, `calcomService.ts`) must NOT change — it is baked into existing Cal.com bookings. The Firebase project id, Artifact Registry path and `vocotable_number` API field are explicitly out of scope.
- **TLS** via nginx + certbot. Nginx config is in `deploy/nginx/vocotable.conf` — it serves BOTH the new and legacy `server_name` from one cert (`--cert-name api.biteperk.com.au`); rate limits at the top-level `http {}` scope (already correct), raw body buffering on webhook paths for signature verification. *(Note: the repo config was stale at `api.vocotable.com` until 3 Aug 2026 — the VM was the source of truth. Keep them in sync now.)*
- ⚠️ **The KDS is deployed by no pipeline, in any environment.** Both GitHub Environments set `FIREBASE_ONLY=hosting:app`, so `deploy-frontend.yml` only ever ships the dashboard. KDS reaches production solely via `npm run build:kds && firebase deploy --only hosting:kds` from someone's laptop — outside CI, outside staging, outside every control in §E.
- **Frontend** on Firebase Hosting target `app`. Build with `VITE_API_BASE_URL` (a GitHub repo variable) before `firebase deploy --only hosting:app`. KDS is the separate Firebase Hosting target `kds`.
- **DNS** managed in Cloudflare — legacy records under `algorythmos.com.au`, new ones under `biteperk.com.au` (both zones live in the same personal Cloudflare account). Any A record fronting the API must be **DNS-only (gray cloud)** — orange-cloud proxying breaks Let's Encrypt HTTP-01 and Retell/Twilio signature URLs. Adding a hostname to Firebase Auth's **authorized domains** is required or Google sign-in breaks on it.
- **Retell: BitePerk now owns its own account — but production has NOT cut over yet.** Two estates exist and confusing them wastes a night:
  - **New (BitePerk-owned)** — login `biteperk@gmail.com`, workspaces **Biteperk** (production) and **Staging**. The Biteperk workspace holds both venue agents, built 13 Aug from the *live* config: Natalia's `agent_5b5df167525452db98cda2112f` / `llm_18ad6f5adedc865b7ffd02a121e1`, Cuban Corner `agent_2892d65ceace4e68d8a3f3e80c` / `llm_53c6e9de9aac3b60270ffdd6bcba`. The **Staging** workspace carries a parallel pair pointed at the staging API. As at 18 Aug 2026 the wiring is done and the **machine** half is proven — staging key deployed, number imported, venue row resolving, and `npm run smoke:staging` green against the live staging API (first green run 14 Aug). The **human** half is not: the seven-leg phone battery in [`deploy/runbooks/staging-call-battery.md`](deploy/runbooks/staging-call-battery.md) has an empty results table, and NUMBERS.md §8 item 2c is still open. Treat "a real call has been answered end to end" as **unproven** until that table has rows — leg 6 additionally needs `NOTIFICATIONS_ENABLED` + `NOTIFICATIONS_SMS_FROM` on the staging worker (issue #185), which are not set today.
  - **Legacy (Algorythmos-owned)** — `retellai@algorythmos.com.au`, org `org_f0DPXgKIQTMJL4je`. **A different company's workspace, out of scope.** It still answers the pilot line until Natalia's is cut over, and carries no obligation afterwards (the calls recorded there were tests, not customer audio). Do not add BitePerk resources to it.
  - **The backend serves exactly one Retell account per environment** — one `RETELL_API_KEY`, one `RETELL_WEBHOOK_SECRET`, checked by router-level middleware before any parsing. There is no gradual move; switching workspaces is an atomic env cutover. The new workspace's single API key is badged as its **Webhook key**, so both env values take the same string.
  - ⚠️ **The new agents still call back to `vocotable.algorythmos.com.au`** (`webhook_url` + all five tool URLs). Until the API hostname moves to `api.biteperk.com.au`, "migrated off Algorythmos" is not true — the agent moved, the dependency did not.
  - **Build agents from the LIVE config, never from a snapshot.** The live greeting carries the AI + recording disclosure that no committed snapshot had, and the live agent carries `data_storage_retention_days: 30`. Rebuilding from a snapshot silently strips both.
  - Keep `default_dynamic_variables` **empty**: nothing in production refreshes them, and a phone number carrying both `inbound_agents` and `inbound_webhook_url` falls back to the static agent when the webhook 401s — greeting the caller with a stale venue name and months-old dates. Details in [`NUMBERS.md`](NUMBERS.md) §6.
- **Retell config snapshots** for rollback are kept in `deploy/retell-snapshots/<timestamp>-<reason>/{llm.json,agent.json}`. Re-apply via `PATCH /update-retell-llm/{llm_id}` and `/update-agent/{agent_id}`.
- **Failure-mode runbooks** live in `deploy/runbooks/` — `rollback.md` for image-crash / Cal.com misbehaving / migration-breaks-reads recovery (target ≤5 min revert), `backup-restore.md` for pg_dump verification + restore drills.
- **Cal.com-specific env vars** (required in prod when `CALCOM_SYNC_ENABLED=true`): `CALCOM_BASE_URL`, `CALCOM_API_KEY`, `CALCOM_WEBHOOK_SECRET`, `CALCOM_EVENT_TYPE_ID`, `CALCOM_OUTBOX_MAX_ATTEMPTS`, `CALCOM_REQUEST_TIMEOUT_MS`, `CALCOM_DAILY_QUOTA_THRESHOLD`. Slack alerting: `OPS_SLACK_WEBHOOK_URL`. See `.env.example` for the full list.

## Collaboration

**Two people work on this repo: Sam and Abhishek Yadav** (`abhishekyadav01`, active since Jul 2026 — the dev-experience fixes, the api/worker split, Manage Tables, and the CI/deploy pipeline are his). The former intern, Ali Ümit ALGAN, finished in July 2026.

**Branch etiquette (from 1 Aug 2026):** open PRs against **`integration`**, never `main`. `main` is release-only and is reached by promoting `integration`. Remember Abhishek's branches may assume a fresh database (the split-services branch shipped a full migration rebaseline that had to be parked — see the Database section).

**Pipeline state — verified 6 Aug 2026.** The deploy half was rewritten 4 Aug (#94/#95): `deploy-backend.yml`/`deploy-frontend.yml` deploy `integration` → Cloud Run staging and `main` → Cloud Run production, both gated on a successful CI `workflow_run`; the backend job runs the migration job before rolling services. Deploy recovery is a Cloud Run revision traffic rollback done by hand — extra pipeline rollback tooling was reviewed and declined (PR #100). Current gaps:
- Staging api/worker **refused to boot until PR #107** (merged 6 Aug): the boot gate demanded `RETELL_AGENT_ID` and `TWILIO_PHONE_NUMBER`, which are per-restaurant database data (`restaurants.retell_agent_id` / `twilio_phone_number`), not deployment config — the review decision that closed `biteperk-cloud-platform` PR #20. With #107 in, staging boots on the existing Terraform config with no new variables anywhere. End-to-end staging **calls** additionally need a staging `restaurants` row bound to the staging Twilio number + Retell agent (data, not config — staging uses its own vendor identities, never production's).
- **Promoting `main` targets Cloud Run production (`voxtable-prod-*`), which is not provisioned.** `bp-voxtable-prod` **exists as an empty shell** — one secret, Cloud Run API not even enabled — so "does the project exist?" answers a misleading *yes*. Production is still the VM and is deployed by hand; a `main` merge does NOT reach the VM. ⚠️ **It does not skip cleanly either** — the `production` environment has no `GCP_DEPLOY_SERVICE_ACCOUNT`, so `deploy-backend.yml` **fails red** at its validation step (which now names the environment and the missing variable instead of emitting a bare shell error). The prod Terraform root already exists: provisioning is "add the project to the org root + apply", not console-clicking — plus the two pieces no automation creates yet: the `voxtable-prod-deployer` service account and the `api.biteperk.com.au` → Cloud Run domain mapping.
- The image registry (`bp-shared-artifacts`) and the frontend artifact bucket (`voxtable-frontend-artifacts`) live outside the `vocotable-497209` project and were **not readable by Sam's account** as of 1 Aug — worth resolving for auditability and bus factor.

**Deliberate Won't-Fix while the VM lives** (decided 6 Aug 2026, both die with the VM at the Phase 3 cutover): no log shipping off the VM (Cloud Run gets Cloud Logging for free; SSH + `docker compose logs` until then), and no compose `stop_grace_period`/memory limits (the notification-outbox lease closed the real double-send hazard a mid-send SIGKILL created).

Standard hygiene before any backend deploy:

1. `git fetch origin && git log --oneline origin/integration -5` — confirm `integration` is where you expect (use `origin/main` when checking what is actually in production).
2. SSH the VM (`gcloud compute ssh core-central-vm --zone us-central1-a`) and `git -C /opt/vocotable status` — files there may be root-owned; `sudo tar --overwrite` is the safe way to push code without trampling.

## Hard rules of thumb

- The MVP plan (see `plan-phases/00-overview.md`) says **product behaviour is smoke-tested, not unit-tested**. Amended 29 Jul 2026: DB-free `node:test` unit tests for pure plumbing (migration discovery, worker lifecycle) are allowed and run in `npm run check`; everything that touches the DB or an integration stays a smoke script (`smoke:*`). Still no Jest.
- Stay in-scope: no multilingual, no outbound calling, no loyalty, no mobile, no ResDiary/OpenTable integration. Multi-tenant onboarding exists but stays behind its kill-switch flags until deliberately rolled out (see `deploy/runbooks/onboarding-rollout.md`).
- Dashboard auth is locked to an **email allowlist** (`DASHBOARD_ALLOWED_EMAILS`), enforced in `auth/firebaseAuth.ts` — a verified account whose email isn't listed gets `403 EMAIL_NOT_ALLOWLISTED` on every dashboard route. Editing the list is an env change, no code. Empty list = open to any verified Google account (dev only; `env.ts` refuses to boot with an empty list on any non-localhost host).
- **`APP_ENV` is required with no default, and the three security gates — `DASHBOARD_VERIFY_AUTH`, `RETELL_VERIFY_SIGNATURE`, `TWILIO_VALIDATE_SIGNATURE` — default to `true`.** They may only be `false` while `PUBLIC_API_BASE_URL` is localhost; `env.ts` refuses to start otherwise, keyed on the URL rather than on `APP_ENV` (2 Aug 2026). Feature flags and kill-switches still default `false` — `boolFlag()` for those, `gateFlag()` for gates; don't mix them up.

## Brand — do not invent it

Anything user-facing that carries the BitePerk name (dashboard UI, emails, SMS copy,
PDFs, reports, artifacts) follows the **BitePerk brand kit**, kept in the website repo:

- `biteperk-website/BRAND.md` — portable kit: identity, wordmark, mark, both theme token
  sets, tone, and the NAP facts that must be byte-identical everywhere.
- `biteperk-website/src/styles/tokens.css` — live source of truth for the site.

The rule agents get wrong most often: **`--gold-fill` (`#f5c418`) is a fill, never text.**
The text-safe brand colour is `--gold`, and its value changes by theme — `#f5c418` on dark,
`#7d6104` on light. Dark is the brand default.
