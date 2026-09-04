# Production backup and restore — Cloud SQL

Production data lives only in Cloud SQL instance `voxtable-prod-postgres` in
project `bp-voxtable-prod`. Cloud SQL automated backups and point-in-time
recovery are the production recovery mechanisms.

`core-central-vm` and its local Postgres database are sandbox resources. Their
dumps, cron jobs and GCS objects are not production backups and must never be
restored or merged into production.

## Routine verification

At least quarterly, verify in the infrastructure configuration and Cloud SQL:

- automated backups are enabled;
- point-in-time recovery is enabled;
- transaction-log retention satisfies the recovery objective;
- the newest backup completed successfully;
- deletion protection and the intended retention settings remain enabled.

Use a non-production restored instance for drills. A backup listing is not proof
that the data can be restored and read.

## Restore drill

1. Select a production backup or timestamp.
2. Restore it to a new, isolated Cloud SQL instance in the production region.
3. Connect using the Cloud SQL Auth Proxy and a dedicated drill credential.
4. Compare schema migration head and representative table counts with the source.
5. Run read-only application checks against the restored instance.
6. Destroy the drill instance after recording results.

Do not point a serving Cloud Run revision at a drill database.

## Production recovery

For accidental deletion or corruption:

1. Stop or disable the writer responsible for the damage.
2. Record the incident timestamp and choose a recovery point immediately before it.
3. Preserve the current database as evidence; do not overwrite it in place.
4. Restore to a new Cloud SQL instance using point-in-time recovery.
5. Reconcile row counts, `schema_migrations`, tenant memberships, reservations,
   call logs, orders and integration outboxes.
6. Have the database switch reviewed before changing the production secret or
   connection target.
7. Roll Cloud Run services and verify `/health`, `/readyz`, authentication and a
   representative venue flow.

Application rollback and database recovery are separate operations. See
`rollback.md` for Cloud Run revision rollback.

## Sandbox backups

Sandbox data may be backed up for experiment reproducibility, but every such
artifact must be labelled sandbox. It has no production retention guarantee and
is not part of disaster recovery.
