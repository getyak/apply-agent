#!/usr/bin/env bash
# Stop the Relay app processes (agents/api/web) started by up.sh.
# By default leaves infra (docker) running — pass --all to also `make down`.
#
# Usage:
#   bash .claude/skills/relay-up/scripts/down.sh         # stop app layers only
#   bash .claude/skills/relay-up/scripts/down.sh --all   # also stop docker infra
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
[ -f .env ] && { set -a; source .env; set +a; }

API_PORT="${API_PORT:-3001}"
AGENT_PORT="${AGENT_SERVICE_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"
PID_DIR="$ROOT/.relay-stack/pids"

ALL=0
[ "${1:-}" = "--all" ] && ALL=1

ok()  { printf "\033[0;32m✓ %s\033[0m\n" "$1"; }
say() { printf "\033[1;36m▶ %s\033[0m\n" "$1"; }

# Kill by recorded PID first (clean), then sweep anything still on the port.
stop_layer() {
  # NOTE: declare one `local` per line — macOS bash 3.2 mis-parses
  # `local a="$1" b="$2"` under `set -u` and aborts with "name: unbound variable".
  local name="$1"
  local port="$2"
  local pidfile="$PID_DIR/$name.pid"
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # kill the whole process group (uv/bun/next spawn children)
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    fi
    rm -f "$pidfile"
  fi
  # backstop: free the port regardless of how it was started
  local stragglers; stragglers="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$stragglers" ] && kill $stragglers 2>/dev/null || true
  ok "$name stopped (:$port)"
}

say "stopping Relay app layers"
stop_layer web "$WEB_PORT"
stop_layer api "$API_PORT"
stop_layer agents "$AGENT_PORT"

if [ "$ALL" = "1" ]; then
  say "stopping infra (make down)"
  make down || true
  ok "infra stopped"
else
  echo "  infra (PG/Redis/MinIO) left running — use --all or 'make down' to stop it."
fi
