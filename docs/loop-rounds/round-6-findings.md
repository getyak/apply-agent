# Round 6 — Findings & Plan

**Trigger:** `/loop 30min` agent teams sixth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-5-baseline's "not yet covered" areas — Redis Streams consumer error semantics / coordinator router dispatch error paths / harness audit.py + PG advisory lock robustness / HITL interrupt-resume flakiness. Rounds 1-5 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`) verified untouched (15/15 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (reliability + cost)

- **CONS1. Consumer task crash has no auto-restart** — `agents/events/consumers.py:76-88` + `agents/api/server.py:52-63`. If a consumer task dies (structlog config error, transient Redis blip), the FastAPI lifespan never notices; downstream events accumulate or are dropped.
- **CONS2. Redis Streams `maxlen=10_000, approximate=True` silently drops messages** — `agents/events/bus.py:36`. No dead-letter, no lag metric, no alerting.
- **CONS3. No idempotency key — at-least-once delivery causes double-write into TrendAgent signals** — `agents/events/consumers.py:37-59` reads but never dedupes.
- **DISP1. dispatch agent branches have no try-catch** — `agents/coordinator/router.py:268-299`. A single agent throwing (mock load_mode failure, build_from_scratch crash) aborts the entire conversation.
- **DISP5. LLM `ainvoke` calls in router are unguarded by timeout** — `agents/coordinator/router.py:190, 422`. A hung upstream stalls SSE indefinitely.
- **AUDIT1. `audit_log` insert failures are silently absorbed** — `agents/harness/audit.py:44-87`. PG outage → audit trail lost with only a log line; no metric, no fallback.
- **AUDIT5. `agent_tasks` has no retention / partitioning** — `infra/postgres/migrations/010_agents.sql:24-58`. Unbounded growth at 5-10 rows/user/day; bloat eventually degrades all queries.
- **HITL2. Concurrent `/mock/resume` to same thread_id has no idempotency / no lock** — `agents/api/server.py:580-588`. Double-tab approve = two divergent state branches.
- **HITL4. `Command(resume=...).value: Any` has no validation** — `agents/api/server.py:605`. Malformed nested JSON / circular references can reach workflow nodes.

### High (UX + a11y + Settings)

- **A11Y1. Version timeline rail buttons lack `aria-current="true"` for the active row** — `web/src/components/screens/resume-view.tsx:690, 785`. Sighted users see the highlight; SR users get nothing semantic.
- **A11Y3 (carry-over from round 5)**. Change-log list still lacks structured SR labels.
- **S1. Salary client cap missing — server rejects >10M, client only blocks negative** — `web/src/components/views/settings-view.tsx:170` vs `api/src/schemas.ts:132`.
- **DISP2. Layer-2 classifier failures default opaquely to `other`** — `agents/coordinator/router.py:203-205`. No way to distinguish "off-topic input" from "LLM crashed."
- **DISP3. Saga has no reverse rollback — only forward skip** — `agents/coordinator/workflows.py:362-390`. Partial failures leave dangling DB references.
- **DISP4. `needs_clarification` signal exists but is not tied to UI re-prompt loop** — `agents/coordinator/router.py:330,340` + `agents/api/server.py:230`.
- **HITL1. PG checkpointer 404 vs transient error not distinguished** — `agents/api/server.py:583`.
- **HITL3. Expired (7-day-old) checkpoints resume with stale LLM context, no age validation** — `agents/api/server.py:583-586`.

### Medium

- **CONS4. No consumer lag / fail metric, no observability** — `agents/events/consumers.py`. Ops has nothing but log greps.
- **CONS5. Event payloads have no schema_version field** — `agents/events/bus.py:32-35`. Phase 2 field additions break Phase 1 consumers silently.
- **AUDIT4. Exception-path lock release untested under network failure** — `agents/tools/notify.py:66-81`.
- **HITL5. No e2e test for the interrupt→resume loop on flaky checkpointer** — gap in `agents/tests/`.

### Low

