---
name: relay-up
version: 1.0.0
description: |
  Boot the full Relay stack in dependency order — infra (Docker PG/Redis/MinIO)
  → agents (FastAPI/LangGraph :8000) → api (Hono/Bun :3001) → web (Next.js :3000),
  each gated on a readiness probe, app processes detached with centralized logs.
  Use when asked to "start Relay", "run the full stack", "启动完整服务", "bring
  everything up", "start the app", "spin up the dev environment", or to check
  ("status") / stop ("down") the running stack.
  Proactively invoke this skill (do NOT start services ad-hoc with raw bun/uv
  commands) whenever the user wants the local Relay environment running end-to-end.
allowed-tools:
  - Bash
  - Read
  - Edit
---

# relay-up — one-command full-stack launcher

Brings up the four Relay layers **in dependency order**, each gated on a real
readiness probe. Idempotent (skips already-running layers), detached (app procs
survive the turn), observable (centralized logs + a status probe).

## Service topology (the truth this skill encodes)

| Layer | Service | Command | Port | Depends on |
|-------|---------|---------|------|-----------|
| L0 infra | PG · Redis · MinIO | `make up` | 5433 / 6380 / 9000-9001 | — |
| L1 agents | FastAPI + LangGraph | `cd agents && uv run uvicorn agents.api.server:app --port 8000` | **8000** | PG, Redis |
| L2 api | Hono + Bun | `cd api && bun run dev` | 3001 | PG, Redis, agents |
| L3 web | Next.js | `cd web && bun run dev` | 3000 | api |

> The `api` layer's `AGENT_BASE_URL` defaults to `http://localhost:8000`, so
> agents **must** be up before api. `web` reads `NEXT_PUBLIC_API_BASE=:3001`, so
> api must be up before web. Ports come from `.env`
> (`AGENT_SERVICE_PORT` / `API_PORT`); `WEB_PORT` defaults to 3000.

## When invoked

Pick the action from the user's intent:

- **"start" / "启动" / "bring up"** → run the launcher (below).
- **"status" / "what's running"** → `bash .claude/skills/relay-up/scripts/status.sh`
  and relay the table. Do nothing else.
- **"stop" / "down" / "关闭"** → `bash .claude/skills/relay-up/scripts/down.sh`
  (add `--all` only if the user also wants Docker infra stopped).
- **"restart"** → `down.sh` then the launcher.

## Launch procedure

1. **Preflight** (one Bash block, fail fast with a clear message):
   - `.env` exists at repo root. If missing → tell the user to
     `cp .env.example .env` and fill `OPENROUTER_API_KEY`; stop.
   - `docker info` succeeds (Docker daemon up). If not → ask them to start Docker.
   - `command -v uv` and `command -v bun` exist. If either is missing, name it and stop.
   - First run only: if `agents/.venv` is absent, run `cd agents && uv sync`; if
     `api/node_modules` is absent, run `cd api && bun install`; same for `web`.
     Mention you're doing first-time dependency install so the wait makes sense.

2. **Run the launcher in the background** (it is long-lived — the web/agents
   procs keep running). Use a background Bash call:

   ```bash
   bash .claude/skills/relay-up/scripts/up.sh
   ```

   Honor flags from the user: `--no-web` (backend only), `--infra` (Docker only).
   The script is idempotent — re-running it just re-probes and fills gaps.

3. **Report** by running the status probe and relaying its table verbatim, then
   give the three URLs and the log/stop hints. Do not declare success on layers
   the probe marks DOWN.

## If a layer fails to come up

The launcher prints which layer failed and the log path. Diagnose by tailing:

```bash
tail -50 .relay-stack/logs/agents.log   # or api.log / web.log
```

Common causes, in order of likelihood:

- **agents DOWN** — missing Python deps (`cd agents && uv sync`), bad
  `OPENROUTER_API_KEY`, or PG not reachable. The uvicorn traceback is in the log.
- **api DOWN** — `bun install` not run, or `DATABASE_URL`/`REDIS_URL` wrong in
  `.env` (ports must be 5433 / 6380, not the defaults).
- **web DOWN** — `bun install` not run in `web/`, or a Next build error in the log.
- **port already in use** — something else holds 3000/3001/8000. Run
  `down.sh` to free Relay's ports, or identify the owner with `lsof -i:<port>`.

Report the root cause from the log; do not silently retry.

## Notes

- Runtime artifacts live in `.relay-stack/` (gitignored): `logs/*.log`,
  `pids/*.pid`. Safe to delete when the stack is down.
- This skill drives the **application** layer; `scripts/db-health.sh` (via
  `make db-health`) is the deeper 8-point infra probe and is complementary.
- Never start services with bare `bun run` / `uvicorn` outside this skill during
  a "start the stack" request — that bypasses ordering, health gating, and logs.
