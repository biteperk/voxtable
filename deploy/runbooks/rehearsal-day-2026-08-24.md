# Retired: 24 August VM rehearsal

This procedure was written under the incorrect assumption that `core-central-vm` was production.
The VM is sandbox-only, so its deployment, database migration and credential steps must not be
executed for production.

All rehearsals run against `bp-voxtable-stg` Cloud Run, Cloud SQL, Firebase and staging vendor
accounts. Use `staging-call-battery.md`, `apps/backend/docs/gcp-deployment.md`, and the current
voice-line declarations. Production receives only non-mutating health/readiness checks,
configuration read-backs and monitoring. Sandbox or staging data is never copied into production.
