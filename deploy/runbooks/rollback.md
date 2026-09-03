# Production rollback — Cloud Run and Cloud SQL

Production runs in `bp-voxtable-prod`. `core-central-vm` is a sandbox and is
never a rollback target.

Target time to restore the application path is under five minutes. Roll back
first; investigate after service is healthy.

## API or worker revision failure

List revisions and identify the last known-good one:

```bash
gcloud run revisions list \
  --service voxtable-prod-api \
  --project bp-voxtable-prod \
  --region australia-southeast1
```

Before changing traffic, prepare the command that returns the service to normal
automatic deployment routing:

```bash
gcloud run services update-traffic voxtable-prod-api \
  --to-latest \
  --project bp-voxtable-prod \
  --region australia-southeast1
```

Route the API to the known-good revision:

```bash
gcloud run services update-traffic voxtable-prod-api \
  --to-revisions <known-good-revision>=100 \
  --project bp-voxtable-prod \
  --region australia-southeast1
```

Repeat for `voxtable-prod-worker` if the worker revision is faulty. Verify API
`/health` and `/readyz`, worker logs, and the affected user path.

After the fix is deployed, use `--to-latest`. Leaving traffic pinned to a named
revision prevents later deployments from serving even when they succeed.

## Migration job failure

The deployment workflow must not roll API or worker services after a failed
`voxtable-prod-migrate` execution.

1. Read the migration job execution logs.
2. Confirm which filename was last recorded in `schema_migrations`.
3. Fix forward with a new append-only migration whenever possible.
4. Do not edit an already-applied migration.
5. Do not run migrations against, or restore data from, the sandbox VM.

If a migration committed destructive or corrupting changes, coordinate a Cloud
SQL point-in-time recovery following `backup-restore.md`. Application revision
rollback does not reverse database changes, so migrations must remain compatible
with the previously serving revision.

## Integration kill switches

For an isolated provider failure, turn off the relevant production feature flag
through the production Terraform configuration and apply it. Examples include
`CALCOM_SYNC_ENABLED`, `STRIPE_BILLING_ENABLED`, `NOTIFICATIONS_ENABLED`, and
`PROVISIONING_AUTO_ENABLED`.

Do not edit a VM `.env` as a production response. Confirm the new Cloud Run
revision is ready and verify the disabled endpoint or worker behavior.

## Production data recovery

Use Cloud SQL automated backups or point-in-time recovery. Restore into a new
instance first, reconcile it, and only then perform a reviewed database switch.
Never restore the sandbox VM database into production.

## Branch recovery

If `main` is deleted or moved, identify the last successful production workflow
SHA and restore the branch at that commit. Cloud Run continues serving its
deployed revision while the Git branch is repaired.
