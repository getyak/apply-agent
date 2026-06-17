#!/usr/bin/env bash
set -uo pipefail

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $name"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} $name"
    ((FAIL++))
  fi
}

echo ""
echo "=== Relay Infrastructure Health Check ==="
echo ""

echo "PostgreSQL:"
check "Container running" "docker inspect -f '{{.State.Running}}' relay-postgres 2>/dev/null | grep true"
check "Accepting connections" "docker exec relay-postgres pg_isready -U ${POSTGRES_USER:-relay} -d ${POSTGRES_DB:-relay}"
check "pgvector extension" "docker exec relay-postgres psql -U ${POSTGRES_USER:-relay} -d ${POSTGRES_DB:-relay} -tAc \"SELECT 1 FROM pg_extension WHERE extname='vector'\" | grep 1"
check "Tables created" "docker exec relay-postgres psql -U ${POSTGRES_USER:-relay} -d ${POSTGRES_DB:-relay} -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'\" | grep -E '^[1-9][0-9]*$'"

TABLE_COUNT=$(docker exec relay-postgres psql -U "${POSTGRES_USER:-relay}" -d "${POSTGRES_DB:-relay}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null || echo "0")
echo -e "  ${YELLOW}  → ${TABLE_COUNT} tables found${NC}"

echo ""
echo "Redis:"
check "Container running" "docker inspect -f '{{.State.Running}}' relay-redis 2>/dev/null | grep true"
check "Accepting connections" "docker exec relay-redis redis-cli -a ${REDIS_PASSWORD:-relay_redis_dev_2026} ping 2>/dev/null | grep PONG"

echo ""
echo "MinIO (S3):"
check "Container running" "docker inspect -f '{{.State.Running}}' relay-minio 2>/dev/null | grep true"
check "API reachable" "docker exec relay-minio curl -sf http://localhost:9000/minio/health/live"

echo ""
echo "---"
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Some checks failed. Run 'make logs' to investigate.${NC}"
  exit 1
fi
