#!/usr/bin/env bash
set -euo pipefail

# Creates/updates GitHub Environment variables used by:
# - .github/workflows/deploy-backend.yml
# - .github/workflows/deploy-frontend.yml
#
# The variable names written to GitHub are generic. They are scoped separately
# under the GitHub Environments named "staging" and "production".
#
# Usage:
#   ./scripts/configure-github-env-vars.sh
#
# Optional:
#   TARGET_GITHUB_REPO=biteperk/voxtable ./scripts/configure-github-env-vars.sh

TARGET_GITHUB_REPO="${TARGET_GITHUB_REPO:-}"

# Usually defaults.
REGION="australia-southeast1"
PLATFORM_PROJECT_ID="bp-shared-artifacts"
WORKLOAD_IDENTITY_PROVIDER="projects/194287509090/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
FRONTEND_ARTIFACT_BUCKET="voxtable-frontend-artifacts"
GOOGLE_CLOUD_QUOTA_PROJECT="$PLATFORM_PROJECT_ID"

# Staging: required values to review/update.
STG_PROJECT_ID="bp-voxtable-stg"
STG_DEPLOY_SERVICE_ACCOUNT="voxtable-stg-deployer@bp-voxtable-stg.iam.gserviceaccount.com"
STG_FRONTEND_DEPLOY_SERVICE_ACCOUNT="github-frontend-artifacts@bp-shared-artifacts.iam.gserviceaccount.com"
STG_VITE_API_BASE_URL="https://voxtable-stg-api-198624206590.australia-southeast1.run.app" # REQUIRED: set to staging API URL before frontend artifact builds.
STG_VITE_FIREBASE_API_KEY="AIzaSyAKpQoXeQem7F2z-IdPI_v0J8FhlpetVwc" # REQUIRED: Firebase web app config.
STG_VITE_FIREBASE_AUTH_DOMAIN="bp-voxtable-stg.firebaseapp.com" # REQUIRED: Firebase web app config.
STG_VITE_FIREBASE_STORAGE_BUCKET="bp-voxtable-stg.firebasestorage.app" # REQUIRED: Firebase web app config.
STG_VITE_FIREBASE_MESSAGING_SENDER_ID="198624206590" # REQUIRED: Firebase web app config.
STG_VITE_FIREBASE_APP_ID="1:198624206590:web:72bb448eb75fb906de8faf" # REQUIRED: Firebase web app config.

# Staging: usually defaults.
STG_FIREBASE_PROJECT="$STG_PROJECT_ID"
STG_FIREBASE_APP_SITE="$STG_PROJECT_ID"
STG_FIREBASE_ONLY="hosting:app"
STG_CLOUD_RUN_API_SERVICE="voxtable-stg-api"
STG_CLOUD_RUN_WORKER_SERVICE="voxtable-stg-worker"
STG_CLOUD_RUN_MIGRATION_JOB="voxtable-stg-migrate"
STG_VITE_FIREBASE_PROJECT_ID="$STG_FIREBASE_PROJECT"

# Staging: optional.
STG_FIREBASE_KDS_SITE=""
STG_VITE_GOOGLE_MAPS_KEY=""
STG_VITE_FIREBASE_MEASUREMENT_ID=""
# Empty until staging has its own KDS site (issue #183) — no value, no link.
STG_VITE_KDS_URL=""

# Production: required values to review/update.
PROD_PROJECT_ID="bp-voxtable-prod"
PROD_DEPLOY_SERVICE_ACCOUNT="" # REQUIRED: set to production Cloud Run deployer service account.
PROD_FRONTEND_DEPLOY_SERVICE_ACCOUNT="github-frontend-artifacts@bp-shared-artifacts.iam.gserviceaccount.com"
# The API, not the dashboard: api.biteperk.com.au (NAMES.md §2). This once
# said vocotable.biteperk.com.au — the dashboard's legacy name — and running
# the script would have pushed it into the production build config, where the
# CI bundle check would then have enforced the wrong host.
PROD_VITE_API_BASE_URL="https://api.biteperk.com.au"
PROD_VITE_FIREBASE_API_KEY="" # REQUIRED: Firebase web app config.
# The user-facing dashboard host, NOT <project>.firebaseapp.com. Sign-in runs
# through an iframe/popup on this domain, and Chrome's third-party storage
# partitioning breaks the flow when it is a different origin from the page
# (the "Database is closing/hidden" login failure, 25 Aug 2026). The host is a
# Firebase Hosting custom domain, so it serves /__/auth/* itself and the flow
# stays first-party. When Phase 5 lands, flip this to app.biteperk.com.au.
PROD_VITE_FIREBASE_AUTH_DOMAIN="vocotable.biteperk.com.au"
PROD_VITE_FIREBASE_STORAGE_BUCKET="" # REQUIRED: Firebase web app config.
PROD_VITE_FIREBASE_MESSAGING_SENDER_ID="" # REQUIRED: Firebase web app config.
PROD_VITE_FIREBASE_APP_ID="" # REQUIRED: Firebase web app config.

