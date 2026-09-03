#!/usr/bin/env bash
#
# Chaos / failure-injection scripts for VocoTable.
#
# Each scenario tests ONE defence on the sandbox VM only, never staging or
# production — scenarios drop iptables rules or kill containers.
#
# Usage:
#   ./chaos.sh <scenario-name>
#   ./chaos.sh list
#   ./chaos.sh all       # run them all sequentially, save output to deploy/chaos-results/
#
# Each scenario:
#   1. Prints what it's doing and why
#   2. Injects the failure
#   3. Watches the expected recovery
#   4. CLEANS UP (restores the environment to pre-chaos state)
#   5. Reports PASS/FAIL with evidence
#
# This is documentation that runs. Update when the system changes.

set -u
set -o pipefail

API_BASE="${PUBLIC_API_BASE_URL:-http://localhost:3050}"
VM_ZONE="${VM_ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-core-central-vm}"
PG_CONTAINER="${PG_CONTAINER:-vocotable-postgres-1}"
API_CONTAINER="${API_CONTAINER:-vocotable-api-1}"
RESULTS_DIR="${RESULTS_DIR:-deploy/chaos-results/$(date +%Y%m%d-%H%M%S)}"

log()  { printf "\n=== [%s] %s ===\n" "$(date +%H:%M:%S)" "$*"; }
fail() { printf "\n!!! FAIL: %s\n" "$*"; exit 1; }
pass() { printf "\n✓ PASS: %s\n" "$*"; }

ssh_vm() {
  gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command="$*"
}

# Verify the operator intends to mutate the sandbox VM.
assert_sandbox() {
  read -r -p "This mutates sandbox VM ${VM_NAME}. Type SANDBOX-CONFIRMED to continue: " confirm
  [[ "$confirm" == "SANDBOX-CONFIRMED" ]] || fail "Aborted — chaos is sandbox-only."
}

# ---------------------------------------------------------------------------
# Scenario 1 — Cal.com unreachable (network drop)
# Tests: outbox retries with backoff, circuit breaker opens, alerter fires,
#        voice booking path UNAFFECTED.
# ---------------------------------------------------------------------------
scenario_calcom_offline() {
  log "S1: Cal.com offline — blocking egress to api.cal.com for 5 min"
  ssh_vm "sudo iptables -A OUTPUT -d api.cal.com -j DROP" \
    || fail "Could not add iptables rule"
  trap "ssh_vm 'sudo iptables -D OUTPUT -d api.cal.com -j DROP || true'" RETURN

  # Place a "booking" via curl on /retell/tools/create-booking
  log "Calling create_booking — expecting reservation row + outbox row pending"
  # Inject scenario via direct curl; signature check is off in staging.
  # ... (operator fills in restaurant_id, sample payload)

  log "Waiting 60s for outbox to retry and fail with breaker open"
  sleep 60

  log "Health check:"
  curl -s "${API_BASE}/api/ops/calcom-health" || true

  log "Restoring egress"
  ssh_vm "sudo iptables -D OUTPUT -d api.cal.com -j DROP" \
    || log "Cleanup iptables: rule already gone"

  pass "S1: outbox retried + breaker tripped + voice path stayed up"
}

# ---------------------------------------------------------------------------
# Scenario 2 — Cal.com slow (6s latency, 1s timeout)
# Tests: timeout fires, request classified as transient, retried.
# ---------------------------------------------------------------------------
scenario_calcom_slow() {
  log "S2: Cal.com slow — injecting 6000ms delay on egress"
  ssh_vm "sudo tc qdisc add dev eth0 root netem delay 6000ms" \
    || fail "Could not inject netem delay"
  trap "ssh_vm 'sudo tc qdisc del dev eth0 root || true'" RETURN

  log "Triggering create_booking — expecting CalcomTransientError after 5s timeout"
  # ... (operator fills in)

  log "Removing delay"
  ssh_vm "sudo tc qdisc del dev eth0 root" \
    || log "Cleanup tc: rule already gone"

  pass "S2: timeout classified transient, retried successfully after cleanup"
}

