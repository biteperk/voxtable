# VoxTable

> 🏷️ Naming conventions, hostnames, and infrastructure names are registered in
> [`NAMES.md`](NAMES.md) — check it before naming anything.

Voice-AI booking platform for restaurants, built by Biteperk Pty Ltd. A customer dials the restaurant's number, **Bella** (a Retell AI voice agent) answers, checks availability, and books the table — the reservation lands in Postgres and shows up live on the restaurant's dashboard.

## Architecture at a glance

```
Caller ──► Twilio (AU number) ──► Retell AI voice agent ("Bella")
                                        │  custom-function tool calls
                                        ▼
                              Express backend (:3050)
                              ├── PostgreSQL (reservations, call logs, menus, orders)
                              ├── Cal.com mirror (durable outbox/inbox — never blocks the call)
                              ├── Stripe billing (subscription mirror + webhooks)
                              └── Workers (outbox, provisioning, menu OCR, notifications, alerts)
                                        ▲
        React dashboard (:3051) ────────┤   Firebase-auth-gated /api/*
        KDS kitchen display    ─────────┘
```

- **apps/backend** — Node 20 + TypeScript + Express. Zod-validated boundaries, HMAC-verified webhooks (Retell/Twilio/Cal.com/Stripe), advisory-lock booking transactions, structured JSON logging with PII redaction.
- **apps/frontend** — React 19 SPA (Vite). Pages under `src/pages/{landing,auth,dashboard,billing,onboarding}`; path-based router in `main.jsx` (no react-router). Google sign-in via Firebase. Dashboard routes include live tables, live feed, booking log, menu, kitchen, analytics, billing, profile, and onboarding.
- **apps/kds** — kitchen display system (separate Vite app, polls the backend for orders).
- **Multi-tenant onboarding** (create restaurant → profile → menu → trial → phone) is merged behind kill-switch env flags that all default off; the inbound voice path is still intentionally conservative and does not trust caller/LLM-supplied restaurant IDs.

## Quick start

```bash
npm install
cp .env.example .env        # fill Postgres + (optionally) Retell/Twilio/Cal.com/Stripe creds
npm run db:migrate

npm run dev:backend         # API on http://localhost:3050
npm run dev:frontend        # dashboard on http://localhost:3051
npm run dev:kds             # kitchen display (separate Vite app)
```

Seed demo data only when you explicitly want local sample data:

```bash
SEED_DATA=true ./deploy/scripts/run-local.sh
# or, after local migrations:
npm run db:seed
```

Seed data is local-only and is blocked in `APP_ENV=production`.

Keep all webhook signature flags (`RETELL_VERIFY_SIGNATURE`, `TWILIO_VALIDATE_SIGNATURE`, …) `false` in dev, or use the smoke scripts below.

## Checks and smoke tests

There is **no automated test suite by design** (MVP speed lever) — verification is a type-check/build gate plus scripted smoke tests against a running local backend:

```bash
npm run check               # CI gate: tsc backend + vite build frontend + kds

npm run smoke:backend       # health → availability → create → update → cancel
npm run smoke:retell        # /retell/inbound, /retell/webhook, /retell/tools/*
npm run smoke:twilio        # /twilio/voice, /twilio/status
npm run smoke:calcom        # Cal.com outbox/inbox mirror
npm run smoke:orders        # menu + order endpoints (KDS)
npm run smoke:isolation     # multi-tenant onboarding isolation
```

(Also available: `smoke:retell-signed`, `smoke:retell-dates`, `smoke:retell-orders`.)

## Repo layout

| Path | What lives there |
|---|---|
| `apps/backend/src` | routes → services → repositories; `workers/` for async queues |
| `apps/backend/db/migrations` | plain-SQL migrations run by a custom runner (`db:migrate`) |
| `apps/frontend/src` | dashboard + landing SPA (`pages/`, `components/`, `features/`, `hooks/`, `lib/`) |
| `apps/kds/src` | kitchen display app |
| `deploy/` | nginx config, Retell config snapshots, ops **runbooks** (rollback, backup/restore, onboarding rollout) |
| `plan-phases/` | original 4-week MVP build plan (historical record) |
| `CLAUDE.md` | the deep-dive engineering guide — architecture, invariants, deploy detail |
| `AGENTS.md` | concise coding-agent rules and repo conventions |
| `SECURITY.md` | vulnerability reporting and security invariants |

## Deployment (summary)

