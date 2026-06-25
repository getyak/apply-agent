#!/usr/bin/env bash
# Relay stack status probe — single source of truth for "what is up".
# Covers the APPLICATION layer (agents/api/web). Infra (PG/Redis/MinIO) is
# covered by scripts/db-health.sh; this script probes containers + app ports.
# Prints one line per layer: NAME  STATE  DETAIL. Exit 0 if all up, 1 otherwise.
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
[ -f .env ] && { set -a; source .env; set +a; }

API_PORT="${API_PORT:-3001}"
AGENT_PORT="${AGENT_SERVICE_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "${GREEN}%-12s UP${NC}    %s\n" "$1" "$2"; }
bad()  { printf "${RED}%-12s DOWN${NC}  %s\n" "$1" "$2"; }
warn() { printf "${YELLOW}%-12s ??${NC}    %s\n" "$1" "$2"; }

FAIL=0

# L0 — infra containers
for c in relay-postgres relay-redis relay-minio; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    ok "$c" "running"
  else
    bad "$c" "not running — run 'make up'"; FAIL=1
  fi
done

# port-probe helpers
listening() { lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; }
http_ok()   { curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null; }

# L1 — agents (FastAPI). Try /health, fall back to root, fall back to port-listen.
if http_ok "http://localhost:${AGENT_PORT}/health" || http_ok "http://localhost:${AGENT_PORT}/"; then
  ok "agents" "http://localhost:${AGENT_PORT}"
elif listening "$AGENT_PORT"; then
  warn "agents" "port ${AGENT_PORT} listening, not answering HTTP yet (booting?)"
else
  bad "agents" "port ${AGENT_PORT} dead"; FAIL=1
fi

# L2 — api (Hono/Bun)
if http_ok "http://localhost:${API_PORT}/health" || http_ok "http://localhost:${API_PORT}/"; then
  ok "api" "http://localhost:${API_PORT}"
elif listening "$API_PORT"; then
  warn "api" "port ${API_PORT} listening, no HTTP 200 yet"
else
  bad "api" "port ${API_PORT} dead"; FAIL=1
fi

# L3 — web (Next.js)
if listening "$WEB_PORT"; then
  ok "web" "http://localhost:${WEB_PORT}"
else
  bad "web" "port ${WEB_PORT} dead"; FAIL=1
fi

exit $FAIL
