# CLAUDE.md

Relay — AI job-search copilot. Status: infra ready, no app code yet.

## Gotchas (read every time)

- **Hybrid backend**: API layer is TypeScript (Hono/Bun), Agent layer is Python (FastAPI + LangGraph). Never mix — they communicate only via HTTP + Redis + shared PG.
- **LLM via OpenRouter**: NOT Claude API. Uses `OPENROUTER_BASE_URL` + `ChatOpenAI` with `base_url` override. Models: DeepSeek V4 Pro (heavy) / GLM-4.7 (general) / DeepSeek V4 Flash (fast).
- **Agent framework**: LangGraph `create_react_agent`, NOT legacy LangChain `AgentExecutor`. HITL uses `interrupt()` + `Command(resume=...)`.
- **Client-side execution**: Job submissions happen in user's browser extension, NEVER server-side. This is the core design constraint.
- **Non-standard ports**: PG on `5433`, Redis on `6380` (local machine has default ports occupied).
- **No credential storage**: Never store user passwords for job platforms. No CAPTCHA bypass.
- **No resume fabrication**: AI may rephrase, never invent experience.
- **HITL required**: `submit_form`, `send_email`, `delete_*` always need user approval via LangGraph `interrupt()`.

## Quick Commands

```bash
make up / make down    # Docker infra (PG + Redis + MinIO)
make db-shell          # psql into relay
make db-health         # 8-point health check
```

## Conventions

- Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- TypeScript for API/frontend, Python for agents
- New DB migrations: `infra/postgres/migrations/011_xxx.sql` then `make db-reset && make up`

## References

@docs/architecture/system-overview.md
@docs/architecture/agent-architecture.md
@docs/architecture/agent-harness.md
@docs/architecture/cicd-aiops-harness.md
@docs/architecture/client-side-delivery.md
@docs/architecture/vantage-ui-mapping.md
@docs/data-model.md
@docs/product-spec.md
@docs/vision.md
@infra/CLAUDE.md
