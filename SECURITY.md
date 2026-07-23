# SECURITY.md

## Security Policy

VocoTable handles restaurant operations data, customer names and phone numbers, call logs, reservations, payment metadata, webhook events, and third-party integration credentials. Treat all production data and secrets as sensitive.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately. Do not open a public GitHub issue for security reports.

Send a concise report to the project owner or Biteperk/VocoTable maintainer with:

- Affected component or route.
- Steps to reproduce.
- Impact and severity estimate.
- Any logs or screenshots with secrets and personal data redacted.
- Whether the issue is already being exploited or only theoretical.

If you are working in this repo as an internal agent or collaborator, stop making further risky changes once you identify a serious auth, tenant-isolation, payment, webhook-signature, or secret-exposure issue. Document the finding and ask for review before continuing.

## Scope

In scope:

- Backend API routes in `apps/backend/src`.
- React dashboard and onboarding flows in `apps/frontend/src`.
- Kitchen display app in `apps/kds`.
- Database migrations and repository queries.
- Retell, Twilio, Cal.com, Stripe, Firebase, SendGrid, Sentry, and Slack integrations.
- Deployment configuration under `deploy/`.

Out of scope unless explicitly authorised:

- Attacks against third-party providers themselves.
- Denial-of-service testing against production infrastructure.
- Social engineering, phishing, or credential harvesting.
- Accessing, exporting, or modifying real customer data beyond what is needed to prove the issue.

## Critical Security Invariants

### Authentication and Authorization

- Dashboard APIs must require Firebase authentication when `DASHBOARD_VERIFY_AUTH=true`.
- Production must use a non-empty `DASHBOARD_ALLOWED_EMAILS` allowlist.
- Tenant-scoped dashboard routes must resolve the active restaurant with `resolveTenant`.
- `X-Restaurant-Id` is only a client selector. The backend must validate it against the authenticated user's memberships.
- Role gates must be enforced server-side with `requireMemberRole(...)`; frontend role checks are UX only.

### Tenant Isolation

- A user must never read or mutate another restaurant's reservations, menu, tables, orders, billing data, staff, onboarding state, or call logs.
- Repository calls on dashboard surfaces should be scoped by the resolved tenant restaurant ID.
- Multi-tenant dashboard work does not imply multi-tenant voice routing. Voice booking must not trust LLM-provided or caller-provided `restaurant_id`.

### Webhooks

- Retell, Twilio, Cal.com, and Stripe webhooks must verify signatures in production.
- Signature middleware must be path-scoped so it does not break unrelated routes or leave webhook routes unprotected.
- Webhook handlers should be idempotent where provider retries are possible.
- Raw webhook bodies required for signature verification must not be logged.

### Billing

- Stripe secret keys, webhook secrets, customer IDs, payment method IDs, and checkout/portal session details must not be exposed in logs or client-rendered error messages.
- Stripe webhook state transitions must be idempotent and must not skip provisioning safeguards.
- Production billing must not use development bypasses or local-only fallbacks.

### Provisioning and External Costs

- `PROVISIONING_AUTO_ENABLED` controls automated phone number and Retell agent provisioning.
- Any flow that buys Twilio numbers or provisions paid resources must verify the restaurant is still eligible immediately before spending money.
- Local/dev shortcuts must be gated out of production.

### Logging and Error Handling

- Use `utils/logger.ts` for backend logs.
- Do not log raw request bodies, Authorization headers, cookies, Firebase tokens, Stripe keys, webhook secrets, API keys, E.164 phone numbers, or full provider payloads.
- Client-facing errors should be actionable but generic enough not to leak provider internals or secrets.
- Sentry context must not include secrets or personal data beyond what is necessary and approved.

## Secrets

Never commit real secrets. This includes:

- `.env` files with live credentials.
- Firebase service-account JSON.
- Retell, Twilio, Cal.com, Stripe, SendGrid, Slack, Sentry, or Google Cloud credentials.
- Private keys, webhook signing secrets, bearer tokens, session cookies, or exported database dumps.

Use `.env.example` for placeholder names only. Production secrets belong in the deployment environment or mounted secret files as documented in `CLAUDE.md`.

### Container hardening

- Runs as a non-root user (appuser, uid 1000).
- No pip cache, no .pyc, headless Streamlit with usage telemetry disabled.
- Only src/ is copied in; tests, sample data, local outputs, and .env are excluded via .dockerignore.
- A HEALTHCHECK probes Streamlit's /_stcore/health endpoint.
- For a hardened build, pin the base image by digest (python:3.11-slim@sha256:...) and rebuild from a trusted internal registry mirror.

## Data Handling

Customer and restaurant data can include names, phone numbers, call recordings or transcripts, booking notes, order details, billing metadata, and operational analytics.

- Minimize data copied into logs, issues, screenshots, prompts, and local fixtures.
- Redact phone numbers, emails, names, tokens, and provider IDs when sharing debugging context.
- Do not use production data in local development unless explicitly approved.

## Security Review Checklist

Before merging or deploying changes that touch auth, tenancy, billing, webhooks, provisioning, logging, or deployment:

- Run the relevant build command, usually `npm run check` or the narrow build command.
- Run relevant smoke scripts when backend behavior changes.
- Confirm production-only protections remain enforced by `config/env.ts`.
- Confirm dev-only bypasses check `env.APP_ENV !== "production"`.
- Confirm new logs are PII-safe.
- Confirm tenant-scoped queries use the resolved restaurant ID.
- Confirm provider errors do not leak secrets to the frontend.

## Incident Response

If a secret is exposed:

1. Revoke or rotate it immediately with the provider.
2. Remove it from the repo, logs, screenshots, or issue text where possible.
3. Check whether the exposed credential was used.
4. Redeploy with the rotated secret.
5. Document the timeline and affected systems.

If tenant isolation, payment, or webhook verification is broken:

1. Disable the affected feature flag if available.
2. Stop background workers if they can worsen impact.
3. Preserve logs needed for investigation, without copying sensitive payloads into public channels.
4. Patch and verify with focused smoke tests.
5. Review whether any customer or restaurant data was exposed or modified.
