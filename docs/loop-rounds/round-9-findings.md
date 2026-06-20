# Round 9 — Findings & Plan

**Trigger:** `/loop 30min` agent teams ninth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-8-baseline's "not yet covered" areas — Redis Streams bus.py lifecycle & retry / agents/tools permission boundary & audit / ask-stream SSE retry & reconnection / api/idempotency middleware. Rounds 1-8 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`) verified untouched (24/24 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (security + correctness)

- **BUS1. Redis client newly created on every publish / subscribe call** — `agents/events/bus.py:30,52`. No connection pool; high-frequency events thrash TCP and leak TIME_WAIT sockets.
- **BUS3. publish() exceptions are uncaught in /applications/{id}/submitted** — `agents/api/server.py:412-422`. PG already wrote `submitted=true`; Redis publish raises → 500 → frontend retries → state diverges from event log.
- **BUS4. Consumer offset is in-memory only** — `agents/events/bus.py:53,59` + `agents/events/consumers.py:68-88`. Restart → cursor resets to `"$"` → all in-flight events between crash and restart are lost.
- **TOOLS3. `tools/auto.fetch_url` accepts any URL** — `agents/tools/auto.py:17-22`. A prompt-injected resume / JD can nudge an agent into `fetch_url("http://169.254.169.254/")` or `file:///etc/passwd`. Round-7 closed the same hole in jobmatch_agent; tools/auto is a parallel surface.
- **TOOLS1. NOTIFY layer is stub-only** — `agents/tools/notify.py:2-4`. `mark_notify` sets an attribute that the API layer never reads; no event is published, no frontend listener exists.
- **TOOLS5. Tool-level audit absent** — `agents/harness/audit.py:1-125`. AuditRecord has no `tool_name`/`tool_params`/`tool_result`; only the agent node is logged.
- **SSE1. No automatic reconnection on SSE drop** — `web/src/lib/ask-stream.ts:359-372,418-425`. User loses partial output and must manually retry.
- **SSE4. Backend `code` + `trace_id` in error envelope never reach the dock** — `web/src/lib/ask-stream.ts:116,319` + `api/src/routes/ask.ts:440-446`. Frontend can't distinguish `budget_exhausted` from `internal_error`; trace_id is silently dropped.
- **SSE5. Mid-stream reload drops accumulated tokens** — `web/src/lib/ask-stream.ts:472`. `assistantBuf` is in-memory; only the final `_result_summary()` is persisted server-side.
- **IDEM3. Same Idempotency-Key with different body → silent replay** — `api/src/middleware/idempotency.ts:86-92`. Client mutating the body but reusing the key receives the *prior* response with no signal.
- **IDEM4. Concurrent same-key requests both execute the handler** — `api/src/middleware/idempotency.ts:49-95`. No SETNX / distributed lock; race breaks the idempotency contract entirely.

### High

- **BUS2. Redis auth failures uncaught** — `agents/events/bus.py:20-21`. Wrong password / ACL reject → publish raises, lifespan task can't recover.
- **TOOLS4. NOTIFY layer has no WebSocket listener in `web/`** — extension of TOOLS1.
- **TOOLS2. APPROVE `interrupt()` timeout never logged to audit** — `agents/harness/permissions.py:54`. No record that approval expired vs the user explicitly rejected.
- **SSE2. New `sendAsk` mid-stream cancels old prompt with no queue** — `web/src/lib/ask-stream.ts:444-446`. Rapid clicks lose intermediate prompts entirely.
- **IDEM1. Idempotency-Key fully client-controlled** — `api/src/middleware/idempotency.ts:50,58-61`. Predictable keys are guessable across replays of the same user.
- **IDEM2. No response body size cap; no Redis eviction policy** — `api/src/middleware/idempotency.ts:117`. A 1 MB cover-letter response × 24h TTL × thousands of users = Redis OOM.

### Medium

- **BUS5. Consumer test mocks bypass real Redis errors** — `agents/tests/test_application_submitted.py:35-71`. Only PG-failure paths are exercised.
- **SSE3. Mobile background → foreground reconnect lost after 2 min idle** — `web/src/lib/ask-stream.ts:137,349`. STREAM_IDLE_TIMEOUT_MS aborts; no resume.
- **TOOLS6. `list_applications` status param not allow-listed** — `agents/tools/applications.py:89-91`. Agent-supplied value reaches SQL `WHERE` without enum check.

### Low (already-covered carry-overs)

