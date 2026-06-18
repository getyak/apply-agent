#!/bin/bash
# Postgres first-start initializer.
#
# Mounted at /docker-entrypoint-initdb.d/ and run once when the data directory
# is empty. Applies migrations in lexical order but SKIPS any `*.down.sql` file
# (those exist only for rollback validation in CI). Legacy single-file
# migrations (NNN_name.sql) and paired forward migrations (NNN_name.up.sql)
# are both applied.
set -euo pipefail

MIGRATIONS_DIR="/migrations"

echo "[init-db] applying migrations from ${MIGRATIONS_DIR}"
for f in "${MIGRATIONS_DIR}"/*.sql; do
  case "$f" in
    *.down.sql)
      echo "[init-db] skip (rollback): $(basename "$f")"
      ;;
    *)
      echo "[init-db] apply: $(basename "$f")"
      psql -v ON_ERROR_STOP=1 \
        --username "${POSTGRES_USER}" \
        --dbname "${POSTGRES_DB}" \
        -f "$f"
      ;;
  esac
done
echo "[init-db] migrations complete"