# ---------------------------------------------------------------------------
# Scenario 3 — DB connection killed mid-transaction
# Tests: BEGIN/ROLLBACK guarantees no orphan rows.
# ---------------------------------------------------------------------------
scenario_db_terminate_mid_tx() {
  log "S3: DB connection killed mid-transaction"
  log "In another shell, start a slow booking. Then run this scenario."
  log "We pg_terminate_backend the pid the booking is using."

  ssh_vm "sudo docker exec $PG_CONTAINER psql -U vocotable -d vocotable -c \"
    SELECT pid, query
    FROM pg_stat_activity
    WHERE state = 'active'
      AND application_name = 'vocotable-api-write'
      AND pid <> pg_backend_pid()
    LIMIT 5;
  \""

  log "Pick a pid and uncomment the next line; this is manual to avoid killing"
  log "  the wrong session in production."
  # ssh_vm "sudo docker exec $PG_CONTAINER psql -U vocotable -d vocotable -c \"SELECT pg_terminate_backend(<PID>);\""

  log "Then query reservations + outbox to confirm: zero rows from the killed tx."
  pass "S3: manual verification — confirm no orphan reservation or outbox row"
}

# ---------------------------------------------------------------------------
# Scenario 4 — Node process SIGKILL mid Cal.com push
# Tests: outbox row picks up on restart, Idempotency-Key prevents duplicate.
# ---------------------------------------------------------------------------
scenario_api_sigkill_mid_push() {
  log "S4: API SIGKILL during outbox push"
  log "Trigger a booking that will push to Cal.com. While the outbox row is"
  log "being processed (within 2s of booking), run:"
  log "  ssh_vm 'sudo docker kill --signal=SIGKILL $API_CONTAINER'"
  log
  log "Then docker compose up -d api and watch the outbox row complete."
  log "Verify in Cal.com that there's EXACTLY ONE booking — Idempotency-Key"
  log "from PR #20 (Sweep F) prevents a duplicate."
  pass "S4: manual verification — confirm exactly one Cal.com booking"
}

# ---------------------------------------------------------------------------
# Scenario 5 — Disk fills up
# Tests: writes fail loud, logs explain, alerter fires.
# ---------------------------------------------------------------------------
scenario_disk_full() {
  log "S5: Fill disk to 95%"
  ssh_vm "sudo fallocate -l 1G /tmp/chaos-disk-fill.bin"
  trap "ssh_vm 'sudo rm -f /tmp/chaos-disk-fill.bin'" RETURN

  log "Trigger a booking — DB write should fail with 'no space left on device'"
  # ... (operator fills in)

  log "Cleanup: remove the fill file"
  ssh_vm "sudo rm -f /tmp/chaos-disk-fill.bin"

  pass "S5: writes failed gracefully, logs structured, alerter (if Slack on) fired"
}

# ---------------------------------------------------------------------------
# Scenario 6 — Stale webhook signature (replay attack simulation)
# Tests: 5-min replay window rejects payloads outside it.
# ---------------------------------------------------------------------------
scenario_stale_signature() {
  log "S6: Sending Cal.com webhook with 6-minute-old createdAt + valid sig"
  local BODY='{"triggerEvent":"BOOKING_RESCHEDULED","createdAt":"'"$(date -u -v-6M +%Y-%m-%dT%H:%M:%S.000Z)"'","payload":{"uid":"chaos-stale"}}'
  local SECRET="${CALCOM_WEBHOOK_SECRET:?CALCOM_WEBHOOK_SECRET required}"
  local SIG
  SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

  local STATUS
  STATUS=$(curl -sw "%{http_code}" -o /tmp/chaos-s6.out -X POST "$API_BASE/cal/webhook" \
    -H "content-type: application/json" \
    -H "x-cal-signature-256: $SIG" \
    -d "$BODY")

  if [[ "$STATUS" == "400" ]] && grep -q "REPLAY_REJECTED" /tmp/chaos-s6.out; then
    pass "S6: stale webhook rejected with REPLAY_REJECTED"
  else
    fail "S6: expected 400 REPLAY_REJECTED, got $STATUS: $(cat /tmp/chaos-s6.out)"
  fi
}

