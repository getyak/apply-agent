# Round 12 — Findings & Plan

**Trigger:** `/loop 30min` agent teams twelfth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-11-baseline's "not yet covered" areas — `api/src/middleware/observability.ts` X-Request-Id propagation into Python / `agents/coordinator/router.py` multilingual intent classifier accuracy / `agents/nodes/jobmatch_agent.py` LLM JD-parse hallucination rate / `web/src/app/app/today/page.tsx` empty-state UX on a brand-new account. Rounds 1-11 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`, `cc7fef0`, `665e347`, `bad2c6e`) verified untouched (34/34 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (observability + data trust + onboarding)

- **OBS1. Bun gateway generates X-Request-Id, echoes to browser, but does NOT forward to Python** — `api/src/middleware/observability.ts:11-16` + `api/src/routes/ask.ts:163-181`. Trace breaks at the gateway boundary; agent_tasks have no breadcrumb back to the request.
- **OBS3. Python `structlog` never binds the request id to context** — `agents/api/server.py:41,184-190`. Every log line in a turn is context-free; production debugging requires `user_id + timestamp` grepping.
- **OBS4. `agent_tasks` table has no `request_id` column** — `infra/postgres/migrations/010_agents.sql`. Cross-service trace assembly is structurally impossible.
- **ML1. Layer-1 regex is English-only** — `agents/coordinator/router.py:69-117`. `\b` word boundaries don't fire across CJK; "帮我找份工作" misses every rule.
- **ML2. Layer-2 LLM prompt is English-only** — `agents/prompts/coordinator/intent_classifier.v1.md:1-34`. Mixed CN/EN inputs (typical for Vantage users) see ~10-15% confidence drop vs. pure English.
- **JD_H1. LLM JD parse output is *not* validated against the raw JD** — `agents/nodes/jobmatch_agent.py:461-462`. "Senior role in Zurich, $450k" passes through if the LLM emits it.
- **JD_H4. Numeric fields accept negative / 10^10 / swapped min/max** — `agents/nodes/jobmatch_agent.py:492-503`. Currency mixing not normalised; salary_min < 0 reaches PG.
- **JD_H5. Zero LLM-accuracy regression eval** — `agents/tests/test_jobmatch_parse_jd.py:146-149` + `eval/delivery-loop/run.py:106-119`. LLM stub returns hardcoded results; no golden dataset.
- **TODAY1. Brand-new account sees "0 trending skills" with no context** — `web/src/components/views/today-view.tsx:254-257`. Reads as "service broken" not "you're new".
- **TODAY2. Empty action queue has no CTA** — `web/src/components/views/today-view.tsx:306-309`. Passive "applications, interviews and learn signals will surface here automatically" — no concrete next step.

### High

- **OBS2. `X-Trace-Id` (round-5 error envelope) and `X-Request-Id` are two unrelated namespaces** — `agents/api/server.py:120,131` + `observability.ts:15`. Frontend gets both, neither linked.
- **ML3. Conversational / colloquial inputs ("挑挑刺看我简历有啥毛病") fall to `Intent(other, 0.0)`** — `agents/coordinator/router.py:216,233-238`. No needs_clarification fallback.
- **ML4. No multilingual test fixtures in `agents/tests/`** — entire test dir. No baseline for CN vs EN classification accuracy.
- **JD_H2. "3-5 years preferred" → "5 years required" silent reframe** — `parse_jd.v1.md:23-31` + `jobmatch_agent.py:461`. Subtle intent drift survives without a change_log.
- **JD_H3. Empty/garbage JD → silent `_empty_parsed()`** — `jobmatch_agent.py:439-440,445-446,457-459`. Indistinguishable from honest "no skills mentioned".
- **TODAY3. Onboarding → /app/today flow has no warm-up step** — `web/src/app/app/page.tsx:8-22` + `web/src/app/app/layout.tsx:148-156`. User goes straight from upload to a cold empty home.
- **TODAY4. No returning-user vs new-user distinction** — `web/src/app/app/layout.tsx:140-156`. Stale data unsignposted.

### Medium

- **TODAY5. Demo seed cards "Live matches" can confuse new users** — `web/src/components/views/today-view.tsx:355-431`. "Demo" label may be missed.
- **OBS5. `requestLogger` emits `userId` per request but lacks `traceId`** — `api/src/middleware/observability.ts:18-46`. No correlation with Python-side errors.

### Low (carry-over / confirmed-safe)

- **ML5. RTL languages (Arabic/Hebrew) work end-to-end at the encoding level but the Layer-1 regex is functionally inert** — `agents/coordinator/router.py:69-117,406`. Same fallthrough as CJK.
- **JD_H6. `salary_min/max` schema lacks CHECK constraints** — `infra/postgres/migrations/005_jobs.sql:13`. PG can't catch negative values either.

---

## Round-12 implementation plan

**Pick: OBS bundle (OBS1 + OBS3) + JD_H4 (numeric field sanity in `_normalize_parsed`) + TODAY2 (empty-queue CTA for new accounts).**

