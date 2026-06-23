#!/usr/bin/env bash
# Relay full-stack launcher. Brings up infra → agents → api → web in dependency
# order, each gated on a readiness probe. Idempotent: already-running layers are
# skipped. App processes run detached; logs/pids land in .relay-stack/.
#
# Usage:
#   bash .claude/skills/relay-up/scripts/up.sh            # bring everything up
#   bash .claude/skills/relay-up/scripts/up.sh --no-web   # skip the Next.js layer
#   bash .claude/skills/relay-up/scripts/up.sh --infra    # infra only (make up)
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
[ -f .env ] && { set -a; source .env; set +a; }

API_PORT="${API_PORT:-3001}"
AGENT_PORT="${AGENT_SERVICE_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"

STACK_DIR="$ROOT/.relay-stack"
LOG_DIR="$STACK_DIR/logs"
PID_DIR="$STACK_DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

WANT_WEB=1; INFRA_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-web) WANT_WEB=0 ;;
    --infra)  INFRA_ONLY=1 ;;
  esac
done

say()  { printf "\033[1;36m▶ %s\033[0m\n" "$1"; }
ok()   { printf "\033[0;32m✓ %s\033[0m\n" "$1"; }
err()  { printf "\033[0;31m✗ %s\033[0m\n" "$1" >&2; }

listening() { lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; }
http_ok()   { curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null; }

# wait_for <label> <probe-cmd> <timeout-s> — poll until probe succeeds or timeout
wait_for() {
  # one `local` per line — macOS bash 3.2 mis-parses multi-var `local` under set -u
  local label="$1"
  local probe="$2"
  local timeout="${3:-40}"
  local waited=0
  while ! eval "$probe"; do
    sleep 1; waited=$((waited+1))
    if [ "$waited" -ge "$timeout" ]; then
      err "$label not ready after ${timeout}s — check log"; return 1
    fi
  done
  ok "$label ready (${waited}s)"; return 0
}

# start_proc <name> <port> <log> <cmd...> — start detached unless already up
start_proc() {
  local name="$1"
  local port="$2"
  local log="$3"
  shift 3
  if listening "$port"; then
    ok "$name already listening on :$port — skipping"
    return 0
  fi
  say "starting $name → :$port (log: ${log#$ROOT/})"
  nohup "$@" >"$log" 2>&1 &
  echo $! > "$PID_DIR/$name.pid"
  return 0
}

# ── L0: infrastructure ──────────────────────────────────────────────────────
say "L0 infra: docker compose (PG 5433 · Redis 6380 · MinIO 9000/9001)"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx relay-postgres \
   && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx relay-redis; then
  ok "infra containers already running"
else
  make up || { err "make up failed"; exit 1; }
fi
wait_for "postgres" "docker exec relay-postgres pg_isready -U ${POSTGRES_USER:-relay} -d ${POSTGRES_DB:-relay} >/dev/null 2>&1" 30 || exit 1

if [ "$INFRA_ONLY" = "1" ]; then
  ok "infra-only requested — done"; exit 0
fi

# ── L1: agents (FastAPI + LangGraph) ────────────────────────────────────────
start_proc agents "$AGENT_PORT" "$LOG_DIR/agents.log" \
  bash -c "cd '$ROOT/agents' && uv run uvicorn agents.api.server:app --host 0.0.0.0 --port $AGENT_PORT"
wait_for "agents :$AGENT_PORT" \
  "http_ok http://localhost:$AGENT_PORT/health || http_ok http://localhost:$AGENT_PORT/ || listening $AGENT_PORT" 60 \
  || { err "agents failed — tail .relay-stack/logs/agents.log"; }

# ── L2: api (Hono + Bun) ────────────────────────────────────────────────────
start_proc api "$API_PORT" "$LOG_DIR/api.log" \
  bash -c "cd '$ROOT/api' && bun run dev"
wait_for "api :$API_PORT" \
  "http_ok http://localhost:$API_PORT/health || http_ok http://localhost:$API_PORT/ || listening $API_PORT" 40 \
  || { err "api failed — tail .relay-stack/logs/api.log"; }

# ── L3: web (Next.js) ───────────────────────────────────────────────────────
if [ "$WANT_WEB" = "1" ]; then
  start_proc web "$WEB_PORT" "$LOG_DIR/web.log" \
    bash -c "cd '$ROOT/web' && bun run dev"
  wait_for "web :$WEB_PORT" "listening $WEB_PORT" 60 \
    || { err "web failed — tail .relay-stack/logs/web.log"; }
fi

echo
say "stack status:"
bash "$ROOT/.claude/skills/relay-up/scripts/status.sh" || true
echo
ok "Relay is up.  Web → http://localhost:$WEB_PORT   API → http://localhost:$API_PORT   Agents → http://localhost:$AGENT_PORT"
echo "  logs:  tail -f .relay-stack/logs/{agents,api,web}.log"
echo "  stop:  bash .claude/skills/relay-up/scripts/down.sh"
