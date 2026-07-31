# VocoTable Backend

Node 20 + TypeScript + Express backend for VocoTable.

The backend powers:

- Bella's Retell/Twilio voice booking flow.
- Dashboard APIs for reservations, live calls, live tables, menu, orders, analytics, billing, staff, and profile data.
- Multi-tenant onboarding.
- Cal.com mirroring through a durable outbox/inbox.
- Stripe billing and subscription webhooks.
- KDS order polling and mutations.
- Background workers for Cal.com, menu OCR, notifications, provisioning, cleanup, and health alerts.

## Local Setup

From the repository root:

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev:backend
npm run dev:worker
```

The API listens on `http://localhost:3050` by default.

Seed demo data only on demand in local development:

```bash
SEED_DATA=true ./deploy/scripts/run-local.sh
# or, after local migrations:
npm run db:seed
```

The seed command is blocked when `APP_ENV=production`.

## Runtime Split

The backend runs as two Node entrypoints from the same TypeScript codebase:

- `apps/backend/src/server.ts`: HTTP API only.
- `apps/backend/src/worker.ts`: background workers only.

Local Docker Compose runs three backend-side containers:

- `postgres`: database.
- `api`: Express routes on port 3050.
- `worker`: Cal.com outbox, cleanup, health alerts, menu OCR, notifications, and provisioning.

Run the split locally with:

```bash
docker compose up --build postgres api worker
```

The API image is built from `Dockerfile.api`; the worker image is built from
`Dockerfile.worker`.

## Database Migration Strategy

The project keeps raw SQL migrations, but the runner now supports domain
folders under `apps/backend/db/migrations`:

- `core`
- `reservations`
- `voice`
- `menu_orders`
- `billing`
- `integrations`
- `operations`

Because the app is still in development, migrations are maintained as a clean
schema baseline rather than an append-only production chain. Each table has its
own migration file inside its domain folder, and root migration files are
reserved for extensions, schema creation, enum types, and shared functions.

After a migration-history refactor, reset local Postgres before migrating:

```bash
docker compose down -v
docker compose up -d postgres
npm run db:migrate
```

Alembic itself is a Python/SQLAlchemy tool, so it is not a natural fit for this
Node/TypeScript backend. If we want an ORM with Alembic-like typed migrations,
the best TypeScript-native candidates are Drizzle or Prisma; until then, the
raw SQL runner gives us explicit, reviewable migrations without adding another
runtime.

For local smoke testing, keep provider signature flags off unless you are sending real signed requests:

```text
RETELL_VERIFY_SIGNATURE=false
TWILIO_VALIDATE_SIGNATURE=false
CALCOM_SYNC_ENABLED=false
STRIPE_BILLING_ENABLED=false
```

## Checks

```bash
npm run build:backend
npm run test:backend
npm run check
```

Smoke scripts:

```bash
npm run smoke:backend
npm run smoke:retell
npm run smoke:retell-signed
npm run smoke:retell-dates
npm run smoke:retell-orders
npm run smoke:twilio
npm run smoke:calcom
npm run smoke:orders
npm run smoke:isolation
```

There is no broad automated test suite yet. Backend unit tests cover the runtime worker split, and builds plus smoke scripts remain the normal verification path for provider flows.

## Route Areas

Mounted route modules:

- `health.ts`: root and `/health`.
- `availability.ts`: table availability.
- `bookings.ts`: reservation creation, mutation, seating, completion, cancellation.
- `retell.ts`: Retell inbound, lifecycle webhooks, and tool endpoints.
- `twilio.ts`: Twilio fallback voice and status callbacks.
- `cal.ts`: Cal.com webhook and ops health.
- `dashboard.ts`: reservations, call logs, analytics, and tables.
- `menu.ts`: menu category/item CRUD and OCR ingestion.
- `orders.ts`: order and KDS endpoints.
- `billing.ts`: Stripe invoices, payment methods, subscription, portal, checkout.
- `stripeWebhook.ts`: Stripe webhook processing.
- `me.ts`: authenticated identity and memberships.
- `onboarding.ts`: onboarding status, transitions, phone setup, forwarding verification.
- `restaurant.ts`: active restaurant profile.
- `staff.ts`: staff list, invites, role updates, removal.
- `admin.ts`: platform admin provisioning and ops endpoints.

## Architecture Rules

- Keep routes thin. Put business behavior in `services/`, SQL in `repositories/`, and request validation in `http/schemas.ts`.
- Use `withTransaction(async (db) => ...)` for multi-statement writes.
- Validate external payloads with Zod.
- Use `utils/logger.ts` for logs. Do not log raw provider payloads, request bodies, auth headers, tokens, or phone numbers.
- Dashboard routes that touch tenant data should use `requireFirebaseAuth`, then `resolveTenant`, then a role gate when required.
- `X-Restaurant-Id` is never trusted; it is validated against memberships.
- Voice booking must not trust caller-supplied or LLM-supplied restaurant IDs.

## Integrations

### Retell

Retell lifecycle webhook:

```text
{PUBLIC_API_BASE_URL}/retell/webhook
```

Retell inbound context endpoint:

```text
{PUBLIC_API_BASE_URL}/retell/inbound
```

Tool endpoints include:

```text
{PUBLIC_API_BASE_URL}/retell/tools/check-availability
{PUBLIC_API_BASE_URL}/retell/tools/create-booking
```

Additional Retell tools for menu/order flows live in `routes/retell.ts`. Use the smoke scripts before changing tool contracts.

### Twilio

Twilio owns PSTN and SIP routing. The backend also exposes fallback/testing endpoints:

```text
{PUBLIC_API_BASE_URL}/twilio/voice
{PUBLIC_API_BASE_URL}/twilio/status
```

### Cal.com

Cal.com sync is behind `CALCOM_SYNC_ENABLED`. The voice booking path writes to Postgres first and queues Cal.com work in the durable outbox, so Cal.com downtime does not block callers.

### Stripe

Billing is behind `STRIPE_BILLING_ENABLED`.

- Checkout and portal sessions are tenant-scoped.
- Webhooks drive subscription state and onboarding transitions.
- Production requires Stripe secret key, price ID, and webhook secret when billing is enabled.

### Provisioning

Automatic telephony provisioning is behind `PROVISIONING_AUTO_ENABLED`. When it is off, production provisioning is admin-assisted through `/api/admin/*`. Local development has guarded non-production shortcuts so onboarding can be exercised without buying numbers.

## Deployment

Production backend runs on the GCP VM with Docker Compose, fronted by nginx and certbot. See:

- [`docs/gcp-deployment.md`](./docs/gcp-deployment.md)
- [`docs/provisioning-runbook.md`](./docs/provisioning-runbook.md)
- [`../../deploy/runbooks`](../../deploy/runbooks)

Production start command:

```bash
npm run build:backend
npm run start:backend
```

Production migration command:

```bash
npm run db:migrate:prod
```
