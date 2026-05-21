# VocoTable

Voice AI booking platform for restaurants.

Phase 1 builds the smallest end-to-end proof: a test phone call reaches the AI, checks availability, creates a reservation through the backend API, and persists the booking plus call log in Postgres.

## Current Scope
- Node.js + TypeScript backend.
- PostgreSQL schema and migrations.
- Core booking API.
- RetellAI webhook, inbound-call, and custom-function endpoints.
- Twilio telephony webhook/status endpoints and SIP routing docs.
- Railway-ready deploy config.
- Seeded Natalia's Bistro restaurant record.

## Quick Start
```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev:backend
```

In another terminal:

```bash
npm run smoke:backend
npm run smoke:retell
npm run smoke:twilio
```

## Phase Docs
Implementation phases live in [`plan-phases`](./plan-phases).

## Backend
Backend docs live in [`apps/backend`](./apps/backend).

Railway production setup lives in [`apps/backend/docs/railway-production.md`](./apps/backend/docs/railway-production.md).
