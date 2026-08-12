# Backup + restore runbook — VocoTable Postgres

We pg_dump nightly to a GCS bucket (provisioned 2026-05-25, see observation 6987). This runbook covers two things:

1. **Verify the backup chain is actually working** — periodic drill so we discover the failure before we need the backup.
2. **Restore from backup** — the actual disaster step.

---

## Daily verification (5 minutes once a week)

```bash
# 1. Confirm the cron ran and a fresh file landed in GCS
gcloud storage ls gs://vocotable-backups-497209/ --recursive | tail -5

# 2. Spot-check the most recent dump — list its tables without restoring
gcloud storage cp gs://vocotable-backups-497209/<latest>.sql.gz /tmp/
gunzip -c /tmp/<latest>.sql.gz | head -200 | grep -E "^(--|CREATE TABLE|COPY)"

# Should see: schema_migrations, restaurants, customers, reservations, tables,
# call_logs, outbox_calcom, inbox_calcom_events
```

If anything's missing, the cron is silently broken — fix before you need it.

---

## Full restore drill (do once before launch, then quarterly)

Goal: prove the dump actually restores to a working DB, and that the restored row counts roughly match prod (±whatever was written since the snapshot).

```bash
# On any workstation (or staging VM if you have one):

# 1. Pull yesterday's backup
gcloud storage cp gs://vocotable-backups-497209/$(date -v-1d +%Y%m%d).sql.gz /tmp/

# 2. Spin up a throwaway Postgres
docker run -d --rm --name pg-restore-test \
  -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16

# 3. Restore into it
gunzip -c /tmp/$(date -v-1d +%Y%m%d).sql.gz | \
  docker exec -i pg-restore-test psql -U postgres

# 4. Compare row counts against prod (read-only)
echo "RESTORED:"
docker exec pg-restore-test psql -U postgres -d vocotable -c \
  "SELECT 'reservations' AS t, count(*) FROM reservations
   UNION ALL SELECT 'customers', count(*) FROM customers
   UNION ALL SELECT 'call_logs', count(*) FROM call_logs
   UNION ALL SELECT 'outbox_calcom', count(*) FROM outbox_calcom;"

echo "PROD:"
gcloud compute ssh core-central-vm --zone us-central1-a --command='
  sudo docker exec vocotable-postgres-1 psql -U vocotable -d vocotable -c "
    SELECT '"'"'reservations'"'"' AS t, count(*) FROM reservations
    UNION ALL SELECT '"'"'customers'"'"', count(*) FROM customers
    UNION ALL SELECT '"'"'call_logs'"'"', count(*) FROM call_logs
    UNION ALL SELECT '"'"'outbox_calcom'"'"', count(*) FROM outbox_calcom;"
'

# 5. Tear down
docker rm -f pg-restore-test
```

Expected: restored counts ≤ prod counts (only new rows since the backup window). If restored > prod, something's wrong with the backup pipeline.

---

## Actual disaster restore

This is the procedure when prod is gone — DB corruption, accidental DELETE FROM, accidental DROP DATABASE.

**Before you start:** TAKE A SNAPSHOT OF THE CURRENT STATE. Even broken data is evidence + a restore option if the backup also fails.

```bash
# 1. SSH the VM
gcloud compute ssh core-central-vm --zone us-central1-a

# 2. Stop the api so it can't write more
cd /opt/vocotable && sudo docker compose stop api

# 3. Snapshot the current (broken) DB
sudo docker exec vocotable-postgres-1 pg_dump -U vocotable vocotable | \
  gzip > /tmp/pre-restore-snapshot-$(date +%Y%m%d-%H%M%S).sql.gz

# 4. Pull the backup to restore from. Pick which day — usually yesterday.
gcloud storage cp gs://vocotable-backups-497209/<filename>.sql.gz /tmp/

# 5. Drop and recreate the DB
sudo docker exec vocotable-postgres-1 psql -U vocotable -d postgres -c \
  "DROP DATABASE vocotable; CREATE DATABASE vocotable;"

# 6. Restore
gunzip -c /tmp/<filename>.sql.gz | \
  sudo docker exec -i vocotable-postgres-1 psql -U vocotable -d vocotable

# 7. Verify
sudo docker exec vocotable-postgres-1 psql -U vocotable -d vocotable -c \
  "SELECT count(*) FROM reservations; SELECT max(applied_at) FROM schema_migrations;"

# 8. Restart api
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --no-deps api

# 9. Smoke
curl -sf https://vocotable.algorythmos.com.au/health
```

**After the restore:** any reservations between the backup snapshot and the incident are lost. Check the Retell call history for that window and manually re-enter any that resulted in confirmed bookings. Coordinate with Ali.

---

## Backup gaps we know about

- **No point-in-time recovery (PITR).** A daily pg_dump can lose up to 24h of bookings. For ≤ 10 calls/day this is acceptable; revisit when traffic grows.
- **GCS bucket lifecycle is 30 days** (per observation 6987). Older backups auto-delete. If you need long retention, copy to a different bucket before day 30.
- **No automated restore verification.** The "Daily verification" section above is manual. Cron-ify after launch.


---

## What actually runs the backups (verified 2026-08-03)

There are **two independent backup mechanisms**. Know which one you are relying on.

| | Offsite chain (the real one) | Local script |
|---|---|---|
| Bucket / path | `gs://vocotable-backups-497209/` — australia-southeast1 (Sydney) | `/opt/vocotable/backups/` on the VM only |
| Filename | `db-YYYYMMDD-062501.sql.gz` | `vocotable_YYYYMMDD_030001.sql.gz` |
| Runs at | 06:25 UTC daily | 03:00 UTC daily, root cron |
| Driven by | service account `vocotable-backups@vocotable-497209.iam.gserviceaccount.com` ("VocoTable daily DB backups"), **from a machine outside GCP** | `deploy/scripts/backup-postgres.sh` |
| Offsite? | Yes | **No** |

Verified 2026-08-03: 31 objects, newest `db-20260803-062501.sql.gz`, schema
identical to the local dump of the same day (`call_logs`, `customers`,
`agreement_acceptances`, `legal_notices`, `menu_*`, …).

### Two things to know before you change anything

1. **`core-central-vm` cannot write to GCS.** Its OAuth scopes are
   `devstorage.read_only`, `logging.write`, `monitoring.write`,
   `service.management.readonly`, `servicecontrol`, `trace.append`. Adding a
   `gcloud storage cp` to `backup-postgres.sh` will fail no matter what IAM you
   grant. Changing instance scopes requires stopping the VM.

2. **The 06:25 job does not run on this VM, and its host is not yet
   identified.** It is not root cron, not a GitHub Actions schedule, not Cloud
   Scheduler (that API is disabled), and there is no VM in any Sydney zone. The
   service account holds a user-managed key created 2026-05-25 and never
   rotated, so some machine outside GCP is holding that JSON key, reaching
   production Postgres, and uploading the dump.

   That key currently has **`roles/storage.objectAdmin`**, which means the
   holder can *delete* every backup, not merely add new ones. Downgrade to
   `objectCreator` once the host is identified — but **do not delete the key
   before then**, because it is the only offsite chain you have.

### Open actions

- [ ] Identify the machine running the 06:25 dump.
- [ ] Downgrade the backup SA from `objectAdmin` to `objectCreator`.
- [ ] Rotate the 2026-05-25 key and record where the replacement lives.
- [ ] Enable object versioning or a retention policy on the bucket.
- [ ] Decide the fate of the redundant 03:00 local-only script — retire it, or
      give the VM write scope and make it the documented chain.
