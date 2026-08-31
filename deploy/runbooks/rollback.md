# Rollback runbook — VocoTable backend

When a deploy goes wrong and prod is hurting, **don't debug first**. Roll back, then debug from a healthy state. Target time-to-revert: **under 5 minutes** from "we have a problem" to "service restored."

This runbook covers the three concrete failure modes we've seen or planned for.

---

## Failure mode 1 — new image crash-loops on boot

**Symptoms:** `docker ps` shows `vocotable-api-1` in `Restarting (1)` or `Restarting (137)`. Health check fails. Logs show a fatal startup error (e.g., schema fixture rejection from Sweep A, env validation failure, port already in use).

**Recovery (≈90s):**

```bash
# 1. SSH the VM
gcloud compute ssh core-central-vm --zone us-central1-a

# 2. Confirm which image is broken (it'll be the freshest, named "vocotable-api:latest")
sudo docker images --filter "reference=vocotable-api" --format \
  "table {{.Tag}}\t{{.CreatedSince}}\t{{.Size}}"

# 3. Roll back by re-tagging the previous good image to :latest
#    (We tag every prod image as :pre-YYYYMMDD-<short-sha> before deploy —
#     see "Image tagging policy" below.)
sudo docker tag vocotable-api:latest                vocotable-api:broken-$(date +%Y%m%d-%H%M%S)
sudo docker tag vocotable-api:pre-<YYYYMMDD>-<sha>  vocotable-api:latest

# 4. Restart api on the rolled-back image
cd /opt/vocotable && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --no-deps --force-recreate api

# 5. Verify healthy
for i in $(seq 1 10); do
  s=$(sudo docker inspect vocotable-api-1 --format '{{.State.Health.Status}}')
  echo "$(date +%H:%M:%S) $s"; [ "$s" = "healthy" ] && break; sleep 3
done

# 6. Smoke
curl -sf https://vocotable.algorythmos.com.au/health
```

**Then,** open an issue on the broken commit and roll forward properly once fixed. Don't re-deploy the broken image to "see if it fixes itself."

---

## Failure mode 2 — Cal.com sync misbehaving (false bookings, retry storm, etc.)

**Symptoms:** outbox depth climbing without draining, dashboard `/api/ops/calcom-health` reports breaker open AND outbox not draining within 5 min, or Cal.com is showing bookings that don't exist in our DB.

**Recovery (≈30s, voice path UNAFFECTED):**

```bash
# 1. Flip the flag — disables the outbox executor + /cal/webhook
gcloud compute ssh core-central-vm --zone us-central1-a --command='
  sudo sed -i.bak "s/^CALCOM_SYNC_ENABLED=true/CALCOM_SYNC_ENABLED=false/" /opt/vocotable/.env &&
  cd /opt/vocotable &&
  sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
'

# 2. Confirm flag is off
curl -sw "%{http_code}\n" https://vocotable.algorythmos.com.au/cal/webhook -X POST \
  -H "content-type: application/json" -d '{}' | tail -1
# expect: 410
```

The voice booking path (`/retell/*`) is untouched — Bella keeps taking calls and writing to Postgres. Only the Cal.com mirror stops.

**If outbox has dead-letters that shouldn't be retried after the fix:**
```sql
UPDATE outbox_calcom SET failed_at = now() WHERE succeeded_at IS NULL AND failed_at IS NULL;
```

**To resume Cal.com sync after the fix:** reverse step 1, then for any rows you want to retry:
```sql
UPDATE outbox_calcom SET failed_at = NULL, attempts = 0, next_attempt_at = now()
  WHERE failed_at IS NOT NULL AND <your filter>;
```

---

## Failure mode 3 — migration breaks reads / writes

**Symptoms:** new column doesn't exist, query times out on a missing index, FK constraint blocks an insert.

**Recovery (≈3 min if reversible):**

```bash
# 1. SSH VM and identify the migration
gcloud compute ssh core-central-vm --zone us-central1-a
sudo docker exec vocotable-postgres-1 psql -U vocotable -d vocotable \
  -c "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 3;"

# 2. Manually undo the destructive DDL. Examples for the kinds of things we've shipped:
#    - Drop a column added by mistake:
#        ALTER TABLE reservations DROP COLUMN IF EXISTS <new_col>;
#    - Drop a unique index that's blocking writes:
#        DROP INDEX IF EXISTS <bad_idx>;
#
# 3. Delete the migration row so the runner thinks it never ran:
sudo docker exec vocotable-postgres-1 psql -U vocotable -d vocotable \
  -c "DELETE FROM schema_migrations WHERE filename = '<bad_filename.sql>';"

# 4. Roll the api image back too (see Failure mode 1) so the new code that
#    expected the new column isn't running.
```

