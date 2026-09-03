# Multi-tenant onboarding rollout

Production onboarding runs on Cloud Run and Cloud SQL in `bp-voxtable-prod`.
The VM is a sandbox and is not part of this rollout.

## Preconditions

- The change is green in staging after deployment from `integration`.
- Production Terraform contains every required environment value and secret binding.
- The production migration is append-only and compatible with the previous revision.
- Production Firebase Auth providers, Hosting and Storage rules are configured.
- Production vendor credentials point to BitePerk production accounts.
- Relevant kill switches remain off until their dependency is verified.

## Rollout

1. Promote `integration` to `main` through a reviewed PR.
2. Wait for CI and the production migration job to succeed.
3. Verify both Cloud Run services have ready revisions and `/health` plus `/readyz` are green.
4. Create production venue, user and membership data through the production admin/onboarding flow.
5. Enable one feature flag at a time through Terraform and verify the resulting revision.
6. Confirm production health/readiness, read back the effective configuration, and monitor the
   genuine customer rollout. Do not run onboarding flows, test calls, synthetic tenant-isolation
   probes or any other state-changing test in production.

Data from staging or `core-central-vm` never promotes. Do not bootstrap production from a VM dump,
VM SQL, VM `.env` or legacy Firebase export.

All authentication, tenant-isolation, onboarding, KDS and call testing must pass in staging before
promotion. Never create dummy users, venues, memberships, bookings, orders or seed rows in
production.

Rollback follows `rollback.md`: move Cloud Run traffic to the known-good revision or disable the
specific integration. Database recovery uses Cloud SQL PITR, never a sandbox dump.
