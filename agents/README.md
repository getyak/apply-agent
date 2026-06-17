# `agents/` — Relay LangGraph agent layer

5 domain agents + Coordinator, all wrapped by an in-house harness that adds
cost / token / error guards, HITL permissions, PostgresSaver checkpoints,
context compaction, and audit logging to `agent_tasks` (PG `010`).

## Layout

```
agents/
  pyproject.toml        # uv-managed Python 3.11+ deps
  harness/              # cross-cutting infra — shared by every node
    llm.py              # ChatOpenRouter, 3-tier model picker, cost calc
    state.py            # CoordinatorState, MockState, BuildResumeState
    guards.py           # BudgetExhausted + pre/post hooks (protected path)
    permissions.py      # @requires_approval → LangGraph interrupt()
    checkpointer.py     # PostgresSaver factory (deterministic thread_id)
    context.py          # 60k → summarise old turns (compaction)
    audit.py            # async insert into agent_tasks
  tools/                # 4-tier permission model (AUTO / NOTIFY / APPROVE / BLOCK)
    auto.py             # fetch_url, redis get/setex, pg_query (read-only)
    notify.py           # write_user_memory, save_resume_version
    approve.py          # submit_application, send_email, delete_resume
  nodes/                # the 5 domain agents
    resume_agent.py     # parse / customize / analyze / build_from_scratch
                        #   + fabrication_guard (vision.md red line)
    interview_agent.py  # 4 tools (intel × pressure × feedback × loop)
                        #   + build_mock_graph(mode)
    # jobmatch_agent.py / appprep_agent.py / trend_agent.py — Phase 1
  coordinator/          # Ask Vantage routing
    router.py           # Layer 1 regex + Layer 2 V4 Flash intent classifier
    workflows.py        # build_from_scratch fixed workflow
  events/               # cross-graph async fan-out
    bus.py              # Redis Streams publish / subscribe
  prompts/              # versioned prompt files (single source = git)
    coordinator/intent_classifier.v1.md
    interview/{ask_question,translate_feedback,fetch_intel_jd}.v1.md
    resume/{parse,customize,build_from_scratch_draft}.v1.md
  api/                  # FastAPI entry — Bun gateway proxies HTTP here
    server.py           # /ask/stream, /mock/start, /mock/resume, /resume/*
    deps.py             # current_user (X-User-Id; LOCAL_DEV fallback)
  tests/                # pytest (markers: integration, smoke)
```

## Running locally

Prereqs: PG 5433 + Redis 6380 up (`make up` at repo root). Then:

```bash
cd agents
uv sync                     # one-time
uv run uvicorn agents.api.server:app --reload --port 8001
```

Env vars:
- `OPENROUTER_API_KEY` — required
- `OPENROUTER_BASE_URL` — defaults to https://openrouter.ai/api/v1
- `RELAY_PG_DSN` — postgresql://relay:relay@localhost:5433/relay
- `RELAY_REDIS_URL` — redis://localhost:6380/0
- `LOCAL_DEV=1` — accept the demo user when X-User-Id is missing
- `RELAY_LLM_KILLSWITCH=1` — emergency stop (skip all LLM calls)
- `RELAY_MOCK_MAX_QUESTIONS=10` — cap per Mock session

## Smoke-test (first-week priority)

OpenRouter + DeepSeek / GLM tool-calling compatibility is the biggest unknown
(cicd-aiops-harness.md § 6 pitfall #3). Add a `tests/test_smoke_openrouter.py`
that loops the 3 model tiers and asserts `tool_calls` appears on each result.
Marked `@pytest.mark.smoke` (costs real $).

## Design references

- `docs/architecture/vantage-ui-mapping.md` — Vantage UI ↔ agent layer mapping
- `docs/architecture/agent-architecture.md` — 5-agent rationale (chat2 § 深度分析)
- `docs/architecture/agent-harness.md` — runtime guards, HITL, checkpoints
- `docs/architecture/cicd-aiops-harness.md` — CI / cost / drift / eval
- `docs/vision.md` — "rephrase, never fabricate" red line
