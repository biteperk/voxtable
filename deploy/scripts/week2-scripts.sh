#!/usr/bin/env bash
# =============================================================================
# Week 2 gate — paste-ready commands
# =============================================================================
# Do NOT run this file top to bottom. It is four separate blocks that run in
# different places, as different identities. Copy one block at a time.
#
#   BLOCK 1  Cloud Shell, signed in as biteperk@gmail.com
#   BLOCK 2  Cloud Shell, signed in as skalaliya@gmail.com
#   BLOCK 3  Cloud Shell, signed in as skalaliya@gmail.com  (verification)
#   BLOCK 4  Cloud Shell, signed in as skalaliya@gmail.com  (Track L SQL)
#
# Why Cloud Shell and not the VM: core-central-vm's OAuth scopes are
# devstorage.read_only + logging/monitoring/trace only. It cannot write to
# Secret Manager or GCS no matter what IAM you grant it. Changing instance
# scopes requires stopping the VM. Cloud Shell runs as you, with full scope.
# =============================================================================


# -----------------------------------------------------------------------------
# BLOCK 1 — as biteperk@gmail.com
# Prepare the new biteperk-owned project to receive the secret.
# -----------------------------------------------------------------------------
gcloud config set project bp-voxtable-prod

gcloud services enable secretmanager.googleapis.com

# Let your other identity write the secret into this project.
gcloud projects add-iam-policy-binding bp-voxtable-prod \
  --member="user:skalaliya@gmail.com" \
  --role="roles/secretmanager.admin"


# -----------------------------------------------------------------------------
# BLOCK 2 — as skalaliya@gmail.com
# Copy production .env straight from the VM into Secret Manager.
# The file is never written to Cloud Shell disk and never printed.
# -----------------------------------------------------------------------------
gcloud config set project vocotable-497209

gcloud compute ssh core-central-vm \
  --zone=us-central1-a \
  --tunnel-through-iap \
  --quiet \
  --command="sudo cat /opt/vocotable/.env" \
| gcloud secrets create voxtable-prod-env \
    --project=bp-voxtable-prod \
    --replication-policy=automatic \
    --data-file=-

# If the secret already exists and you are adding a newer snapshot instead:
#
# gcloud compute ssh core-central-vm --zone=us-central1-a --tunnel-through-iap \
#   --quiet --command="sudo cat /opt/vocotable/.env" \
# | gcloud secrets versions add voxtable-prod-env \
#     --project=bp-voxtable-prod --data-file=-


# -----------------------------------------------------------------------------
# BLOCK 3 — as skalaliya@gmail.com
# Verify the copy is faithful WITHOUT either of us reading a single value.
# The two hashes must match exactly.
# -----------------------------------------------------------------------------
echo "--- hash on the VM ---"
gcloud compute ssh core-central-vm \
  --zone=us-central1-a --tunnel-through-iap --quiet \
  --command="sudo sha256sum /opt/vocotable/.env | cut -d' ' -f1"

echo "--- hash of what landed in Secret Manager ---"
gcloud secrets versions access latest \
  --secret=voxtable-prod-env \
  --project=bp-voxtable-prod \
| sha256sum | cut -d' ' -f1

# Sanity: one enabled version, and confirm nothing leaked into shell history.
gcloud secrets versions list voxtable-prod-env --project=bp-voxtable-prod


# -----------------------------------------------------------------------------
# BLOCK 4 — Track L, section 4 call volumes (read-only SELECT)
# Run from the VM. Counts only; no row data leaves the database.
# -----------------------------------------------------------------------------
gcloud compute ssh core-central-vm --zone=us-central1-a --tunnel-through-iap --quiet \
  --command='cd /opt/vocotable && sudo docker compose -f docker-compose.yml exec -T postgres \
    psql -U "$(sudo grep -m1 ^POSTGRES_USER /opt/vocotable/.env | cut -d= -f2)" \
         -d "$(sudo grep -m1 ^POSTGRES_DB   /opt/vocotable/.env | cut -d= -f2)" \
         -c "SELECT count(*) AS total_calls,
                    count(*) FILTER (WHERE transcript IS NOT NULL)    AS with_transcript,
                    count(*) FILTER (WHERE recording_url IS NOT NULL) AS with_recording,
                    min(started_at) AS earliest_call
             FROM call_logs;"'


# =============================================================================
# SEPARATE ISSUE — the backup service account key
# =============================================================================
# gs://vocotable-backups-497209 is written daily at 06:25 UTC by
#   vocotable-backups@vocotable-497209.iam.gserviceaccount.com
#   ("VocoTable daily DB backups")
# It holds a USER-MANAGED key, id 67dfba833205030eb197e309ef25ac9dcde11273,
# created 2026-05-25 and never rotated. A machine outside GCP holds that JSON
# key. It is not core-central-vm — that VM cannot write to GCS at all.
#
# Do NOT delete the key until you know which machine runs the job; deleting it
# silently stops your only offsite backup.
#
# Inspect who has been using it (run as skalaliya@gmail.com):
gcloud logging read \
  'protoPayload.authenticationInfo.principalEmail="vocotable-backups@vocotable-497209.iam.gserviceaccount.com"' \
  --project=vocotable-497209 --limit=20 \
  --format="table(timestamp, protoPayload.requestMetadata.callerIp, protoPayload.methodName)"

# Once identified, tighten it: Object Admin lets that key DELETE every backup
# you have. Object Creator is enough to write new ones.
#
# gcloud storage buckets remove-iam-policy-binding gs://vocotable-backups-497209 \
#   --member="serviceAccount:vocotable-backups@vocotable-497209.iam.gserviceaccount.com" \
#   --role="roles/storage.objectAdmin"
