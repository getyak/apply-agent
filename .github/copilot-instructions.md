<!--
Purpose: prime GitHub Copilot Chat / Copilot Workspace with project rules.
When to edit: when CLAUDE.md gotchas change. Keep this in sync with CLAUDE.md.
-->

# Copilot instructions for Relay

Relay is an AI job-search copilot. Read these before suggesting code.

## Hard constraints

1. **Hybrid backend**: API layer is **TypeScript (Hono on Bun)**; agent layer is **Python (FastAPI + LangGraph)**. They communicate only via HTTP + Redis + shared PostgreSQL. **Never** put agent/LLM logic in `api/`. **Never** put HTTP routing or auth in `agents/`.

2. **LLM provider is OpenRouter, not Anthropic direct.** Use `langchain_openai.ChatOpenAI` with `base_url=os.environ["OPENROUTER_BASE_URL"]`. Models: `deepseek/deepseek-v4-pro` (heavy), `z-ai/glm-4.7` (general), `deepseek/deepseek-v4-flash` (fast).

3. **Agent framework is LangGraph `create_react_agent`.** Do **not** suggest legacy `langchain.agents.AgentExecutor`. HITL must use `langgraph.types.interrupt()` + `Command(resume=...)`, not `interrupt_before`.

4. **Client-side submission only.** Job applications are submitted from the user's browser via the MV3 extension. Do **not** suggest server-side form submission, headless browser submission against logged-in user accounts, or any credential storage.

5. **HITL is mandatory** for `submit_form`, `send_email`, `delete_*`, `enter_credentials`, and any tool with cost > threshold. Apply `@requires_approval`.

6. **Never fabricate resume content.** Prompts must say "rephrase, never invent." If you generate a prompt, include this rule.

7. **No credential storage** for job platforms. No CAPTCHA bypass code.

## Conventions

- TypeScript: strict mode, no `any`, prefer `unknown` + narrowing.
- Python: type hints required, `ruff` + `mypy` clean.
- Immutability: never mutate; create new objects/arrays.
- File size: target 200–400 lines, hard cap 800.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.
- Non-standard ports locally: PostgreSQL `5433`, Redis `6380`.

## Do-not-touch files

Do **not** auto-suggest sweeping edits in:

- `infra/postgres/migrations/**` — append new files, never edit existing.
- `agents/harness/guards.py` — budget/loop guard logic. Hand-review only.
- `agents/harness/permissions.py` — HITL decorator logic.
- `apps/extension/manifest.json` — permission changes affect Web Store review.
- `docs/architecture/**` — these are contracts; update only with explicit intent.

## Preferred patterns

- New tool: register with `AUTO` / `NOTIFY` / `APPROVE` level; if APPROVE, wrap with `@requires_approval`.
- New LLM call: pick the cheapest tier that meets quality; add cache key `{namespace}:{user}:{hash(input)}`; set TTL.
- New DB query: parameterized; if filtering by user, the predicate is mandatory and explicit.
- New migration: `NNN_descriptive.sql` plus matching `down.sql`.

## When unsure

Suggest opening a discussion or filing a `prompt-issue` / `feat` template rather than guessing on agent behavior or eval-impacting changes.
