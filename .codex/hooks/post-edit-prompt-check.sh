#!/usr/bin/env bash
# Purpose: When a prompt file is edited, remind to run eval.
# Trigger: PostToolUse:Edit|Write|MultiEdit

set -euo pipefail

INPUT="$(cat)"
FILE="$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')"

case "$FILE" in
  */agents/prompts/*.md|*/agents/prompts/*.txt|*/agents/prompts/*.yaml)
    cat <<EOF

[relay/prompt-check] Prompt file modified: $FILE

Next steps (DO NOT skip):
  1. Run baseline eval:        bun run eval:prompt -- --file "$FILE"
  2. Check drift vs baseline:  Invoke @relay-prompt-doctor
  3. Update version header in prompt file (e.g. v: 2 -> v: 3)
  4. If eval passes: /prompt-publish

Reference: docs/architecture/cicd-aiops-harness.md (prompt CI/CD pipeline)
EOF
    ;;
esac

exit 0
