# Relay - Development Commands

.PHONY: up down restart logs ps db-shell redis-shell db-health db-reset minio-console

# Start all infrastructure services
up:
	docker compose -f infra/docker-compose.yml --env-file .env up -d
	@echo "Waiting for services to be healthy..."
	@sleep 3
	@$(MAKE) db-health

# Stop all services
down:
	docker compose -f infra/docker-compose.yml --env-file .env down

# Restart all services
restart: down up

# View logs (follow mode)
logs:
	docker compose -f infra/docker-compose.yml --env-file .env logs -f

# Show service status
ps:
	docker compose -f infra/docker-compose.yml --env-file .env ps

# PostgreSQL shell
db-shell:
	docker exec -it relay-postgres psql -U $${POSTGRES_USER:-relay} -d $${POSTGRES_DB:-relay}

# Redis CLI
redis-shell:
	docker exec -it relay-redis redis-cli -a $${REDIS_PASSWORD:-relay_redis_dev_2026}

# Health check
db-health:
	@bash scripts/db-health.sh

# Full reset: destroy volumes and re-init
db-reset:
	docker compose -f infra/docker-compose.yml --env-file .env down -v
	@echo "Volumes destroyed. Run 'make up' to re-initialize."

# Open MinIO console in browser
minio-console:
	@echo "MinIO Console: http://localhost:9001"
	@echo "Login: $${S3_ACCESS_KEY:-relay_minio_access} / (see .env for password)"
	@open http://localhost:9001 2>/dev/null || xdg-open http://localhost:9001 2>/dev/null || true
