#!/usr/bin/env bash
# =============================================================================
# VoxTable — Cloud Run deploy (staging today, production at the Phase 3 cutover)
# =============================================================================
#
# One parameterised script so production is a re-run of the staging rehearsal,
# never separate engineering. Order is load-bearing:
#
#   1. MIGRATE  — a Cloud Run *job* runs db/migrate.js as voxtable_owner and
#                 must exit 0 before any new revision exists. On the VM,
#                 migrations ran while old code was already serving; here new
#                 code cannot take traffic against an old schema.
#   2. DEPLOY   — api (request-serving) + worker (min-instances=1, CPU always
#                 allocated: it is a poller, not a request handler).
#
# Rollback = `gcloud run services update-traffic <svc> --to-revisions PREV=100`
# — the previous revision is immutable and still there.
#
# Usage:
#   PROJECT=bp-voxtable-stg REGION=australia-southeast1 IMAGE_TAG=<sha> \
#     ./deploy-cloudrun.sh
#
# Requirements: gcloud authenticated as a principal with run.admin,
# cloudsql.client, secretmanager.secretAccessor, iam.serviceAccountUser
# (CI: voxtable-stg-deployer via WIF).
# =============================================================================

set -euo pipefail

PROJECT="${PROJECT:?PROJECT is required (e.g. bp-voxtable-stg)}"
REGION="${REGION:-australia-southeast1}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required (registry image tag, e.g. the git sha)}"
REGISTRY="${REGISTRY:-australia-southeast1-docker.pkg.dev/bp-shared-artifacts/voxtable}"
SQL_INSTANCE="${SQL_INSTANCE:-${PROJECT}:${REGION}:voxtable-stg-postgres}"
RUNTIME_SA="${RUNTIME_SA:-voxtable-stg-runtime@${PROJECT}.iam.gserviceaccount.com}"

API_IMAGE="${REGISTRY}/api:${IMAGE_TAG}"
WORKER_IMAGE="${REGISTRY}/worker:${IMAGE_TAG}"

# Non-secret env, shared by api and worker. Secrets are referenced from
# Secret Manager below — nothing sensitive appears here or in CI logs.
#
# APP_ENV=production on staging is deliberate: staging must rehearse the
# fail-closed production ruleset (signature gates on, allowlist enforced),
# differing from production only in credentials and data.
#
# The RETELL_*/TWILIO_* placeholders satisfy the production PRESENCE checks
# while staging has no voice vendor credentials yet: the signature gates stay
# ON, so any signed call simply 401s until a real staging Retell agent and
# Twilio number exist (that step also unlocks the end-to-end phone-call gate).
# `^@^` makes @ the list delimiter so the email allowlist may contain commas.
PUBLIC_URL="${PUBLIC_URL:-https://api-staging.biteperk.com.au}"
ALLOWLIST="${ALLOWLIST:-skalaliya@gmail.com,biteperk@gmail.com}"
BASE_ENV="APP_ENV=production@PUBLIC_API_BASE_URL=${PUBLIC_URL}@DASHBOARD_ALLOWED_EMAILS=${ALLOWLIST}@RETELL_API_KEY=staging-placeholder-no-agent-yet@RETELL_AGENT_ID=staging-placeholder-no-agent-yet@TWILIO_ACCOUNT_SID=staging-placeholder-no-number-yet@TWILIO_AUTH_TOKEN=staging-placeholder-no-number-yet@TWILIO_PHONE_NUMBER=staging-placeholder-no-number-yet@DATABASE_SSL=false"
COMMON_ENV="^@^${BASE_ENV}@PG_APPLICATION_NAME=voxtable-api"
WORKER_ENV="^@^${BASE_ENV}@PG_APPLICATION_NAME=voxtable-worker@PG_POOL_MAX_WRITE=30@PG_POOL_MAX_READ=5"

# DATABASE_URL comes from Secret Manager (db-app-url / db-owner-url) — the
# app role for the services, the owner role ONLY for the migration job.
APP_SECRETS="DATABASE_URL=db-app-url:latest"
MIGRATE_SECRETS="DATABASE_URL=db-owner-url:latest"

echo "==> [1/3] migration job (as voxtable_owner) — must succeed before deploy"
if ! gcloud run jobs describe voxtable-migrate --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
  gcloud run jobs create voxtable-migrate \
    --project="$PROJECT" --region="$REGION" \
    --image="$API_IMAGE" \
    --command=node --args=apps/backend/dist/db/migrate.js \
    --set-env-vars="$COMMON_ENV" \
    --set-secrets="$MIGRATE_SECRETS" \
    --set-cloudsql-instances="$SQL_INSTANCE" \
    --service-account="$RUNTIME_SA" \
    --max-retries=0 --task-timeout=10m
else
  gcloud run jobs update voxtable-migrate \
    --project="$PROJECT" --region="$REGION" \
    --image="$API_IMAGE" \
    --set-env-vars="$COMMON_ENV" \
    --set-secrets="$MIGRATE_SECRETS" \
    --set-cloudsql-instances="$SQL_INSTANCE" \
    --service-account="$RUNTIME_SA"
fi
gcloud run jobs execute voxtable-migrate --project="$PROJECT" --region="$REGION" --wait

echo "==> [2/3] api service"
gcloud run deploy voxtable-api \
  --project="$PROJECT" --region="$REGION" \
  --image="$API_IMAGE" \
  --set-env-vars="$COMMON_ENV" \
  --set-secrets="$APP_SECRETS" \
  --set-cloudsql-instances="$SQL_INSTANCE" \
  --service-account="$RUNTIME_SA" \
  --port=3050 \
  --min-instances=0 --max-instances=3 \
  --memory=512Mi \
  --startup-probe="httpGet.path=/readyz,httpGet.port=3050,initialDelaySeconds=5,periodSeconds=5,failureThreshold=12" \
  --liveness-probe="httpGet.path=/livez,httpGet.port=3050,periodSeconds=30" \
  --allow-unauthenticated

echo "==> [3/3] worker service (poller: always-on CPU, exactly one instance)"
gcloud run deploy voxtable-worker \
  --project="$PROJECT" --region="$REGION" \
  --image="$WORKER_IMAGE" \
  --set-env-vars="$WORKER_ENV" \
  --set-secrets="$APP_SECRETS" \
  --set-cloudsql-instances="$SQL_INSTANCE" \
  --service-account="$RUNTIME_SA" \
  --port=3050 \
  --min-instances=1 --max-instances=1 \
  --no-cpu-throttling \
  --memory=512Mi \
  --startup-probe="httpGet.path=/readyz,httpGet.port=3050,initialDelaySeconds=5,periodSeconds=5,failureThreshold=12" \
  --liveness-probe="httpGet.path=/livez,httpGet.port=3050,periodSeconds=30" \
  --no-allow-unauthenticated

echo "==> deployed ${IMAGE_TAG} to ${PROJECT}"
