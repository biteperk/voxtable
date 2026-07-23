#!/usr/bin/env bash
# =============================================================================
# VocoTable - Local Platform Runner
# =============================================================================
#
# Starts the local development platform:
#   - Ensures .env exists and has Docker Compose Postgres variables
#   - Starts Postgres with Docker Compose
#   - Runs database migrations and seed data
#   - Starts backend, frontend, and KDS dev servers
#
# Usage:
#   ./deploy/scripts/run-local.sh
#
# Optional environment variables:
#   SKIP_INSTALL=true   Skip npm install when node_modules is missing
#   SKIP_SEED=true      Skip db:seed
#   START_KDS=false     Do not start the KDS dev server
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"

POSTGRES_USER_DEFAULT="vocotable"
POSTGRES_PASSWORD_DEFAULT="vocotable"
POSTGRES_DB_DEFAULT="vocotable"
POSTGRES_PORT_DEFAULT="55432"
LOCAL_HOST_DEFAULT="localhost"

BACKEND_PID=""
FRONTEND_PID=""
KDS_PID=""

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "ERROR: Required command not found: $1"
    exit 1
  fi
}

append_env_if_missing() {
  local key="$1"
  local value="$2"

  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i -E "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

remove_blank_optional_env() {
  local key="$1"

  sed -i -E "/^${key}=[[:space:]]*(#.*)?$/d" "$ENV_FILE"
}

cleanup() {
  log "Stopping local dev processes..."

  for pid in "$KDS_PID" "$FRONTEND_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}

trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

require_command docker
require_command npm

LOCAL_HOST="${LOCAL_HOST:-$LOCAL_HOST_DEFAULT}"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://${LOCAL_HOST}:3050}"
export VITE_DEV_HOST="${VITE_DEV_HOST:-0.0.0.0}"

if [ ! -f "$ENV_FILE" ]; then
  if [ ! -f "$ENV_EXAMPLE" ]; then
    log "ERROR: Cannot create .env because .env.example is missing."
    exit 1
  fi

  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log "Created .env from .env.example. Review it before using external integrations."
fi

append_env_if_missing "POSTGRES_USER" "$POSTGRES_USER_DEFAULT"
append_env_if_missing "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD_DEFAULT"
append_env_if_missing "POSTGRES_DB" "$POSTGRES_DB_DEFAULT"
append_env_if_missing "POSTGRES_PORT" "$POSTGRES_PORT_DEFAULT"

if grep -q "^DATABASE_URL=postgres://vocotable:vocotable@localhost:5432/vocotable" "$ENV_FILE"; then
  set_env_value "POSTGRES_PORT" "$POSTGRES_PORT_DEFAULT"
  set_env_value "DATABASE_URL" "postgres://vocotable:vocotable@localhost:${POSTGRES_PORT_DEFAULT}/vocotable"
fi

# The backend treats optional number/URL env vars as invalid when they are
# present-but-empty. .env.example keeps them visible for documentation, so clean
# blank local assignments before running any Node entrypoints that parse env.
remove_blank_optional_env "CALCOM_EVENT_TYPE_ID"
remove_blank_optional_env "CALCOM_DAILY_QUOTA_THRESHOLD"
remove_blank_optional_env "OPS_SLACK_WEBHOOK_URL"
remove_blank_optional_env "SENTRY_DSN"
remove_blank_optional_env "MENU_OCR_BASE_URL"

if [ ! -d "${REPO_ROOT}/node_modules" ]; then
  if [ "${SKIP_INSTALL:-false}" = "true" ]; then
    log "node_modules is missing and SKIP_INSTALL=true, so npm install was skipped."
  else
    log "Installing npm dependencies..."
    npm install
  fi
fi

log "Starting Postgres..."
docker compose up -d postgres

log "Running database migrations..."
npm run db:migrate

if [ "${SKIP_SEED:-false}" = "true" ]; then
  log "Skipping seed data because SKIP_SEED=true."
else
  log "Seeding local database..."
  npm run db:seed
fi

log "Starting backend on http://localhost:3050 ..."
npm run dev:backend &
BACKEND_PID="$!"

log "Starting frontend on http://localhost:3051 ..."
npm run dev:frontend &
FRONTEND_PID="$!"

if [ "${START_KDS:-true}" = "true" ]; then
  log "Starting KDS dev server on http://localhost:3052 ..."
  npm run dev:kds &
  KDS_PID="$!"
else
  log "Skipping KDS because START_KDS=false."
fi

log "Local platform is starting. Press Ctrl+C to stop dev servers."
log "Vite API base URL: ${VITE_API_BASE_URL}"
log "Postgres remains running in Docker Compose; stop it with: docker compose down"

wait -n