**If the migration is NOT reversible (e.g. ALTER TYPE ADD VALUE, data lost to DROP COLUMN):**
- Restore from the most recent daily pg_dump. See `backup-restore.md`.
- Coordinate with Abhishek before doing this — there may be writes since the backup.

---

## Failure mode 4 — someone deleted or force-pushed `main`

**This happened on 2 Aug 2026.** A promotion PR was opened with `main` as its *head* branch
(`main → integration`); merging it offered the usual "Delete branch" button, and that button
deleted `main` itself. Production kept serving — the VM does not read GitHub — but every
deploy dispatch failed with `HTTP 422: No ref found for: main` until the branch was restored.

**Prevention:** never open a PR whose head branch is `main`. To bring `main`'s history back
into `integration`, merge locally and push, or branch off `main` first and PR that branch.
(Branch protection would block the deletion outright, but it needs a paid plan on private
repos — revisit before the production cutover.)

**Recovery — find the real commit first.** Do not assume the newest release tag is right:
tags are pushed only when the version in `package.json` changes, so a promotion that reuses a
version leaves its commit untagged. On 2 Aug, tag `0.1.0` pointed at the *previous*
promotion; restoring from it would have resurrected the crash-looping build.

```bash
# The authoritative answer: what did the last SUCCESSFUL production deploy actually deploy?
gh run list --repo biteperk/voxtable --workflow deploy-backend.yml \
  --status success --limit 5 --json headSha,createdAt,displayTitle

# Cross-check against the merge commit of the last promotion PR (base main).
gh pr list --repo biteperk/voxtable --base main --state merged --limit 3 \
  --json number,mergeCommit,title

# Restore the branch at that commit (deleting a branch never deletes its commits).
git push origin <full-sha>:refs/heads/main

# Confirm, then re-dispatch the deploy if one was blocked.
git ls-remote origin main
```

**Durable anchors.** `prod-YYYY-MM-DD` tags mark exactly what production ran on a given day
and never collide with the semver tags CI pushes. `prod-2026-08-02` marks the currently
deployed commit. Keep cutting one at each promotion; `git tag --points-at origin/main` should
never come back empty.

---

## Image tagging policy (pre-deploy step you should already be doing)

Every prod deploy follows this sequence:

```bash
# On the VM, before swapping the new image in:
SHA=$(cd /opt/vocotable && sudo git rev-parse --short HEAD)
sudo docker tag vocotable-api:latest vocotable-api:pre-$(date +%Y%m%d)-$SHA

# Keep the last 5; prune older ones to save disk:
sudo docker images --filter "reference=vocotable-api:pre-*" --format "{{.Tag}}" \
  | sort -r | tail -n +6 | xargs -I {} sudo docker rmi vocotable-api:{}
```

If you forgot to tag before deploying, look at `docker image history` to see if the prior layers are still around — they often are for ~24h after a rebuild.

---

## When in doubt

1. **Flip the Cal.com flag off first** — that's free and reversible.
2. **Roll the api image back second** — known good baseline.
3. **Only touch the DB last** — and only after telling Abhishek in chat.

You'll always be able to take voice bookings as long as Postgres + api are up. Cal.com mirror is a nice-to-have, not a service.

## Cloud Run revision rollback — drilled, not theoretical

Executed on staging 30 Aug 2026 (issue #138), so the first real incident is not the first
rehearsal. Measured, not estimated:

```
gcloud run services update-traffic voxtable-stg-api \
  --to-revisions <previous-revision>=100 \
  --project bp-voxtable-stg --region australia-southeast1
```

- Roll back to previous revision (00097 → 00096): **14 s**, `/health` = `{"status":"ok","database":"ok"}`, `/readyz` 200.
- Restore to latest (00096 → 00097): **14 s**, same green checks.
- Traffic verified back at 100% on latest afterwards.

Discipline for the real thing: print the known-good restore command BEFORE shifting anything,
so the abort path exists before the risk does. Production is the same command against
`voxtable-prod-api` in `bp-voxtable-prod` once the cutover lands.