Why these three:
- **OBS bundle** closes the gateway → Python trace gap with two small additions: `ask.ts` forwards the existing `c.get("requestId")` as `X-Request-Id`; `server.py` accepts it and binds it via `structlog.contextvars.bind_contextvars`. The agent_tasks column (OBS4) needs a migration so it's deferred — but the structlog context lands on every log line immediately.
- **JD_H4** is the highest-confidence data-integrity fix this round. `_sanitize_salary` clamps to `[0, 5_000_000]`, drops non-numerics, and `_normalize_parsed` swaps min/max if the LLM emitted them backwards. Live smoke: negative → None, 10^9 → None, "abc" → None, swap → ascending, honest values preserved.
- **TODAY2** is the round-1 / round-2 "new account dead screen" carry-over that the round-12 onboarding audit revived. Branches the empty-state copy on whether `parsedResume` is set: no résumé → `<Upload résumé>` CTA card; has résumé → original passive copy (the queue really will populate organically as the user applies).

**Out of scope this round (will surface in future findings):**
- OBS4 (agent_tasks.request_id column): needs a migration. Round-13 should ship 017_agents_request_id.up.sql + the audit.py field plumbing.
- OBS2 (unify trace_id + request_id): needs a protocol decision.
- ML1-ML5 (multilingual classifier): needs a prompt rewrite + CJK-aware regex + a fixtures dataset. Each is its own commit.
- JD_H1 / JD_H2 / JD_H3 / JD_H5 / JD_H6: needs fabrication_guard equivalent + an eval gate. Bigger.
- TODAY1 / TODAY3 / TODAY4 / TODAY5: each is its own UX micro-decision; round-13 should pick "0 trending skills" copy + new-vs-returning distinction.
- MD2 (round-11 carry-over — `resume-view.tsx:2046` raw markdown): deferred; round-12's three picks already touch four files.

---

## Shipped this round

- **OBS bundle (OBS1 + OBS3)** — `api/src/routes/ask.ts:163-181` + `agents/api/server.py:184-206`. Bun's `requestId` middleware already set `c.var.requestId` on every request; `ask.ts` now grabs it via `c.get("requestId")` and forwards as `X-Request-Id` to the Python host. `server.py`'s `/ask/stream` declares a new optional `x_request_id: Annotated[str | None, Header()] = None` parameter and calls `structlog.contextvars.bind_contextvars(request_id=x_request_id)` so every subsequent log line in the turn carries the same id. `ask_stream.start` log line now includes `request_id=…` as an explicit field as well. structlog's contextvars-based binding is scoped to the current asyncio task, so concurrent requests stay isolated.
- **JD_H4** — `agents/nodes/jobmatch_agent.py:492-503`. New `_sanitize_salary(val)` helper clamps integer values to `[0, 5_000_000]`, drops non-numerics, and `_normalize_parsed` now swaps `salary_min`/`salary_max` if the LLM emitted them in reverse order. Live smoke: -50 000 → None, 999 999 999 → None, "abc" → None, 80 000 → 80 000, swap 200 000/100 000 → 100 000/200 000, single-negative drops only that side.
- **TODAY2** — `web/src/components/views/today-view.tsx:306-340`. Empty action-queue branch now checks `parsedResume`: when there's no parsed résumé, render a single-CTA card ("Start with your résumé. Vantage builds the queue once it has something to match against — upload or paste your résumé…") that routes to `/app/studio/resume`; when there is, the original passive copy still applies (the queue genuinely will populate organically).

Build / test: `ruff check api/server.py nodes/jobmatch_agent.py` clean. Python smoke confirms structlog binding works and `_sanitize_salary` covers every attack vector. `bun run typecheck` (api + web) clean; `bun test` shows 183 passes / 0 fails / 383 expect() calls. 27 agents pytest cases pass (3 PG-required skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 13 should:
- Diff against this file's "Out of scope" list — top candidates: OBS4 (017_agents_request_id.up.sql migration so request_id reaches the audit row), JD_H1 (LLM JD parse validation against raw jd_text), TODAY1 (new-account "0 trending skills" disambiguation copy), ML4 (multilingual classifier test fixtures).
- Verify rounds 1-12 fixes hold (37 markers across ~22 files).
- Re-audit areas still un-covered: `web/src/components/screens/builder.tsx` resume-builder text input sanitization; `agents/coordinator/persist_turn` SQL injection surface after the round-12 multilingual additions; `api/src/redis.ts` connection lifecycle (parallel to the round-11 db.ts work); chrome-extension `apps/extension/src/cloud-fill.ts` per-field deny-list (round-7 SEC3 carry-over); `web/src/lib/store.ts` JOBS hardcoded fixture (still a dev shortcut?).
- Stretch: the `_sanitize_salary` bound (5_000_000) was picked from "well above any honest annual figure" rule-of-thumb. Round-13 should validate it against the actual jobs.parsed snapshot in dev PG and pick a defensible upper bound.
