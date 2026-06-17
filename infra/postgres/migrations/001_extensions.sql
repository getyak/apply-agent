-- 001: Enable required PostgreSQL extensions
-- Executed automatically on first container start

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";       -- pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- trigram index for fuzzy text search
