#!/usr/bin/env bash
# Purpose: Warn before delegating to subagents if daily budget exceeded.
# Trigger: PreToolUse:Task (subagent delegation)
# Note:    Best-effort tracking via local file; replace with Langfuse later.

set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

LEDGER=".claude/cache/cost-ledger-$(date +%Y-%m-%d).txt"
mkdir -p .claude/cache

CURRENT="$(cat "$LEDGER" 2>/dev/null || echo "0")"
BUDGET="${RELAY_DAILY_COST_BUDGET_USD:-5.00}"

EXCEEDED="$(awk -v c="$CURRENT" -v b="$BUDGET" 'BEGIN { print (c+0 > b+0) ? "yes" : "no" }')"

if [[ "$EXCEEDED" == "yes" ]]; then
  cat >&2 <<EOF
[relay/cost-warn] Daily LLM budget exceeded: \$$CURRENT / \$$BUDGET (limit: RELAY_DAILY_COST_BUDGET_USD)

This is a soft warning — the subagent call will still proceed.
To raise budget: set RELAY_DAILY_COST_BUDGET_USD in .claude/settings.local.json
To reset:        rm $LEDGER
EOF
fi

exit 0
