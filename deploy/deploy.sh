#!/usr/bin/env bash
set -euo pipefail
docker compose --env-file .env -f deploy/compose.prod.yml --project-name apply-agent up -d --build --remove-orphans
docker image prune -f
