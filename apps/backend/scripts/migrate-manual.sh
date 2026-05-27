#!/usr/bin/env bash
#
# Apply a single migration via `psql -f` and record it in schema_migrations.
# Use this only when the regular Node migration runner (`npm run db:migrate`)
# fails with a node-pg `08P01 invalid message format` error — that happens on
# multi-statement DDL that contains `GENERATED ALWAYS AS` (or similar) which
# pg's extended-query protocol can't pipeline in a single client.query().
#
# Migration 003 hit this; if you author another multi-statement DDL that
# trips it, run this script to land the file and mark it applied, then keep
# moving.
#
# Usage:
#   ./scripts/migrate-manual.sh apps/backend/db/migrations/00X_thing.sql
#
# Requires DATABASE_URL (or PG* env vars) in the environment.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <path-to-migration-file>" >&2
  exit 2
fi

FILE="$1"
if [[ ! -f "$FILE" ]]; then
  echo "error: $FILE does not exist" >&2
  exit 2
fi

BASENAME="$(basename "$FILE")"

if [[ -z "${DATABASE_URL:-}" && -z "${PGHOST:-}" ]]; then
  echo "error: DATABASE_URL or PG* env vars required" >&2
  exit 2
fi

PSQL_TARGET=("--no-psqlrc" "--single-transaction" "--set=ON_ERROR_STOP=1")
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL_TARGET+=("$DATABASE_URL")
fi

echo "[migrate-manual] applying $BASENAME..."
psql "${PSQL_TARGET[@]}" -f "$FILE"

echo "[migrate-manual] recording in schema_migrations..."
psql "${PSQL_TARGET[@]}" -c \
  "INSERT INTO schema_migrations (filename) VALUES ('$BASENAME') ON CONFLICT DO NOTHING;"

echo "[migrate-manual] done."
