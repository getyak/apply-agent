#!/usr/bin/env bash
# Purpose: Flag changes to high-risk files so reviewer (or me-tomorrow) doesn't miss them.
# Trigger: lefthook pre-push + CI fallback.
# Usage:   scripts/check-protected-paths.sh [base-ref]
#          default base-ref = origin/main
# Exit:    always 0 (informational). Set RELAY_STRICT_PROTECTED=1 to make non-zero.

set -euo pipefail

BASE="${1:-origin/main}"
STRICT="${RELAY_STRICT_PROTECTED:-0}"

PATTERNS=(
  '^infra/postgres/migrations/'
  '^\.env\.example$'
  '^agents/harness/guards\.py$'
  '^agents/harness/permissions\.py$'
  '^agents/harness/checkpointer\.py$'
  '^agents/tools/approve\.py$'
  '^apps/extension/manifest\.json$'
  '^infra/docker-compose\.yml$'
  '^docs/architecture/'
  '^\.github/CODEOWNERS$'
  '^\.github/workflows/'
)

CHANGED=$(git diff --name-only "$BASE"...HEAD 2>/dev/null || true)
HITS=""
for p in "${PATTERNS[@]}"; do
  match=$(echo "$CHANGED" | grep -E "$p" || true)
  [[ -n "$match" ]] && HITS+="$match"$'\n'
done

if [[ -n "$HITS" ]]; then
  echo "⚠ Protected paths touched — extra review required:"
  echo "$HITS" | sed 's/^/  /'
  [[ "$STRICT" == "1" ]] && exit 2
fi

exit 0
