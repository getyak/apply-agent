#!/usr/bin/env bash
# Purpose: Enforce migration naming + forward/rollback pairing.
# Trigger: PreToolUse:Write

set -euo pipefail

INPUT="$(cat)"
FILE="$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')"

[[ "$FILE" =~ infra/postgres/migrations/ ]] || exit 0

BASENAME="$(basename "$FILE")"
MIG_DIR="$(dirname "$FILE")"

if [[ ! "$BASENAME" =~ ^[0-9]{3}_[a-z0-9_]+\.(up|down)\.sql$ ]]; then
  cat >&2 <<EOF
[relay/migration-check] BLOCKED: invalid migration filename '$BASENAME'.

Required format:  NNN_snake_case_name.(up|down).sql
Examples:
  011_add_application_events.up.sql
  011_add_application_events.down.sql

Use /migration-new <name> to scaffold both files at once.
EOF
  exit 2
fi

if [[ "$BASENAME" == *.up.sql ]]; then
  PAIR="${BASENAME%.up.sql}.down.sql"
  if [[ ! -f "$MIG_DIR/$PAIR" ]]; then
    echo "[relay/migration-check] WARN: writing $BASENAME but $PAIR does not exist yet. Create rollback before commit." >&2
  fi
fi

exit 0
