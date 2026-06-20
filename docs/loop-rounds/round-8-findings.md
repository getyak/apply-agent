# Round 8 — Findings & Plan

**Trigger:** `/loop 30min` agent teams eighth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-7-baseline's "not yet covered" areas — coordinator workflows saga replay & idempotency / harness/llm.py provider routing + retry budget / .github/workflows CI gates & branch protection / HITL Command(resume) payload validation. Rounds 1-7 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`) verified untouched (21/21 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (reliability + IDOR + injection)

- **WF1. `prepare_application` saga has no checkpointer** — `agents/coordinator/workflows.py:388`. A retry from the API layer re-executes from step 0; the saga is not replay-safe.
- **WF2. `_create_application_draft` lacks ON CONFLICT** — `agents/coordinator/workflows.py:471-475`. Each retry creates a fresh draft row with a fresh UUID; the previous one orphans.
- **WF3. Failed-step replay = "skip forward", not "retry"** — `agents/coordinator/workflows.py:355-360`. No automatic retry of a failed step, no chance to pick a fallback model.
- **WF4. PostgresSaver has no GC** — `agents/harness/checkpointer.py:33-34`. Incomplete workflows pile up in `checkpoint_writes`/`checkpoint_blobs`; long-term table bloat.
- **WF5. No user-id namespace isolation in checkpointer keys** — `agents/api/server.py:583`. Theoretical UUID collision / test fixture reuse can leak state between users.
- **LLM1. `pick_model` returns `ChatOpenAI(max_retries=0)`** — `agents/harness/llm.py:45-54`. A single 429 / 5xx / network blip propagates as a hard failure into the saga; DEGRADE_PATH is never reached for transient errors.
- **LLM3. Provider routing only sets `allow_fallbacks=True`; no `:nitro` / explicit pin** — `agents/harness/llm.py:51-53`. OpenRouter is free to silently swap backends, with documented `tool_call` JSON-format risk on DeepSeek/GLM.
- **LLM4. Model cost table is hard-coded** — `agents/harness/llm.py:29-34`. When OpenRouter changes pricing, CostGuard's 50¢ session ceiling silently mis-budgets.
- **CI1. Branch protection only requires `ci-success`** — `.github/workflows/ci.yml:399-408`. AI review, Guard, secrets-scan are advisory; protected paths can be merged with warnings.
- **CI2. Linter / formatter divergence** — `lefthook.yml:11-13` runs Biome on `*.tsx`, `api/package.json:8` only runs `tsc --noEmit`, `web/package.json:10` runs `eslint`. Three different gates, none cross-verified.
- **HITL_R1. `Command(resume).value: Any` accepts arbitrary JSON, no validation** — `agents/api/server.py:603-605`. Unrestricted prompt-injection vector into downstream LLM.
- **HITL_R3. No payload size cap on `MockResumePayload.answer` / `BuildResumeResumePayload.value`** — `agents/api/server.py:572-575, 603-605`. 10 MB nested JSON → `RecursionError` in `json.dumps`.
- **HITL_R4. `/mock/resume` + `/build_resume/resume` don't verify thread ownership** — `agents/api/server.py:577-595, 608-619`. Knowing a victim's `thread_id` is enough to act on their session (IDOR).
- **HITL_R5. Zero E2E coverage of HITL validation paths** — `agents/tests/`. Injection / oversized / cross-user submissions are untested.

### High

- **LLM2. Network-failure retry budget is 0 across all call sites** — `agents/nodes/resume_agent.py:94-112` + router/timeouts. Business-layer retries only for hallucination.
- **LLM5. OpenRouter integration tests run nightly only, not on PR** — `.github/workflows/eval.yml`. Daily PR CI has zero LLM coverage.
- **CI3. `eval.yml` promptfoo silently skips without OPENROUTER_API_KEY** — `.github/workflows/eval.yml:24-40`. Forks / PRs without the secret never know the prompt eval was skipped.
- **CI5. Python deps not under Dependabot** — `.github/dependabot.yml:6-7` (dormant). LangGraph / FastAPI / Pydantic security patches are manual.
- **CI6. No CodeQL, no container scan** — entire repo. Code-level vulnerability detection is missing.

### Medium

- **CI4. migration-check pgTAP assertions are hard-coded** — `.github/workflows/migration-check.yml:72-81`. New migrations that touch unlisted tables silently pass.
- **HITL_R2. `Command.resume({value: 99999999999})` — no numeric range guard** — same `BuildResumeResumePayload`. Overflow / massive ints reach DB inserts.

