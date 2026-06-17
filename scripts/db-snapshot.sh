#!/usr/bin/env bash
# Purpose: Schema-only PG dump for ephemeral PR environments / test fixtures.
#          Strips role grants and DB-version-specific SET headers so the dump
#          replays on any PG 16 instance.
# Trigger: Manual (`make db-snapshot`) + nightly CI archive (future).
# Output:  stdout (caller decides where to put it). Typical use:
#            bash scripts/db-snapshot.sh > /tmp/relay-schema-$(date +%s).sql

set -euo pipefail

# Source .env if present (don't fail if missing; CI passes env directly).
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_USER:=relay}"
: "${POSTGRES_PASSWORD:=relay}"
: "${POSTGRES_DB:=relay}"
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5433}"

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host="$POSTGRES_HOST" \
  --port="$POSTGRES_PORT" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --exclude-schema='langgraph*' \
  --exclude-schema='temp*' \
  | grep -vE '^(SET|SELECT pg_catalog)' \
  | grep -vE '^--'
