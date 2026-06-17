#!/usr/bin/env bash
# Purpose: Block Bash commands that modify protected paths.
# Trigger: PreToolUse:Bash
# Input:   JSON on stdin with .tool_input.command
# Output:  exit 0 (allow) or exit 2 (block with stderr message)

set -euo pipefail

INPUT="$(cat)"
CMD="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"

PROTECTED_PATTERNS=(
  "infra/postgres/migrations/"
  "agents/harness/guards.py"
  "extension/manifest.json"
  "\.env($|[^.])"
  "docs/architecture/"
)

WRITE_VERBS='(rm|mv|>|>>|tee|sed -i|truncate|cp .* )'

for pat in "${PROTECTED_PATTERNS[@]}"; do
  if echo "$CMD" | grep -E "$WRITE_VERBS" 2>/dev/null | grep -E "$pat" >/dev/null 2>&1; then
    cat >&2 <<EOF
[relay/protected-paths] BLOCKED: command tries to modify a protected path matching '$pat'.
Command: $CMD

Protected paths require manual edit + review:
  - infra/postgres/migrations/   (use /migration-new instead)
  - agents/harness/guards.py     (loop guards — security critical)
  - extension/manifest.json      (MV3 permissions — review with relay-extension-auditor)
  - .env, .env.*                 (secrets)
  - docs/architecture/           (architectural decisions)

If intentional: edit via Edit/Write tool with explicit user confirmation, or remove this guard temporarily.
EOF
    exit 2
  fi
done

exit 0
