# Production configuration hardening

Production configuration is managed by Terraform and Secret Manager in `bp-voxtable-prod` and is
consumed by Cloud Run. Required values are enforced by `apps/backend/src/config/env.ts`.

`core-central-vm` is a sandbox. Its `.env`, credentials and compose configuration must not be used
to populate, compare or repair production configuration.

Before promotion, test the complete configuration and behaviour in staging. Verify required
production variables in the platform repository, secret bindings, least-privilege service accounts,
Cloud SQL roles, webhook signature gates and feature-flag dependencies by inspection.
After apply, confirm the latest Cloud Run revision is ready, read configuration back without
mutation, and monitor it. Never run functional or state-changing probes against production.

Dummy, fixture, synthetic, rehearsal and seed data must never be written to production.