# Production: usually defaults.
PROD_FIREBASE_PROJECT="$PROD_PROJECT_ID"
PROD_FIREBASE_APP_SITE="$PROD_PROJECT_ID"
PROD_FIREBASE_ONLY="hosting:app"
PROD_CLOUD_RUN_API_SERVICE="voxtable-prod-api"
PROD_CLOUD_RUN_WORKER_SERVICE="voxtable-prod-worker"
PROD_CLOUD_RUN_MIGRATION_JOB="voxtable-prod-migrate"
PROD_VITE_FIREBASE_PROJECT_ID="$PROD_FIREBASE_PROJECT"

# Production: optional.
PROD_FIREBASE_KDS_SITE=""
PROD_VITE_GOOGLE_MAPS_KEY=""
PROD_VITE_FIREBASE_MEASUREMENT_ID=""
# The dashboard's "Open kitchen display" link. Set here because the source no
# longer hardcodes it (that shipped the production KDS into staging bundles).
PROD_VITE_KDS_URL="https://vocotable-kds.web.app"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

detect_repo() {
  local remote_url

  remote_url="$(git config --get remote.origin.url || true)"
  if [[ "$remote_url" =~ github.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
    return
  fi

  echo "TARGET_GITHUB_REPO is required when git remote origin is not a GitHub repo." >&2
  exit 1
}

ensure_environment() {
  local environment="$1"

  echo "Ensuring GitHub environment: ${environment}"
  gh api --method PUT "repos/${TARGET_GITHUB_REPO}/environments/${environment}" >/dev/null
}

set_env_var() {
  local environment="$1"
  local name="$2"
  local value="$3"

  if [[ -z "$value" ]]; then
    echo "Skipping ${environment}.${name}: value is empty"
    return
  fi

  echo "Setting ${environment}.${name}"
  gh variable set "$name" --repo "$TARGET_GITHUB_REPO" --env "$environment" --body "$value"
}

configure_environment() {
  local environment="$1"
  local project_id="$2"
  local deploy_service_account="$3"
  local frontend_deploy_service_account="$4"
  local firebase_project="$5"
  local firebase_app_site="$6"
  local firebase_kds_site="$7"
  local firebase_only="$8"
  local cloud_run_api_service="$9"
  local cloud_run_worker_service="${10}"
  local cloud_run_migration_job="${11}"
  local vite_api_base_url="${12}"
  local vite_google_maps_key="${13}"
  local vite_firebase_api_key="${14}"
  local vite_firebase_auth_domain="${15}"
  local vite_firebase_project_id="${16}"
  local vite_firebase_storage_bucket="${17}"
  local vite_firebase_messaging_sender_id="${18}"
  local vite_firebase_app_id="${19}"
  local vite_firebase_measurement_id="${20}"
  local vite_kds_url="${21}"

  ensure_environment "$environment"

  set_env_var "$environment" "GCP_WORKLOAD_IDENTITY_PROVIDER" "$WORKLOAD_IDENTITY_PROVIDER"
  set_env_var "$environment" "GCP_DEFAULT_REGION" "$REGION"
  set_env_var "$environment" "GCP_DEPLOY_SERVICE_ACCOUNT" "$deploy_service_account"
  set_env_var "$environment" "GCP_FRONTEND_DEPLOY_SERVICE_ACCOUNT" "$frontend_deploy_service_account"
  set_env_var "$environment" "VOXTABLE_PROJECT_ID" "$project_id"
  set_env_var "$environment" "PLATFORM_PROJECT_ID" "$PLATFORM_PROJECT_ID"
  set_env_var "$environment" "FRONTEND_ARTIFACT_BUCKET" "$FRONTEND_ARTIFACT_BUCKET"
  set_env_var "$environment" "GOOGLE_CLOUD_QUOTA_PROJECT" "$GOOGLE_CLOUD_QUOTA_PROJECT"

  set_env_var "$environment" "CLOUD_RUN_API_SERVICE" "$cloud_run_api_service"
  set_env_var "$environment" "CLOUD_RUN_WORKER_SERVICE" "$cloud_run_worker_service"
  set_env_var "$environment" "CLOUD_RUN_MIGRATION_JOB" "$cloud_run_migration_job"

  set_env_var "$environment" "FIREBASE_PROJECT" "$firebase_project"
  set_env_var "$environment" "FIREBASE_APP_SITE" "$firebase_app_site"
  set_env_var "$environment" "FIREBASE_KDS_SITE" "$firebase_kds_site"
  set_env_var "$environment" "FIREBASE_ONLY" "$firebase_only"

  set_env_var "$environment" "VITE_API_BASE_URL" "$vite_api_base_url"
  set_env_var "$environment" "VITE_GOOGLE_MAPS_KEY" "$vite_google_maps_key"
  set_env_var "$environment" "VITE_FIREBASE_API_KEY" "$vite_firebase_api_key"
  set_env_var "$environment" "VITE_FIREBASE_AUTH_DOMAIN" "$vite_firebase_auth_domain"
  set_env_var "$environment" "VITE_FIREBASE_PROJECT_ID" "$vite_firebase_project_id"
  set_env_var "$environment" "VITE_FIREBASE_STORAGE_BUCKET" "$vite_firebase_storage_bucket"
  set_env_var "$environment" "VITE_FIREBASE_MESSAGING_SENDER_ID" "$vite_firebase_messaging_sender_id"
  set_env_var "$environment" "VITE_FIREBASE_APP_ID" "$vite_firebase_app_id"
  set_env_var "$environment" "VITE_FIREBASE_MEASUREMENT_ID" "$vite_firebase_measurement_id"
  set_env_var "$environment" "VITE_KDS_URL" "$vite_kds_url"
}

require_command gh

if [[ -z "$TARGET_GITHUB_REPO" ]]; then
  TARGET_GITHUB_REPO="$(detect_repo)"
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

cat <<EOF
Configuring GitHub Environment variables on ${TARGET_GITHUB_REPO}

GitHub variable names are generic and environment-scoped.
Review the REQUIRED values at the top of this script before running it for real.
EOF

configure_environment \
  "staging" \
  "$STG_PROJECT_ID" \
  "$STG_DEPLOY_SERVICE_ACCOUNT" \
  "$STG_FRONTEND_DEPLOY_SERVICE_ACCOUNT" \
  "$STG_FIREBASE_PROJECT" \
  "$STG_FIREBASE_APP_SITE" \
  "$STG_FIREBASE_KDS_SITE" \
  "$STG_FIREBASE_ONLY" \
  "$STG_CLOUD_RUN_API_SERVICE" \
  "$STG_CLOUD_RUN_WORKER_SERVICE" \
  "$STG_CLOUD_RUN_MIGRATION_JOB" \
  "$STG_VITE_API_BASE_URL" \
  "$STG_VITE_GOOGLE_MAPS_KEY" \
  "$STG_VITE_FIREBASE_API_KEY" \
  "$STG_VITE_FIREBASE_AUTH_DOMAIN" \
  "$STG_VITE_FIREBASE_PROJECT_ID" \
  "$STG_VITE_FIREBASE_STORAGE_BUCKET" \
  "$STG_VITE_FIREBASE_MESSAGING_SENDER_ID" \
  "$STG_VITE_FIREBASE_APP_ID" \
  "$STG_VITE_FIREBASE_MEASUREMENT_ID" \
  "$STG_VITE_KDS_URL"

configure_environment \
  "production" \
  "$PROD_PROJECT_ID" \
  "$PROD_DEPLOY_SERVICE_ACCOUNT" \
  "$PROD_FRONTEND_DEPLOY_SERVICE_ACCOUNT" \
  "$PROD_FIREBASE_PROJECT" \
  "$PROD_FIREBASE_APP_SITE" \
  "$PROD_FIREBASE_KDS_SITE" \
  "$PROD_FIREBASE_ONLY" \
  "$PROD_CLOUD_RUN_API_SERVICE" \
  "$PROD_CLOUD_RUN_WORKER_SERVICE" \
  "$PROD_CLOUD_RUN_MIGRATION_JOB" \
  "$PROD_VITE_API_BASE_URL" \
  "$PROD_VITE_GOOGLE_MAPS_KEY" \
  "$PROD_VITE_FIREBASE_API_KEY" \
  "$PROD_VITE_FIREBASE_AUTH_DOMAIN" \
  "$PROD_VITE_FIREBASE_PROJECT_ID" \
  "$PROD_VITE_FIREBASE_STORAGE_BUCKET" \
  "$PROD_VITE_FIREBASE_MESSAGING_SENDER_ID" \
  "$PROD_VITE_FIREBASE_APP_ID" \
  "$PROD_VITE_FIREBASE_MEASUREMENT_ID" \
  "$PROD_VITE_KDS_URL"

cat <<EOF

Done.

Review with:
  gh variable list --repo ${TARGET_GITHUB_REPO} --env staging
  gh variable list --repo ${TARGET_GITHUB_REPO} --env production
EOF
