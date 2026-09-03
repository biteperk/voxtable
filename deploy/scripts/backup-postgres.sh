#!/usr/bin/env bash
# =============================================================================
# VoxTable sandbox — local PostgreSQL backup script
# =============================================================================
#
# SANDBOX ONLY. Runs pg_dump from a Docker Postgres container. This is not a
# production backup; production uses Cloud SQL automated backups and PITR.
#
# Usage:
#   ./backup-postgres.sh                # Manual run
#   0 3 * * * /opt/vocotable/deploy/scripts/backup-postgres.sh  # Cron (daily 3 AM)
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - /opt/vocotable/.env file with POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
#   - /opt/vocotable/backups/ directory exists (script will create if missing)
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
# Logging helper
# ---------------------------------------------------------------------------
log() {
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$message"
    # Append to log file if the directory exists
    if [ -d "$(dirname "$LOG_FILE")" ]; then
        echo "$message" >> "$LOG_FILE"
    fi
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
        log "ERROR: Backup file is empty. Removing."
        rm -f "$BACKUP_FILE"
        exit 1
    fi
else
    log "ERROR: pg_dump failed. Check that the postgres container is running."
    rm -f "$BACKUP_FILE"
    exit 1
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
