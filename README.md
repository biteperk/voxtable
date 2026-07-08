# VocoTable

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
- **apps/frontend** — React 19 SPA (Vite). Pages under `src/pages/{landing,auth,dashboard,billing,onboarding}`; path-based router in `main.jsx` (no react-router). Google sign-in via Firebase.
- **apps/kds** — kitchen display system (separate Vite app, polls the backend for orders).
- **Multi-tenant onboarding** (create restaurant → profile → menu → trial → phone) is merged behind kill-switch env flags that all default off; the inbound voice path is still bound to the single default restaurant.

## Quick start

```bash
npm install
cp .env.example .env        # fill Postgres + (optionally) Retell/Twilio/Cal.com/Stripe creds
npm run db:migrate
npm run db:seed             # idempotent — seeds Natalia's Bistro + tables

npm run dev:backend         # API on http://localhost:3050
npm run dev:frontend        # dashboard on http://localhost:3051
npm run dev:kds             # kitchen display (separate Vite app)
```

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

## Deployment (summary)

- **Backend**: GCP VM `core-central-vm` (project `vocotable-497209`) via `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`, fronted by nginx + certbot at `https://vocotable.algorythmos.com.au`.
- **Frontend**: Firebase Hosting (`vocotable.web.app`, public brand site at `biteperk.com.au`). Build with `VITE_API_BASE_URL` pointing at the API before `firebase deploy --only hosting`.
- Production builds: `npm run build:backend` / `build:frontend` / `build:kds`; run with `start:backend`; migrate with `db:migrate:prod`.

Read `CLAUDE.md` and `deploy/runbooks/` before touching production — including the collaboration note about coordinating with teammates who push directly to `main`.