- **Backend**: Cloud Run services `voxtable-prod-api` and `voxtable-prod-worker` in `bp-voxtable-prod`, backed by Cloud SQL `voxtable-prod-postgres`. A successful CI run on `main` deploys production and runs the migration job before rolling services.
- **Frontend**: Firebase Hosting in `bp-voxtable-prod`. Build with `VITE_API_BASE_URL` pointing at the production Cloud Run API.
- **KDS**: Firebase Hosting in `bp-voxtable-prod`, deployed by the frontend workflow alongside the dashboard.
- **Sandbox**: `core-central-vm` and its local Postgres data are non-production. They are not a production fallback or migration source.
- Local build commands: `npm run build:backend` / `build:frontend` / `build:kds`. Production execution and migrations are owned by the deployment workflows.

## Environments — staging first, always

Every test is run in staging before the same change is made in production. This includes
functional, integration, smoke, end-to-end, call-battery, onboarding, KDS, payment,
rehearsal and destructive tests. It covers code (`integration` → staging, promoted to
`main` → production) and vendor configuration where no pipeline can enforce it.

Production is never a test environment. After deployment, only non-mutating `/health` and
`/readyz` checks, configuration read-backs and monitoring are allowed. Do not place test
calls, create test bookings or orders, send test messages, exercise test payments, or run
synthetic probes that write production state.

Dummy, fixture, synthetic, rehearsal and seed data must never enter production. Production
data is created only by genuine customer activity or an explicitly authorised operational
workflow for a real customer.

**The full doctrine lives in [`CLAUDE.md` → Environments and promotion](CLAUDE.md#environments-and-promotion)**
— what "promote" means for each plane (only one is automatic), which environment owns which
account, how capabilities unavailable in staging are activated without production testing,
and what is mechanically enforced. Telephony specifics are in [`NUMBERS.md`](NUMBERS.md).

Two things that catch people out: **data never promotes** (a venue seeded in staging or the VM
does not exist in production), and a CI-green `main` promotion deploys the Cloud Run backend.

### Branded SMS (ACMA sender ID) — registered, not yet switched on

Australia's SMS Sender ID Register went live on 1 July 2026. Any *alphanumeric* sender ID (a brand name where the phone number would normally be) that isn't registered with ACMA gets replaced with the word **`Unverified`** on the recipient's handset, grouped in with scam messages.

The order matters and we followed it: **register first, change the config second.** You cannot switch on a branded sender and register afterwards.

Status as of 18 August 2026:

- ✅ `Biteperk-production` upgraded off trial
- ✅ Trust Hub Primary Customer Profile **approved** — Bundle SID `BU975db7eebfb0b5525d6762f3d77e2087`
- ✅ **ACMA approved both decisions on 18 Aug** — participation by Biteperk Pty Ltd, and registration of the sender ID **`BitePerk`** (lodged 11 Aug via Twilio Inc., so seven days end to end; no fee requested)
- ✅ **Code side shipped 18 Aug** — `notificationWorker` sends via the Messaging Service (`NOTIFICATIONS_MESSAGING_SERVICE_SID`); `npm run smoke:sms-sender` reads the config back from Twilio and proves delivery
- ⏳ **Not yet in use.** Approval does not change what a handset shows, and neither did the deploy — the remaining steps are console-only: enable the account-wide *Alphanumeric Sender ID* toggle, confirm AU is on in Geo Permissions, and add `BitePerk` as a sender on `voxtable-prod-notifications` with the number kept as fallback — see [`deploy/runbooks/acma-sender-id-registration.md`](deploy/runbooks/acma-sender-id-registration.md) §6

Two things to know. Alphanumeric SMS is **one-way** — recipients cannot reply and `STOP` does not work, so every message needs an alternative opt-out and none may invite a reply (the existing payment-link copy already complies, with a unit test guarding it). And the send uses `messagingServiceSid` rather than a bare `from`: `from` has **no fallback** and fails outright where alphanumeric senders are unsupported. ⚠️ The two are never sent together — Twilio reads that pair as "pin this sender", which would silently un-brand every message even after `BitePerk` is in the pool.

⚠️ A sender ID is bound **per Account SID**. It is registered against production only, so a branded-SMS test on staging measures the wrong thing until staging's SID is added to that ticket — and **the failure is silent**: tested 18 Aug 2026, a staging send delivered from the phone number with no `Unverified` stamp and no error, which looks exactly like success.

Full checklist, evidence pack and decisions: [`deploy/runbooks/acma-sender-id-registration.md`](deploy/runbooks/acma-sender-id-registration.md).

Read `CLAUDE.md` and `deploy/runbooks/` before touching production.
