#!/usr/bin/env bash
# Purpose: On session start, surface uncommitted high-risk changes.
# Trigger: SessionStart

set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

CHANGES="$(git status --porcelain 2>/dev/null || true)"

[[ -z "$CHANGES" ]] && exit 0

echo "$CHANGES" | grep -E '(infra/postgres/migrations/|agents/prompts/|extension/manifest\.json|agents/harness/guards\.py)' > /tmp/relay-risky.txt 2>/dev/null || true

if [[ -s /tmp/relay-risky.txt ]]; then
  cat <<EOF

[relay/session-start] WARNING: uncommitted changes in high-impact paths:

$(cat /tmp/relay-risky.txt)

Recommended actions before continuing:
  - Migrations:    review with @relay-migration-guardian
  - Prompts:       run /prompt-publish or @relay-prompt-doctor
  - manifest.json: review with @relay-extension-auditor
  - guards.py:     this is loop-guard infra — extra caution

Current project phase: infra ready, no app code yet (see CLAUDE.md).
EOF
fi

rm -f /tmp/relay-risky.txt
exit 0
