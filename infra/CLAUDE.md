# Infrastructure

## Services

| Service | Image | Container | Host Port | Internal Port |
|---------|-------|-----------|-----------|---------------|
| PostgreSQL 16 + pgvector | pgvector/pgvector:pg16 | relay-postgres | 5433 | 5432 |
| Redis 7 | redis:7-alpine | relay-redis | 6380 | 6379 |
| MinIO (S3) | minio/minio:latest | relay-minio | 9000 (API) / 9001 (console) | same |

Secrets in `.env` (root, git-ignored). Template: `.env.example`.

## Database

PostgreSQL with extensions: `pgvector`, `pgcrypto`, `pg_trgm`, `uuid-ossp`.

16 tables across 10 migrations (`postgres/migrations/001–010`), auto-executed on first container start:

| Migration | Domain | Tables |
|-----------|--------|--------|
| 001 | Extensions | — |
| 002 | Users | `users`, `user_devices` |
| 003 | Files | `user_files`, `user_file_versions` |
| 004 | Resumes | `resumes` (JSON Resume JSONB + vector) |
| 005 | Jobs | `jobs` (parsed JD + vector) |
| 006 | Applications | `application_drafts` |
| 007 | Conversations | `conversation_sessions`, `conversation_messages` |
| 008 | Memory | `user_memories`, `memory_relations` (vector) |
| 009 | Interviews | `interview_sessions`, `interview_questions`, `interview_question_pool` (vector) |
| 010 | Agents | `agent_configs`, `agent_tasks` |

Key patterns:
- pgvector (1536-dim, ivfflat) on resumes / jobs / memories / question pool for semantic search
- Optimistic locking on resumes via `version` field
- Soft-delete on `user_files` (GDPR)
- HITL fields on `agent_tasks` (action, payload, decision, decided_at)
- Auto `updated_at` trigger on users / jobs / applications / memories

## File Storage

User files: metadata in `user_files` table, binary blobs in MinIO bucket `relay-user-files`.

```
{user_id}/resumes/originals/     # uploaded PDF/DOCX
{user_id}/resumes/tailored/      # AI-customized versions
{user_id}/cover-letters/
{user_id}/interviews/recordings/
{user_id}/exports/               # GDPR data export
```

## Redis Usage

- Cache: resume tailoring results (7d TTL), JD parsing, match scores
- Event bus: Redis Streams for inter-agent events
- HITL queue: pending user approvals (5min TTL)
- Rate limiting: per-user LLM call counters
