#!/usr/bin/env bash
# =============================================================================
# VocoTable — Health Check Script
# =============================================================================
#
# Curls the /health endpoint and verifies the API + database are healthy.
# Logs the result and optionally sends a webhook notification on failure.
#
# Exit codes:
#   0 = healthy
#   1 = unhealthy or unreachable
#
# Usage:
#   ./healthcheck.sh                  # Manual run
#   */5 * * * * /opt/vocotable/deploy/scripts/healthcheck.sh  # Cron (every 5 min)
#
# Optional environment variables (set in /opt/vocotable/.env or export):
#   HEALTH_CHECK_URL    — Override the health endpoint URL
#   HEALTH_WEBHOOK_URL  — Webhook URL for failure notifications (Slack, Discord, etc.)
#
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ENV_FILE="/opt/vocotable/.env"
LOG_FILE="/var/log/vocotable/healthcheck.log"
HEALTH_CHECK_URL="${HEALTH_CHECK_URL:-https://api.vocotable.com/health}"
TIMEOUT_SECONDS=10
MAX_RETRIES=2
RETRY_DELAY=3

# Source env file if it exists (for HEALTH_WEBHOOK_URL, etc.)
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# ---------------------------------------------------------------------------
# Logging helper
# ---------------------------------------------------------------------------
log() {
    local level="$1"
    shift
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] [${level}] $*"
    echo "$message"
    echo "$message" >> "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# Health check with retries
# ---------------------------------------------------------------------------
attempt=0
healthy=false

while [ $attempt -lt $MAX_RETRIES ]; do
    attempt=$((attempt + 1))

    # Curl the health endpoint; capture HTTP status code and response body
    HTTP_RESPONSE=$(curl \
        --silent \
        --show-error \
        --max-time "$TIMEOUT_SECONDS" \
        --write-out "\n%{http_code}" \
        "$HEALTH_CHECK_URL" 2>&1) || true

    # Split response body and HTTP status code
    HTTP_BODY=$(echo "$HTTP_RESPONSE" | head -n -1)
    HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -n 1)

    # Check for a successful response
    if [ "$HTTP_STATUS" = "200" ]; then
        # Verify the JSON contains "status":"ok"
        if echo "$HTTP_BODY" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
            healthy=true
            break
        else
            log "WARN" "Attempt ${attempt}/${MAX_RETRIES}: HTTP 200 but status is not 'ok'. Body: ${HTTP_BODY}"
        fi
    else
        log "WARN" "Attempt ${attempt}/${MAX_RETRIES}: Health check failed. HTTP status: ${HTTP_STATUS}"
    fi

    # Wait before retrying (unless this was the last attempt)
    if [ $attempt -lt $MAX_RETRIES ]; then
        sleep "$RETRY_DELAY"
    fi
done

# ---------------------------------------------------------------------------
# Handle result
# ---------------------------------------------------------------------------
if [ "$healthy" = true ]; then
    log "OK" "Health check passed. Status: ${HTTP_STATUS}. Body: ${HTTP_BODY}"
    exit 0
fi

# --- Failure path ---

FAILURE_MSG="VocoTable health check FAILED after ${MAX_RETRIES} attempts. URL: ${HEALTH_CHECK_URL}. Last HTTP status: ${HTTP_STATUS}. Last body: ${HTTP_BODY}"

log "ERROR" "$FAILURE_MSG"

# Send webhook notification if configured
if [ -n "${HEALTH_WEBHOOK_URL:-}" ]; then
    log "INFO" "Sending failure notification to webhook..."

    WEBHOOK_PAYLOAD=$(cat <<EOF
{
    "text": "🚨 ${FAILURE_MSG}",
    "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
    "service": "vocotable-api",
    "url": "${HEALTH_CHECK_URL}",
    "http_status": "${HTTP_STATUS}"
}
EOF
    )

    curl \
        --silent \
        --show-error \
        --max-time 10 \
        --header "Content-Type: application/json" \
        --data "$WEBHOOK_PAYLOAD" \
        "$HEALTH_WEBHOOK_URL" \
        >> "$LOG_FILE" 2>&1 || log "ERROR" "Failed to send webhook notification."
fi

exit 1
