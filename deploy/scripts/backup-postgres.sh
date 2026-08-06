#!/usr/bin/env bash
# =============================================================================
# VocoTable — Automated PostgreSQL Backup Script
# =============================================================================
#
# Runs pg_dump from the postgres Docker container, compresses the output with
# gzip, uploads it to the GCS bucket the restore runbook reads from, and
# deletes LOCAL copies older than 7 days (bucket retention is a lifecycle
# rule on the bucket itself, not this script).
#
# The upload is the part that matters: deploy/runbooks/backup-restore.md
# restores from gs://vocotable-backups/, so a backup that only exists on the
# VM's own disk is not a backup — the disaster it protects against takes the
# disk with it. An upload failure is therefore a hard failure: logged,
# posted to Slack (when OPS_SLACK_WEBHOOK_URL is in the env file), exit 1.
#
# Usage:
#   ./backup-postgres.sh                # Manual run
#   deploy/cron/vocotable-backup       # Committed cron.d unit (install once)
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - gcloud CLI authenticated with write access to the backup bucket
#   - /opt/vocotable/.env file with POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
#     (optional: BACKUP_BUCKET to override the bucket, OPS_SLACK_WEBHOOK_URL)
#
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ENV_FILE="/opt/vocotable/.env"
BACKUP_DIR="/opt/vocotable/backups"
COMPOSE_DIR="/opt/vocotable"
RETENTION_DAYS=7
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="/var/log/vocotable/backup.log"

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
log() {
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$message"
    # Append to log file if the directory exists
    if [ -d "$(dirname "$LOG_FILE")" ]; then
        echo "$message" >> "$LOG_FILE"
    fi
}

# Best-effort Slack post — a backup failure at 3am must land somewhere a
# human looks. Keep messages free of double quotes; they are interpolated
# into JSON verbatim.
notify_slack() {
    if [ -n "${OPS_SLACK_WEBHOOK_URL:-}" ]; then
        curl -m 5 -s -X POST -H 'content-type: application/json' \
            -d "{\"text\": \":rotating_light: $1\"}" \
            "$OPS_SLACK_WEBHOOK_URL" >/dev/null 2>&1 || true
    fi
}

fail() {
    log "ERROR: $1"
    notify_slack "VoxTable backup FAILED: $1"
    exit 1
}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
    log "ERROR: Environment file not found at $ENV_FILE"
    exit 1
fi

# Source environment variables
# shellcheck disable=SC1090
source "$ENV_FILE"

# Validate required env vars
: "${POSTGRES_USER:?POSTGRES_USER is not set in $ENV_FILE}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set in $ENV_FILE}"
: "${POSTGRES_DB:?POSTGRES_DB is not set in $ENV_FILE}"

# The bucket the restore runbook reads from. Overridable from the env file.
BACKUP_BUCKET="${BACKUP_BUCKET:-vocotable-backups}"

if ! command -v gcloud >/dev/null 2>&1; then
    fail "gcloud CLI not found — the backup cannot reach gs://${BACKUP_BUCKET}."
fi

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# ---------------------------------------------------------------------------
# Perform backup
# ---------------------------------------------------------------------------
BACKUP_FILE="${BACKUP_DIR}/vocotable_${TIMESTAMP}.sql.gz"

log "Starting PostgreSQL backup..."
log "  Database: ${POSTGRES_DB}"
log "  User:     ${POSTGRES_USER}"
log "  Output:   ${BACKUP_FILE}"

# Run pg_dump inside the postgres container, pipe through gzip
if docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T postgres \
    pg_dump \
        -U "$POSTGRES_USER" \
        -d "$POSTGRES_DB" \
        --no-owner \
        --no-privileges \
        --clean \
        --if-exists \
        --format=plain \
    | gzip -9 > "$BACKUP_FILE"; then

    # Verify the backup file is not empty
    if [ -s "$BACKUP_FILE" ]; then
        BACKUP_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
        log "Backup completed successfully: ${BACKUP_FILE} (${BACKUP_SIZE})"
    else
        rm -f "$BACKUP_FILE"
        fail "Backup file is empty — pg_dump produced no output."
    fi
else
    rm -f "$BACKUP_FILE"
    fail "pg_dump failed. Check that the postgres container is running."
fi

# ---------------------------------------------------------------------------
# Upload to GCS — the copy that survives losing the VM
# ---------------------------------------------------------------------------
REMOTE_PATH="gs://${BACKUP_BUCKET}/$(basename "$BACKUP_FILE")"
log "Uploading to ${REMOTE_PATH}..."

if gcloud storage cp "$BACKUP_FILE" "$REMOTE_PATH" >/dev/null 2>&1; then
    log "Upload complete: ${REMOTE_PATH}"
else
    # Keep the local copy — it is now the only one that exists.
    fail "Upload to gs://${BACKUP_BUCKET} failed. Local copy kept at ${BACKUP_FILE}; the restore runbook depends on this bucket."
fi

# ---------------------------------------------------------------------------
# Prune old backups
# ---------------------------------------------------------------------------
log "Pruning backups older than ${RETENTION_DAYS} days..."

DELETED_COUNT=0
while IFS= read -r old_backup; do
    rm -f "$old_backup"
    log "  Deleted: ${old_backup}"
    DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "$BACKUP_DIR" -name "vocotable_*.sql.gz" -type f -mtime +${RETENTION_DAYS})

if [ "$DELETED_COUNT" -eq 0 ]; then
    log "  No old backups to delete."
else
    log "  Deleted ${DELETED_COUNT} old backup(s)."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
REMAINING_COUNT="$(find "$BACKUP_DIR" -name "vocotable_*.sql.gz" -type f | wc -l)"
TOTAL_SIZE="$(du -sh "$BACKUP_DIR" | cut -f1)"

log "Backup summary:"
log "  Total backups: ${REMAINING_COUNT}"
log "  Total size:    ${TOTAL_SIZE}"
log "Done."

exit 0
