# Backup + restore runbook — VocoTable Postgres

We pg_dump nightly and upload to **`gs://vocotable-backups/`** via `deploy/scripts/backup-postgres.sh`, scheduled by the committed cron unit `deploy/cron/vocotable-backup` (03:30 AEST). Files are named `vocotable_YYYYMMDD_HHMMSS.sql.gz`. A local copy is kept on the VM for 7 days as a convenience; **the bucket is the real backup** — bucket retention is a 30-day lifecycle rule on the bucket, not script logic. Upload failures exit non-zero and post to Slack.

> **Honesty note (fixed 6 Aug 2026):** before this date the script wrote local-only and this runbook described a bucket nothing uploaded to. If you are investigating an incident older than that, the bucket will be empty — look in `/opt/vocotable/backups/` on the VM.
>
> **After the Phase 3 cutover** Cloud SQL automated backups + PITR replace this chain entirely; retire the cron unit with the VM.

This runbook covers two things:

1. **Verify the backup chain is actually working** — periodic drill so we discover the failure before we need the backup.
2. **Restore from backup** — the actual disaster step.

---

## Daily verification (5 minutes once a week)

```bash
# 1. Confirm the cron ran and a fresh file landed in GCS
gcloud storage ls gs://vocotable-backups/ --recursive | tail -5

# 2. Spot-check the most recent dump — list its tables without restoring
gcloud storage cp gs://vocotable-backups/<latest>.sql.gz /tmp/
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

# 1. Pull the latest backup (files are vocotable_YYYYMMDD_HHMMSS.sql.gz)
LATEST=$(gcloud storage ls gs://vocotable-backups/ | sort | tail -1)
gcloud storage cp "$LATEST" /tmp/

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
gcloud storage cp gs://vocotable-backups/<filename>.sql.gz /tmp/

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
