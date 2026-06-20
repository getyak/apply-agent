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
  "agents/harness/guards\.py"
  "extension/manifest\.json"
  # ".env" intentionally NOT protected — user requested read/write access.
  # See .claude/settings.json _user_override_note for full reversal recipe.
  "docs/architecture/"
)

# Match ONLY real write semantics. Per-token:
#   \brm  \bmv  \btee  \btruncate     —— word-boundary commands
#   \bsed -i                          —— in-place sed
#   \bcp [^ ]+ [^ ]+                  —— cp src dst (2 args)
#   > [^&]                            —— stdout redirect (NOT 2>&1, NOT 2>/dev/null)
#   >> [^&]                           —— append redirect
#   \brsync                           —— rsync writes too
# What we DON'T match (intentional):
#   bare `|`  — that's a pipe, not a write
#   `2>&1` `2>/dev/null` — stderr redirect not a write to user path
#   `<`     — read redirect
WRITE_VERBS='(\brm\b|\bmv\b|\btee\b|\btruncate\b|\bsed -i\b|\bcp +[^ ]+ +[^ ]+|\brsync\b|[^&0-9]> +[^&]|>> +[^&])'

for pat in "${PROTECTED_PATTERNS[@]}"; do
  if echo "$CMD" | grep -E "$WRITE_VERBS" 2>/dev/null | grep -E "$pat" >/dev/null 2>&1; then
    cat >&2 <<EOF
[relay/protected-paths] BLOCKED: command tries to modify a protected path matching '$pat'.
Command: $CMD

Protected paths require manual edit + review:
  - infra/postgres/migrations/   (use /migration-new instead)
  - agents/harness/guards.py     (loop guards — security critical)
  - extension/manifest.json      (MV3 permissions — review with relay-extension-auditor)
  - docs/architecture/           (architectural decisions)

If intentional: edit via Edit/Write tool with explicit user confirmation, or remove this guard temporarily.

Note: this hook only blocks WRITE commands on the paths above.
.env / .env.* are NOT protected — user explicitly opted out. See .claude/settings.json.
EOF
    exit 2
  fi
done

exit 0
