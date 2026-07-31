---
name: apply-agent
description: Develop, test, review, or debug the Relay apply-agent repository. Use for code changes spanning the Bun/Hono API, Python FastAPI/LangGraph agents, Next.js web app, PostgreSQL migrations, browser delivery, or project CI and local infrastructure.
---

# Relay repository workflow

Read the nearest `AGENTS.md` before editing. Treat the repository as a hybrid
system:

- Keep the Bun/Hono API and web code in TypeScript.
- Keep the FastAPI/LangGraph agent layer in Python.
- Connect the layers only through HTTP, Redis, and shared PostgreSQL.
- Use OpenRouter through the existing model router; do not introduce a direct
  OpenAI/Codex API dependency into Relay's agent runtime.
- Keep job submission in the user's browser.
- Never store job-platform passwords, bypass CAPTCHA, or fabricate résumé facts.
- Require HITL approval for submission, email, and destructive actions.

Inspect existing implementations and tests before changing behavior. Use the
smallest relevant verification set first, then run the package-level checks
affected by the change.

Common commands:

```bash
make up
make db-health

cd agents
uv run pytest <target>
uv run ruff check <target>
uv run mypy <target>

cd ../api
bun test

cd ../web
bun test
```

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`) when the user asks for a commit.
