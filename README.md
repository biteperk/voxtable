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

- **Backend**: GCP VM `core-central-vm` (project `vocotable-497209`) via `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`, fronted by nginx + certbot at `https://api.biteperk.com.au` (migrating from `vocotable.algorythmos.com.au` — see `deploy/runbooks/domain-migration.md`).
- **Frontend**: Firebase Hosting target `app` (`vocotable.web.app`, branded production URLs allowed by CORS). Build with `VITE_API_BASE_URL` pointing at the API before `firebase deploy --only hosting:app`.
- **KDS**: Firebase Hosting target `kds`, deployed separately with `npm run build:kds && firebase deploy --only hosting:kds`.
- Production builds: `npm run build:backend` / `build:frontend` / `build:kds`; run with `start:backend`; migrate with `db:migrate:prod`.

## Environments — staging first, always

Every environment in this project is paired: something is proven in staging before the same change is made in production. That applies to code (`integration` → staging, promoted to `main` → production) and equally to the third-party consoles, where there is no pipeline to enforce it.

**Twilio has two BitePerk accounts** under one organisation, owned by `twilio@biteperk.com.au` and switched with the account picker at the top-left of the console:

| Account | Account SID | State (13 Aug 2026) |
|---|---|---|
| `Biteperk-staging` | `AC8116857da2064ef3251533f3ade56f32` | Active · owns `+61 468 203 234` · $11.75, **no auto-recharge** |
| `Biteperk-production` | `ACd423bd09e9649e552a0b6d19a9eed338` | Active · owns `+61 468 202 846` · $11.75, **no auto-recharge** |

**Check which account is selected before changing anything** — the two consoles look nearly identical. Number purchases, Messaging Services, sender IDs, SIP trunks and webhook URLs all go into staging first. Twilio has no promote step: "promotion" means repeating the change by hand in the production account, so write down what you did.

> ⚠️ **A third account exists and it is not ours.** The live AU voice number behind the `algorythmos` SIP trunk sits on the **Algorythmos** account `AC949756ac8dc4aced25b15b2e0bbb3a61` — a separate project BitePerk is migrating away from. It was suspended for lack of funds on 5 Aug 2026, which is why that line stopped answering. Before quoting, wiring or testing **any** number, read [`NUMBERS.md`](NUMBERS.md): it is the telephony source of truth and the four numbers are not interchangeable.

### Branded SMS (ACMA sender ID) — in flight

Australia's SMS Sender ID Register went live on 1 July 2026. Any *alphanumeric* sender ID (a brand name where the phone number would normally be) that isn't registered with ACMA gets replaced with the word **`Unverified`** on the recipient's handset, grouped in with scam messages.

**We have no exposure right now** — VoxTable sends SMS from the Twilio number, not a sender ID. So this is pre-emptive work, and the order matters: **register first, change the config second.** You cannot switch on a branded sender and register afterwards.

Status as of 13 August 2026:

- ✅ `Biteperk-production` upgraded off trial
- ✅ Trust Hub Primary Customer Profile **approved** — Bundle SID `BU975db7eebfb0b5525d6762f3d77e2087`
- ⏳ `BitePerk` sender ID **lodged 11 Aug and in review** — Twilio ticket `28926493`
- ⏳ ABR authorised-contact email + myID identity — outstanding, and both are slow

⚠️ A sender ID is bound **per Account SID**. It is registered against production only, so SMS sent from `Biteperk-staging` is stamped `Unverified` on the handset regardless of approval — a branded-SMS test on staging measures the wrong thing until staging's SID is added to that ticket.

Full checklist, evidence pack and decisions: [`deploy/runbooks/acma-sender-id-registration.md`](deploy/runbooks/acma-sender-id-registration.md).

Read `CLAUDE.md` and `deploy/runbooks/` before touching production.