- **IDEM5. User isolation correctly namespaced** — `api/src/middleware/idempotency.ts:36-37`. Confirmed-safe.

---

## Round-9 implementation plan

**Pick: TOOLS3 (auto.fetch_url SSRF block) + SSE4 (code-aware error UX) + IDEM3 (body-mismatch 409).**

Why these three:
- **TOOLS3** is a *real* SSRF gap on the most agent-callable surface; the helper is a deliberate copy of the round-7 jobmatch helper so both surfaces enforce the same policy.
- **SSE4** is the biggest UX-correctness win this round — the global exception envelope (round-5 API1/API2) was already in place; round-9 just plumbs `code` + `trace_id` through to the dock and branches on `budget_exhausted` / `http_403`.
- **IDEM3** closes the silent-body-replay hole. Old cache entries without `requestHash` still replay unchanged (back-compat) so in-flight Idempotency-Keys don't break on deploy.

**Out of scope this round (will surface in future findings):**
- BUS1 / BUS2 / BUS3 / BUS4 / BUS5: each is its own design — connection pool, persistent offset, idempotency on `/submitted`, integration test harness.
- TOOLS1 / TOOLS2 / TOOLS4 / TOOLS5 / TOOLS6: needs an end-to-end NOTIFY pipeline, audit-record schema migration, allow-list policy.
- SSE1 / SSE2 / SSE3 / SSE5: SSE reconnect + token persistence is a separate frontend redesign.
- IDEM1 (key forgery): needs a server-issued nonce design.
- IDEM2 (size cap + eviction): needs ops policy decision + maxmemory-policy tuning.
- IDEM4 (concurrent race): needs Redis SETNX / Lua script flow.

---

## Shipped this round

- **TOOLS3** — `agents/tools/auto.py`. Added stdlib `ipaddress` + `socket` imports and the `_is_public_http_url(url) → (bool, reason)` helper (mirrors the round-7 jobmatch implementation so a prompt that swaps fetcher tools can't sidestep the policy). `fetch_url` now pre-flights every URL; `file://`, `http://localhost:5432/`, `http://169.254.169.254/`, `http://10.0.0.5/` all raise `ValueError("refusing to fetch …: <reason>")`. Live smoke confirmed 4 attack vectors rejected; Greenhouse allowed.
- **SSE4** — `api/src/routes/ask.ts:440-446` forwards Python's `code` + `trace_id` envelope fields. `web/src/lib/ask-stream.ts` (a) extends `StreamFrame.error` with optional `code` / `trace_id`, (b) extends `AskStreamCallbacks.onError` with two new kinds (`"budget"` / `"forbidden"`) and an optional `meta` arg, (c) maps `code === "budget_exhausted"` → `"budget"` and `code === "http_403"` → `"forbidden"`. The default `runAskStream` caller branches on the kind and appends `Reference: <trace_id>` to the user-visible message when available.
- **IDEM3** — `api/src/middleware/idempotency.ts`. `StoredResponse` gains `requestHash?: string` (sha256 hex via `crypto.subtle.digest`). Cache-hit branch compares the current request body's hash to the stored one and throws `ConflictError` (HTTP 409) on mismatch. Old entries without `requestHash` keep replaying so in-flight keys don't break. Existing 10 idempotency tests still pass.

Build / test: `ruff check agents/tools/auto.py` clean. SSRF helper smoke: 4 attack vectors blocked, Greenhouse allowed. web `bun run typecheck` + `bun run lint` clean. api `bun run typecheck` clean; `bun test` shows 183 passes / 0 fails / 382 expect() calls (incl. 10 idempotency cases). 22 agents pytest cases pass (4 submitted + 3 extension map fields + 15 jobmatch + 5 prepare_application; 3 PG skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 10 should:
- Diff against this file's "Out of scope" list — top candidates: IDEM4 (concurrent race via SETNX), BUS3 (transactional /submitted), SSE1 (auto-reconnect with backoff).
- Verify rounds 1-9 fixes hold (27 markers across 18 files).
- Re-audit areas still un-covered: `agents/harness/audit.py` PII + retention; `agents/coordinator/persist_turn` PG transaction semantics; `web/src/lib/api.ts` ApiError → user-copy mapping; `agents/nodes/appprep_agent.py` cover-letter PII redaction; `api/src/middleware/security.ts` body-size & header-injection edge cases.
- Stretch: extract the round-7 + round-9 SSRF guard to `agents/harness/security.py` and dedup the two copies. Today both helpers are identical; a regression in one is invisible to the other.