- **AUDIT2. customize advisory lock held during LLM call only briefly (trigger BEFORE INSERT)** — `infra/postgres/migrations/016_resumes_atomic_version.up.sql:31`. Actually fine; documenting as confirmed-safe.
- **AUDIT3. Per-user lock prevents cross-user blocking** — `agents/tests/test_resume_version_concurrency.py:101-133`. Already covered by tests; no risk.

---

## Round-6 implementation plan

**Pick: DISP5 (router LLM timeout guard) + A11Y1 (version-rail aria-current) + S1 (settings 10M cap parity).**

Why these three:
- **DISP5** is the lowest-risk + highest-impact reliability fix this round. Two `asyncio.wait_for` wraps + a tunable env var; falls into the existing exception handlers. Closes the "SSE hangs forever" failure mode.
- **A11Y1** is two new `aria-current="true"` attributes on existing buttons. Zero behaviour change, immediate WCAG 1.3.1 / 4.1.2 closure.
- **S1** mirrors the round-5 server cap with one client-side branch. Trivial, but completes the parity story from round 5 and avoids the "generic toast on 422" UX dead-end.

**Out of scope this round (will surface in future findings):**
- CONS1-CONS5 (event/consumer reliability): each needs design — task supervision strategy, idempotency key shape, schema versioning protocol.
- DISP1 / DISP2 / DISP3 / DISP4: each is a non-trivial design change (saga rollback semantics, clarification round-trip, classifier failure signalling).
- AUDIT1 (audit write fallback): needs retry + degraded mode design.
- AUDIT5 (agent_tasks retention): needs migration + partitioning policy.
- HITL1-HITL5: thread locking + stale checkpoint detection + payload schema need a coordinated design.
- A11Y3 (carry-over).

---

## Shipped this round

- **DISP5** — `agents/coordinator/router.py`. Added `_ROUTER_LLM_TIMEOUT_S = float(os.environ.get("RELAY_ROUTER_LLM_TIMEOUT_S", "30"))` and wrapped both `model.ainvoke` calls (`llm_intent_classifier` + `_smalltalk_reply`) with `asyncio.wait_for(...)`. Classifier timeout falls into the existing `except Exception` → returns `Intent(other, 0.0)` (same as the pre-existing crash path). Smalltalk timeout returns a friendly "Sorry — I couldn't respond just now" reply so the dock never goes silent. Imports use the in-function `import asyncio as _asyncio` form because autoflake otherwise strips a top-level import while ruff only consults the constant.
- **A11Y1** — `web/src/components/screens/resume-view.tsx:690-705, 785-799`. Added `aria-current={isCurrent ? "true" : undefined}` to both the master version rail button and the tailored variant card button. Sighted users get the visual cue from `railRowStyle` / `ds-card`; SR users now get the same signal via the standard ARIA mechanism.
- **S1** — `web/src/components/views/settings-view.tsx:218-237`. After the negative-integer check, the salary input now also fails fast with `setSalaryError("Salary must be at most 10,000,000.")` when the value exceeds the server cap (`api/src/schemas.ts` `UserPreferencesSchema.minSalary.max(10_000_000)`). Form-level toast no longer has to translate a generic 422 from the server.

Build / lint / typecheck: `ruff check agents/coordinator/router.py` clean. `from agents.coordinator import router` import smoke clean (`_ROUTER_LLM_TIMEOUT_S = 30.0`). 7 server-using pytest cases pass. web `bun run typecheck` + `bun run lint` exit 0. `bun run build` (production, 17 routes) exit 0.

---

## Next-round baseline

Round 7 should:
- Diff against this file's "Out of scope" list — top candidates: DISP1 (try-catch around dispatch branches with intent-aware fallback); CONS1 (lifespan task supervision + auto-restart); HITL2 (advisory lock on `mock_thread_id`).
- Verify rounds 1-6 fixes hold (18 markers across 12 files).
- Re-audit areas still un-covered: `bun api/` route-level rate limit + per-user limit; resume snippet sanitizer; the `applications/{id}/submitted` flow under PG drop; jobmatch_agent.parse_jd_from_url's robots.txt + paywall behaviour; the extension popup permissions confirmation UX.
- Stretch: prototype a small `e2e/` Playwright spec walking auth → upload → mock → applications — so future regressions show up in CI rather than as static-audit deltas.