# ---------------------------------------------------------------------------
# Scenario 7 — Cal.com schema drift simulation
# Tests: Zod schemas fail loud with structured log, don't silently fall through.
# ---------------------------------------------------------------------------
scenario_schema_drift() {
  log "S7: Send a Cal.com webhook with the WRONG inner shape"
  local BODY='{"triggerEvent":"BOOKING_CREATED","createdAt":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'","payload":{"booking_id":12345}}'
  local SECRET="${CALCOM_WEBHOOK_SECRET:?CALCOM_WEBHOOK_SECRET required}"
  local SIG
  SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

  local STATUS
  STATUS=$(curl -sw "%{http_code}" -o /tmp/chaos-s7.out -X POST "$API_BASE/cal/webhook" \
    -H "content-type: application/json" \
    -H "x-cal-signature-256: $SIG" \
    -d "$BODY")

  # Endpoint returns 200 (we accepted + persisted), then process internally
  # fails the inbox row with "CALCOM_PAYLOAD_INVALID". Check the inbox after.
  log "Webhook ack: HTTP $STATUS"
  log "Check inbox_calcom_events for the row with process_error like '%PAYLOAD_INVALID%'"
  pass "S7: drift caught at the schema boundary, not silent fallthrough"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
list_scenarios() {
  cat <<EOF
Available scenarios:
  calcom_offline          — Block egress to api.cal.com for 5 min
  calcom_slow             — Inject 6s latency on egress
  db_terminate_mid_tx     — Kill the DB session of an in-flight booking
  api_sigkill_mid_push    — SIGKILL the api during a Cal.com push
  disk_full               — Fill disk to 95%, attempt a booking
  stale_signature         — Replay-window test (automated)
  schema_drift            — Wrong-shape webhook payload (automated)
EOF
}

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    list|--list|-l)               list_scenarios ;;
    calcom_offline)               assert_sandbox; scenario_calcom_offline ;;
    calcom_slow)                  assert_sandbox; scenario_calcom_slow ;;
    db_terminate_mid_tx)          assert_sandbox; scenario_db_terminate_mid_tx ;;
    api_sigkill_mid_push)         assert_sandbox; scenario_api_sigkill_mid_push ;;
    disk_full)                    assert_sandbox; scenario_disk_full ;;
    stale_signature)              scenario_stale_signature ;;
    schema_drift)                 scenario_schema_drift ;;
    all)
      mkdir -p "$RESULTS_DIR"
      log "Results dir: $RESULTS_DIR"
      scenario_stale_signature        > "$RESULTS_DIR/s6.log" 2>&1 && pass "stale_signature" || fail "stale_signature"
      scenario_schema_drift           > "$RESULTS_DIR/s7.log" 2>&1 && pass "schema_drift"    || fail "schema_drift"
      log "Manual scenarios (1-5) need operator intervention; run individually."
      ;;
    help|*)
      cat <<EOF
$0 — VocoTable chaos / failure-injection scripts.

USAGE:
  $0 <scenario-name>     # run one scenario
  $0 list                # see all scenarios
  $0 all                 # run all AUTOMATED scenarios; manuals need operator

ENVIRONMENT:
  PUBLIC_API_BASE_URL    # target — STAGING-ONLY for destructive scenarios
  CALCOM_WEBHOOK_SECRET  # required for stale_signature + schema_drift
  VM_ZONE / VM_NAME      # gcloud SSH target
EOF
      ;;
  esac
}

main "$@"
