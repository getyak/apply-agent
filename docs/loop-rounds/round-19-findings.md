# Round 19 — Findings & Plan

**Trigger:** `/loop 30min` agent teams nineteenth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-18-baseline's "not yet covered" areas — `web/src/components/ask-vantage/dock.tsx` SSE reconnect after server restart / `api/src/cache.ts` cache-stampede protection / `web/src/components/screens/onboarding.tsx` upload-while-paste race / `agents/harness/checkpointer.py` PostgresSaver concurrent thread_id writes. Rounds 1-18 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`, `cc7fef0`, `665e347`, `bad2c6e`, `6484ea4`, `7a60173`, `d425052`, `1b2b48a`, `e0af508`, `cb7f0dc`, `991b4a0`) verified untouched (56/56 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (cost stampede + reconnect UX + injection bypass)

- **CACHE_S1. Two concurrent misses run `loader()` twice** — `api/src/cache.ts:69-71`. No Promise cache, no Redis SETNX, no inflight tracking. A spike of identical traffic on a cold key doubles (or N-times) every LLM/upstream call.
- **CACHE_S3. Loader failure isn't cached** — `api/src/cache.ts:71-72`. A transient LLM 500 keeps retrying immediately on every following request, amplifying a small outage into a stampede.
- **DOCK_R1. SSE disconnect = no automatic reconnect** — `web/src/lib/ask-stream.ts:446-453`. User sees a permanent italic error and must manually re-send the prompt.
- **DOCK_R2. No exponential backoff anywhere** — same file. Single-shot per `sendAsk`; flaky network = outright failure.
- **DOCK_R3. Partial responses freeze in place with no "interrupted" marker** — `web/src/lib/ask-stream.ts:500-545, 660-693`. Half-finished sentence + italic error below reads as a confident, complete answer to a hurried user.
- **ONBOARD_R1. upload + paste run concurrently with no AbortController** — `web/src/lib/store.ts:557-606`. Newest call wins on storage state, but old job's poll callback can still flip status fields.
- **ONBOARD_R2. In-flight guard is `parseJobStatus === "running"`** — `web/src/lib/store.ts:586-587`. There's a window between request kickoff and status flip where a second call still gets through.
- **ONBOARD_R4. Cancelled uploads leak file rows** — `web/src/components/screens/onboarding.tsx:96-105`. Once `filesApi.upload` returns, the row stays even if the user navigates away.
- **CKPT_R5. ainvoke failure can leave a dangling checkpoint row** — `agents/harness/checkpointer.py` (via langgraph-checkpoint-postgres). `UPSERT_CHECKPOINTS_SQL` runs before `executemany` blobs, so a crash between them leaves a checkpoint with missing channel values.
- **INTENT4. LLM-emitted `mode_slug` reaches `load_mode()` with no enum / regex check** — `agents/coordinator/router.py:289-292`. Round-14 closed the SQL injection door (parameterised); round-19 still lets the LLM hit the DB with garbage strings and pay for the round-trip.

### High

- **CACHE_S2. No single-flight Promise dedup** — `api/src/cache.ts`. Same root cause as CACHE_S1 but worth tracking separately for the future fix.
- **CACHE_S5. Stale-while-revalidate is impossible** — `api/src/cache.ts`. No `staleTtl` separation from `freshTtl`.
- **DOCK_R4. Status states are text-only** — `web/src/lib/ask-stream.ts:660-693`. No "connecting" or "disconnected" badge anywhere outside the bubble.
- **DOCK_R5. Re-send after error creates a new pair of bubbles** — `web/src/lib/ask-stream.ts:463-470`. Old half-answer remains; duplication is confusing.
- **ONBOARD_R3. Tab switch clears `parseError`** — `web/src/lib/store.ts:534, 546, 573`. New parse's error can hide an unrelated old failure.
- **ONBOARD_R5. job_id reuse on poll** — `web/src/lib/store.ts:625-626`. Old job's poll callback can still write to current state after the new job overwrote `parseJobId`.
- **CKPT_R1. Local asyncio.Lock is process-scoped** — `agents/harness/checkpointer.py:19`. Two API workers (gunicorn fork) would serialize *within* a worker but race *across* workers.
- **INTENT1. Intent classifier system prompt has no "ignore inline instructions" guard** — `agents/prompts/coordinator/intent_classifier.v1.md`. round-18 baseline carry-over.

### Medium

- **CACHE_S4. TTL via `SET … EX` is atomic** — `api/src/cache.ts:47-52`. Confirmed safe; audit-confirmed.
- **CKPT_R2. UPSERT is atomic at the SQL level** — `agents/harness/checkpointer.py`. Confirmed safe.
- **CKPT_R3. dock vs mock thread namespaces don't collide** — `agents/harness/checkpointer.py:45-52`. Confirmed safe.
- **CKPT_R4. checkpoint_writes uses composite PK; no partial dup risk** — confirmed safe.
- **INTENT5. SSE event payload XSS layer still missing** — round-18 baseline; mitigated by current frontend behaviour.

### Low

- **AUTH4 / HYDR2 / CUST1-6 / TQ1-5 / FILES_SIZE2 / FILES_SIZE3 / FILES_SIZE4 / PROFILE1-3-5 / INTENT2-3.** Carry-overs from earlier rounds.

---

## Round-19 implementation plan

**Pick: INTENT4 (mode_slug enum allow-list) + CACHE_S3 (error-ttl sentinel) + DOCK_R3 (partial-answer interrupted marker).**