### Low

- **WF6. Mock thread_id = `mock:{session_id}` (no user prefix)** — `agents/harness/checkpointer.py:50-52`. Tolerable today (UUID4 collision negligible) but documented as a future risk.

---

## Round-8 implementation plan

**Pick: HITL_R4 (thread ownership check) + LLM1 (max_retries + request_timeout on every ChatOpenAI) + HITL_R3 (Mock/Build payload schemas tightened).**

Why these three:
- **HITL_R4** is a *real* IDOR; the round-8 audit gives a step-by-step attack and the fix is < 20 lines.
- **LLM1** is a one-key change on a single constructor; closes the round-8 LLM3+LLM4 *exposure* (transient OpenRouter errors no longer become saga failures) without taking on the bigger DEGRADE_PATH redesign.
- **HITL_R3** rides the same file as HITL_R4 (server.py payload classes) and tightens the size / type contract; live smoke confirmed 4 attack vectors now reject (long thread_id, 60 KB answer, dict-typed value, 20 KB string value).

**Out of scope this round (will surface in future findings):**
- WF1 / WF2 / WF3 / WF4 / WF5: need a UNIQUE index migration + idempotency-key plumbing through the saga; can't ship in 30 min.
- LLM2 / LLM3 / LLM4 / LLM5: each needs a design — backoff strategy, provider pinning policy, externalised price table, CI integration cost decision.
- CI1 / CI2 / CI3 / CI4 / CI5 / CI6: each is its own workflow PR.
- HITL_R1 / HITL_R2: partly covered by HITL_R3 today (range check is the remaining gap); HITL_R5 (test coverage) is a separate test PR.

---

## Shipped this round

- **HITL_R4** — `agents/api/server.py` (`mock_resume` + `build_resume_resume`). `/mock/resume` now loads the snapshot then rejects (403) when `snapshot["channel_values"]["user_id"] != auth user_id`; `/build_resume/resume` parses the `build_resume:{user_id}:{session_id}` structure and rejects (403) when the embedded user_id doesn't match. The string-shape check is also a defensive guard against future thread_id format changes silently bypassing ownership.
- **LLM1** — `agents/harness/llm.py` (`pick_model`). `ChatOpenAI` now ships with `max_retries=3` (enables langchain_openai's tenacity-backed exponential backoff for 429 / 5xx / connection wobbles) and `request_timeout=30` (mirrors the router's `asyncio.wait_for(...)` deadline so a hung provider can't outlive the enclosing timeout). Smoke-verified that `ChatOpenAI.model_fields` accepts both.
- **HITL_R3** — `agents/api/server.py` (`MockResumePayload` + `BuildResumeResumePayload`). Pydantic `Field(min_length=, max_length=)` caps on every string field (thread_id ≤ 128, mock answer ≤ 50 000, build_resume str ≤ 10 000), plus a `@field_validator` on `BuildResumeResumePayload.value` that rejects dicts and `Any` payloads (only `str | list[str]` allowed, list capped at 50 items × 2 000 chars each). Live smoke confirms 4 attack vectors reject cleanly.

Build / test: `ruff check agents/api/server.py agents/harness/llm.py` clean. 27 agents pytest cases pass (4 application_submitted + 3 extension_map_fields + 15 jobmatch_parse_jd + 5 prepare_application). web `bun run typecheck` + `bun run lint` exit 0. api `bun run typecheck` clean; `bun test` shows 183 passes / 0 fails / 382 expect() calls.

---

## Next-round baseline

Round 9 should:
- Diff against this file's "Out of scope" list — top candidates: WF2 (the dedup actually needs a migration; or a caller idempotency-key plumbing), CI2 (settle on one linter; pick biome or eslint and align the others), LLM2 (router-level retry around `ainvoke` with explicit DEGRADE_PATH fallback).
- Verify rounds 1-8 fixes hold (24 markers across 16 files).
- Re-audit areas still un-covered: `agents/events/bus.py` Redis lifecycle + retry semantics; `agents/tools/` allowlist/permission boundary; `web/src/lib/ask-stream.ts` SSE retry strategy; the `api/src/middleware/idempotency.ts` flow + key collision; chrome-extension popup CSP + permission UX (round-3 round 7 carry-overs).
- Stretch: open up `e2e/` directory and scaffold the auth → onboarding → mock setup spec so round-9 onward have a regression artifact.
