# AGENTS.md

> 🏷️ **Naming anything? Read [`NAMES.md`](NAMES.md) first** — the naming SSOT for
> products, hostnames, GCP/Terraform resources, and the legacy identities that must
> never rename. Never type an infrastructure name from memory; check the registry.

Guidance for AI coding agents and other automated assistants working in this repository.

## Project Summary

VoxTable is a voice-AI booking platform for restaurants, built by Biteperk Pty Ltd. Customers call a restaurant number, Twilio routes the call to Retell AI's voice agent Bella, Bella checks availability and creates bookings through the Express backend, and the React dashboard shows reservations, live calls, tables, menus, orders, billing, and onboarding state.

The original MVP restaurant is Natalia's Bistro in Sydney. Multi-tenant dashboard/onboarding exists, but inbound voice routing is still intentionally conservative and tied to configured restaurant routing until explicitly rolled out.

Use `CLAUDE.md` as the detailed architecture guide. Treat `apps/backend/docs/architecture_diagram.md` as stale unless its banner says otherwise.

## Commands

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed

npm run dev:backend
npm run dev:frontend
npm run dev:kds

npm run check
npm run build:backend
npm run build:frontend
npm run build:kds
```

Smoke checks are the main verification path:

```bash
npm run smoke:backend
npm run smoke:retell
npm run smoke:twilio
npm run smoke:calcom
npm run smoke:orders
npm run smoke:isolation
```

There is no broad automated test suite by design. Do not add a new test framework casually; use focused build checks and smoke scripts unless the task clearly needs more.

## Repository Layout

- `apps/backend/src`: Express backend. Routes are thin; services own business logic; repositories own SQL.
- `apps/backend/db/migrations`: plain SQL migrations run by the custom migration runner.
- `apps/frontend/src`: React/Vite dashboard and landing app. Routing is path-based in `main.jsx`; no react-router.
- `apps/kds`: separate Vite kitchen display app.
- `deploy`: nginx config, Retell snapshots, and operational runbooks.
- `plan-phases`: historical MVP plan.

## Backend Rules

- Validate external input with Zod at the boundary.
- Use `withTransaction(async (client) => ...)` for multi-statement writes. Do not split one logical write over multiple pool connections.
- Keep route middleware path-scoped. For example, webhook/signature middleware must not accidentally apply to unrelated endpoints.
- Dashboard routes should use `requireFirebaseAuth -> resolveTenant -> requireMemberRole(...)` where tenant scoping is required.
- Never trust `X-Restaurant-Id`; it is only a selector. `resolveTenant` must validate membership.
- Voice-path restaurant IDs are intentionally constrained. Do not make voice booking multi-tenant by accepting caller or LLM supplied `restaurant_id`.
- Use repository helpers where they exist instead of duplicating SQL in route handlers.
- All logs must go through `utils/logger.ts`; do not log raw errors, request bodies, headers, tokens, phone numbers, or webhook payloads with `console.error`.

## Frontend Rules

- Keep the path-based router in `apps/frontend/src/main.jsx` unless there is a deliberate migration plan.
- Use `api.js` for backend calls so Firebase tokens and `X-Restaurant-Id` are attached consistently.
- Dashboard pages should stay tenant-aware through `useAuth()` memberships and active restaurant state.
- Preserve role-gated navigation: kitchen/server/manager surfaces are intentionally different.
- During onboarding, keep `/manage-menu` reachable because the wizard depends on it.

## Security-Sensitive Areas

Be especially careful with:

- Firebase auth and allowlists in `auth/firebaseAuth.ts`.
- Tenant resolution in `auth/tenantContext.ts`.
- Webhook signature verification for Retell, Twilio, Cal.com, and Stripe.
- Billing and Stripe webhook state transitions.
- Provisioning workers that can buy phone numbers or bind Retell agents.
- Logging, Sentry context, and any code touching secrets or PII.

## Environment Flags

Most risky integrations are behind kill switches that default off:

- `STRIPE_BILLING_ENABLED`
- `MENU_OCR_ENABLED`
- `NOTIFICATIONS_ENABLED`
- `PROVISIONING_AUTO_ENABLED`
- `MULTITENANCY_LEGACY_FALLBACK`
- `CALCOM_SYNC_ENABLED`

Production env validation requires the relevant credentials when a feature flag is enabled. Do not bypass those checks.

## Database Notes

Migrations are plain SQL and are applied in lexical order by `apps/backend/src/db/migrate.ts`. Keep migrations idempotent where practical and avoid hand-editing applied migrations. If a generated-column or multi-statement migration trips node-pg protocol errors, follow the existing manual `psql -f` pattern documented in `CLAUDE.md`.

Dates for reservations are restaurant-local wall-clock `DATE` and `TIME`; lifecycle timestamps are `TIMESTAMPTZ`.

## Deployment Notes

Read `CLAUDE.md` and `deploy/runbooks/` before production changes.

Backend production runs on the GCP VM behind nginx. Frontend runs on Firebase Hosting. Build the frontend with `VITE_API_BASE_URL` pointing at the production API before deploy.

## Working Style

- Keep changes small and aligned with existing patterns.
- Do not revert unrelated local changes.
- Prefer `rg` for searching.
- Run the narrowest useful verification command after edits.
- If a task touches production, billing, auth, tenant isolation, provisioning, or webhooks, state the risk and verification clearly in the final summary.