Why these three:
- **INTENT4** picks up round-18 baseline. The LLM emits `mode_slug` in `intent.args`, which fed directly into `load_mode(slug)` — parameterised SQL closes injection, but the audit pointed out a wasted DB round-trip on garbage strings and a path for a hostile user to "discover" custom mode names they shouldn't see. New `_normalize_mode_slug(raw)` accepts built-in slugs verbatim and gates user-custom slugs on a snake_case-identifier regex (lowercase letters / digits / underscore, 2-64 chars). Garbage collapses to the safe `scene_recreation` default before any I/O. Smoke verified 9 cases (built-in, valid custom, English sentence, injection attempt, uppercase, non-string, empty, too short, digit-leading) all behave correctly.
- **CACHE_S3** unblocks the round-18 baseline's biggest reliability concern. `getOrSet` now wraps `loader()` in try/catch; on failure it writes a short-lived error sentinel `{__cached_error__: message}` with `NEGATIVE_TTL = 30s` and re-throws. The next call within the window spots the sentinel and throws `CachedFailure` without touching the upstream; after the sentinel expires, a single retry is allowed through. Smoke verified: 2 successive calls to a failing loader → 1 actual call + 1 cached-failure rethrow (loaderCalls stays at 1). CACHE_S1 (full single-flight) deferred — it needs a Promise cache + per-key inflight tracking.
- **DOCK_R3** addresses the most visible UX bug — a half-finished SSE response that freezes in place with no visual sign it's incomplete. Add a leading `_[Answer interrupted]_` italic marker whenever `assistantBuf.length > 0` at the disconnect / timeout / unreachable error sites. Three sites updated; the marker only appears when there's an actual partial response to flag (clean errors keep the existing copy).

**Out of scope this round (will surface in future findings):**
- CACHE_S1 / CACHE_S2 / CACHE_S5: full single-flight + stale-while-revalidate is a bigger redesign.
- DOCK_R1 / DOCK_R2 / DOCK_R4 / DOCK_R5: a real reconnect state machine + status badge needs Zustand state additions + UX design.
- ONBOARD_R1-5: AbortController + unique requestId per parse needs a refactor of `_startAsyncParse`.
- CKPT_R1 / CKPT_R5: process-scoped lock + dangling-row cleanup needs a setup() integrity scan.
- INTENT1 / INTENT2 / INTENT3 / INTENT5: prompt-injection hardening + arg validation + XSS layer still on round-18 baseline.
- All older carry-overs.

---

## Shipped this round

- **INTENT4** — `agents/coordinator/router.py:55-95` (new `_BUILT_IN_MODE_SLUGS` frozenset + `_VALID_CUSTOM_MODE_SLUG_RE` + `_normalize_mode_slug` helper) + `agents/coordinator/router.py:295-310` (dispatch site now runs `slug = _normalize_mode_slug(slug_raw) or "scene_recreation"` before reaching `load_mode`). Built-in slugs pass verbatim; user-custom snake_case slugs match the regex; everything else collapses to the safe default. Live smoke verified 9 cases.
- **CACHE_S3** — `api/src/cache.ts:59-130`. `getOrSet` gains optional `errorTtlSeconds` parameter (default `NEGATIVE_TTL = 30s`). Wraps `loader()` in try/catch: on success, caches the value with the normal TTL; on failure, writes an `ErrorSentinel` to the cache with the short error TTL and re-throws the original error. Subsequent calls inside the window detect the sentinel via the new `isErrorSentinel` type guard and throw the new `CachedFailure` Error subclass without re-running the loader. The 6-case `cache.test.ts` still passes. Live smoke: failing loader → first call runs once + throws; second call throws CachedFailure without loader re-run.
- **DOCK_R3** — `web/src/lib/ask-stream.ts:660-693`. Three error sites (`timeout`, `unreachable`, `disconnect`) now prepend `_[Answer interrupted]_` when `assistantBuf.length > 0` so the half-finished response is visually marked. Clean-error cases (no tokens received yet) keep the existing copy. The existing trace_id + retry copy still ships below.

Build / test: `ruff check coordinator/router.py` clean. Python smoke confirms `_normalize_mode_slug` covers built-in, valid custom, English sentence, injection attempt, uppercase, non-string, empty, too short, digit-leading. api `bun run typecheck` clean; `bun test` shows 183 passes / 0 fails / 383 expect() calls (incl. 6-case `cache.test.ts`). web `bun run typecheck` + `bun run lint` exit 0. 27 agents pytest cases pass (3 PG-required skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 20 should:
- Diff against this file's "Out of scope" list — top candidates: CACHE_S1 / CACHE_S2 (Promise-cache-based single flight per key); DOCK_R1 / DOCK_R2 (exponential-backoff reconnect inside `runAskStream` for `disconnect` kind only); ONBOARD_R1 (per-method `parseRequestId` so stale poll callbacks are no-ops).
- Verify rounds 1-19 fixes hold (59 markers across ~33 files).
- Re-audit areas still un-covered: `agents/coordinator/workflows.py` `_jobs_node` cookie handling for ATS pages that require session; `web/src/components/views/today-queue.tsx` empty-state copy (round-17 TQ1 mentions this is row-level error surfacing — but the empty state itself never surfaces network failures); `api/src/routes/resumes.ts` /analyze cache key collision when two different users share the same `(resumeId, version)`; `web/src/components/screens/builder.tsx` step-back unwind (round-13 added beforeunload, but in-app navigation away?); `agents/nodes/jobmatch_agent._http_get` redirect handling (does it follow cross-host 302s after round-7 SSRF guard?).
- Stretch: ship CACHE_S1 (in-memory Promise cache by key — single-process single flight is the 90% win; multi-instance still races but we don't have horizontal scale yet) — completes the round-19 stampede story.
