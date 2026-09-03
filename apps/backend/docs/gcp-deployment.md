# VoxTable GCP deployment

## Environment model

Production runs only in `bp-voxtable-prod`:

- Cloud Run service `voxtable-prod-api`
- Cloud Run service `voxtable-prod-worker`
- Cloud Run job `voxtable-prod-migrate`
- Cloud SQL instance `voxtable-prod-postgres`
- Secret Manager for runtime credentials
- Firebase Hosting/Auth/Storage in the production project

Staging mirrors that shape in `bp-voxtable-stg` with `voxtable-stg-*` resources.

`core-central-vm` in `vocotable-497209` is a sandbox. Its Docker Compose stack,
Postgres data, credentials, nginx configuration and IP address are not
production. Never route production traffic to it or copy its data into Cloud SQL.

Infrastructure is managed in `biteperk/biteperk-cloud-platform`. Do not create or
repair production infrastructure from this repository.

## Application deployment

The deployment workflow is `.github/workflows/deploy-backend.yml`:

- a CI-green push to `integration` deploys staging;
- a CI-green promotion to `main` deploys production;
- images come from the shared Artifact Registry project;
- the workflow updates the migration job to the new API image;
- the migration job must succeed before the API and worker roll forward.

Do not hand-deploy production with Docker Compose. `docker-compose*.yml` and
`docker-compose.deploy.yml` are local/sandbox tooling only.

## Database schema

Production schema changes use `voxtable-prod-migrate`, connecting as
`voxtable_owner`. The application services connect as `voxtable_app`.

The migration ledger is `schema_migrations`. Migrations are append-only and must
remain compatible with the previously serving Cloud Run revision so revision
rollback remains possible.

Production data is created only by genuine customer activity or an explicitly
authorised operational workflow for a real customer. Dummy, fixture, synthetic,
rehearsal and seed data are prohibited. Data from staging or the sandbox VM does
not promote and must not be restored into production.

## Verification

After a production deployment, verify:

```bash
gcloud run jobs executions list \
  --job voxtable-prod-migrate \
  --project bp-voxtable-prod \
  --region australia-southeast1 \
  --limit 3

gcloud run services describe voxtable-prod-api \
  --project bp-voxtable-prod \
  --region australia-southeast1 \
  --format='value(status.latestReadyRevisionName,status.url)'

gcloud run services describe voxtable-prod-worker \
  --project bp-voxtable-prod \
  --region australia-southeast1 \
  --format='value(status.latestReadyRevisionName)'
```

Then call `/health` and `/readyz` on the production Cloud Run URL, read back
the deployed configuration, and confirm monitoring is receiving normal signals.
Do not run smoke, functional, integration or synthetic tests against production.
All behavioural testing belongs in staging, and production verification must not
create or mutate application data.

## Rollback

Application rollback is a Cloud Run traffic change to the last known-good
revision. Print the restore-to-latest command before moving traffic:

```bash
gcloud run services update-traffic voxtable-prod-api \
  --to-revisions <known-good-revision>=100 \
  --project bp-voxtable-prod \
  --region australia-southeast1

gcloud run services update-traffic voxtable-prod-api \
  --to-latest \
  --project bp-voxtable-prod \
  --region australia-southeast1
```

Do not use the sandbox VM as rollback. Database recovery uses Cloud SQL backups
and point-in-time recovery; see `deploy/runbooks/backup-restore.md`.

## Frontend and KDS

The frontend workflow deploys the dashboard and KDS to Firebase Hosting for the
same environment. Production bundles must reference the production Cloud Run API
and the `bp-voxtable-prod` Firebase project. Never build production assets with
staging or sandbox identifiers.
