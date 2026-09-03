# Retired: VM-to-Cloud Run cutover

This runbook is retired by the production-environment decision of 3 September
2026.

There is no production cutover from `core-central-vm`. The VM is a sandbox and
has never been an authoritative production environment. Its database and
Firebase identities must not be migrated, restored, merged or backfilled into
`bp-voxtable-prod`.

Production starts and remains on:

- Cloud Run `voxtable-prod-api` and `voxtable-prod-worker`
- Cloud Run job `voxtable-prod-migrate`
- Cloud SQL `voxtable-prod-postgres`
- Firebase services in `bp-voxtable-prod`
- BitePerk production vendor accounts and Secret Manager credentials

Use `apps/backend/docs/gcp-deployment.md` for deployment and
`deploy/runbooks/rollback.md` for recovery. Venue launch is an application and
telephony enablement exercise against Cloud Run; it is not an infrastructure or
database cutover from the VM.

The former dump/restore, DNS flip and VM rollback instructions were removed
because executing them would contaminate production with sandbox data and create
a split-brain environment.
