#!/usr/bin/env bash
# Purpose: After a Stop event, lint the most recent commit message if one was just made.
# Trigger: Stop · Non-blocking — informational only.

set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

LAST_COMMIT_TIME="$(git log -1 --format=%ct 2>/dev/null || echo 0)"
NOW="$(date +%s)"
DELTA=$((NOW - LAST_COMMIT_TIME))

[[ $DELTA -lt 300 ]] || exit 0

MSG="$(git log -1 --format=%s)"
PATTERN='^(feat|fix|docs|refactor|test|chore|perf|ci)(\([a-z0-9-]+\))?: .+'

if [[ ! "$MSG" =~ $PATTERN ]]; then
  cat <<EOF

[relay/commit-lint] Recent commit does not follow conventional commits:
  $MSG

Expected: <type>(scope?): <message>
Allowed types: feat fix docs refactor test chore perf ci

Amend with:  git commit --amend
EOF
fi

exit 0
