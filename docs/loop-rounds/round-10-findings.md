# Round 10 — Findings & Plan

**Trigger:** `/loop 30min` agent teams tenth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-9-baseline's "not yet covered" areas — agents/harness/audit.py PII + retention / agents/coordinator/persist_turn PG transaction semantics / web/src/lib/api.ts ApiError → user-copy mapping / agents/nodes/appprep_agent.py cover-letter PII redaction. Rounds 1-9 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`, `cc7fef0`) verified untouched (28/28 markers grep-confirmed across 18 files).

---

## Issues found (25 new)

### Critical (privacy + correctness)

- **AUDIT_PII1. `audit_log.error_message` stores raw `f"{type(exc).__name__}: {exc}"`** — `agents/harness/audit.py:118`. File paths, DSNs (`postgres://user:pw@host`), API tokens, and chunks of upstream HTTP body land in PG and stay forever.
- **AUDIT_PII2. `conversation_messages.content` stores user input + assistant output unredacted** — `agents/coordinator/router.py:695-696`. Emails / phones / SSN-like patterns persist as plain text.
- **AUDIT_PII4. No retention policy on agent_tasks / conversation_messages** — `infra/postgres/migrations/010_agents.sql`. Unbounded growth + long-tail liability if breached.
- **AUDIT_PII5. No RLS on agent_tasks / conversation_messages** — same migration. A debug endpoint missing `WHERE user_id = $1` leaks every user's history.
- **PT1. TS gateway writes user message before Python writes assistant** — `api/src/routes/ask.ts:122-129` + `agents/coordinator/router.py:649-700`. Network drop between the two leaves orphaned user prompts.
- **PT3. Inconsistent / unbounded truncation between persisters** — Python `[:8000]` (codepoint-safe but no marker); TS side `assistantBuf` had **no cap at all**. 50KB+ tailored-résumé replies bloated PG.
- **API_E1. `ApiError` exposes only `status` + `message`** — `web/src/lib/api.ts:171-179`. Backend `code` + `trace_id` (round-5 envelope, round-9 SSE plumbing) reach the frontend on the streaming path but die at the boundary for plain JSON `fetch` calls.
- **API_E2. 4xx vs 5xx not distinguished in UI copy** — `web/src/lib/store.ts` + view components. "Could not save" reads the same for a 422 validation error and a 503.
- **APPPREP1. base_resume (with address/phone/email) is fed verbatim to cover-letter LLM** — `agents/nodes/appprep_agent.py:248-250` + `agents/coordinator/workflows.py:248-255`. fabrication_guard only checks invented entities, not unintended disclosure.
- **APPPREP3. Sensitive form-field deny-list (race / sex / visa / SSN) is post-hoc string strip** — `agents/nodes/appprep_agent.py:181-193, 196-227`. LLM has already seen the field; only the answer is stripped, not the prompt.
- **APPPREP4. Cover-letter full text logged on failure** — `agents/nodes/appprep_agent.py:129`. Errors surface verbatim LLM output / prompt fragments.

### High

- **AUDIT_PII3. No `pii_redaction_layer()` anywhere** — entire codebase. Zero email/phone/SSN scrubbing before storage.
- **PT2. Long-content tailored-résumé assistant_text was unbounded on TS side** — `api/src/routes/ask.ts:278`. Fixed by PT3 mirror; covered.
- **PT4. Hard DELETE cascade on conversation_sessions orphans InterviewAgent feedback** — `infra/postgres/migrations/007_conversations.sql`. No soft delete; dangling FK references.
- **PT5. All timestamps stored as UTC; no user.preferred_timezone field** — same migration. Read paths display server time; user sees "8h ago" in wrong tz.
- **API_E3. Network errors (offline / TypeError / CORS) unified under `ApiError(0)`** — `web/src/lib/api.ts:122-134`. UI can't differentiate CORS misconfig from real offline.
- **API_E4. UI error display patterns are inconsistent** — toast / inline / silent / modal across views. Predictability suffers.
- **API_E5. Retry affordances vary** — parse offers none, chat offers none, settings shows explicit button. Users learn to ignore failures.
- **APPPREP2. fabrication_guard doesn't catch unintended PII disclosure** — `agents/nodes/resume_agent.py:226-267`. "Lives in SF" → "as a local…" passes the digit/name check.
- **APPPREP5. `list_applications` returns full cover_letter unfiltered** — `agents/tools/applications.py:80-97`. Internal-tool exposure to other users' cover letters.

### Medium

- **AUDIT_PII6. Smalltalk reply (router.py `_smalltalk_reply`) stored verbatim** — `agents/coordinator/router.py:464`. Future LLM "leak my reasoning" pattern would be persisted.
- **PT6. `message_count + 2` race when two concurrent turns hit the same session** — `api/src/routes/ask.ts:283`. Counter double-counts under burst.

### Low

- **CI_RECAP. Round-6 CI gaps (eval `OPENROUTER_API_KEY` silent skip, Python deps not under Dependabot, no CodeQL) remain.**
- **AUDIT_PII7. `audit_log` `output_result` JSONB is also unredacted** — same as AUDIT_PII1 but for the success path; deferred because outputs are mostly small.

---

## Round-10 implementation plan

**Pick: AUDIT_PII1 (error_message redaction) + API_E1 (ApiError carries code + traceId) + PT3 (UTF-8 safe truncation parity Python ↔ TS).**

Why these three:
- **AUDIT_PII1** is a *real* privacy bug — paths, DSN passwords, and OpenRouter API keys would survive in `agent_tasks.error_message` until round-N retention lands. The redactor is a 30-line module-level helper with deterministic patterns and a length cap.
- **API_E1** completes the round-5 / round-9 envelope plumbing: the backend has been emitting `code` + `trace_id` since round-5, the SSE leg has been consuming them since round-9, but every plain JSON caller (settings, tracker, dock metadata fetches, etc.) was still dropping them at `extractErrorMessage`. Single class extension + three throw-site touches.
- **PT3** locks Python and TS to the same `_PERSIST_TURN_MAX_CHARS = 8000` cap with the same trailing marker, so support and audits can tell "the user typed an ellipsis" apart from "we truncated".

**Out of scope this round (will surface in future findings):**
- AUDIT_PII2 / AUDIT_PII3 / AUDIT_PII7: needs a centralised redactor + decision on what counts as PII per column (basics.email vs. user_message body).
- AUDIT_PII4 (retention): needs migration + pg_cron / external job.
- AUDIT_PII5 (RLS): needs `CREATE POLICY` + role plumbing in api/agents.
- PT1 (orphan user message): needs an idempotency-key / outbox pattern.
- PT4 / PT5 / PT6: each is its own migration / endpoint contract.
- API_E2 / API_E3 / API_E4 / API_E5: now that ApiError carries `code`, callers can branch — round-11 should pick the highest-impact view and ship the per-class copy + retry affordance.
- APPPREP1-5: needs a `sanitize_resume_for_cover_letter` helper, prompt updates, plus a `list_applications` permission boundary.

---

## Shipped this round

- **AUDIT_PII1** — `agents/harness/audit.py`. Added `_AUDIT_ERROR_MAX_CHARS=500`, three regex patterns (`_AUDIT_PATH_RE`, `_AUDIT_TOKEN_RE`, `_AUDIT_DSN_RE`), and `_redact_exception_text(raw) -> str`. The `except Exception` arm in `audit(...)` now persists the redacted text into `record.error_message` and emits the unredacted text via `log.warning("audit.exception", raw=raw_error)` so support can still see the full picture via the structured log stream. Live smoke:
  - `FileNotFoundError: … /Users/x/secret.txt` → `… <path>`
  - `postgres://relay:hunter2@localhost:5433/relay` → `<dsn>`
  - `invalid API key sk-abc123…pqr678` → `<token>`
  - 1000-char blob → 18 chars (token regex collapses + length cap)
- **API_E1** — `web/src/lib/api.ts`. `ApiError` constructor accepts an optional `meta?: { code?, traceId? }`; public `.code?` and `.traceId?` fields populated when present. New private `extractErrorMeta(body)` parses both `{ error: { code, message, traceId } }` and `{ error: { code, trace_id } }` (snake_case Python form). All three throw sites (`apiRequest`, `users.deleteMe`, `files.upload`) now pass meta through. Existing two-arg `new ApiError(status, message)` callsites still work — fully backwards-compatible.
- **PT3** — Python (`agents/coordinator/router.py`) adds `_PERSIST_TURN_MAX_CHARS = 8000` + `_PERSIST_TRUNC_MARKER = "…(truncated)"` and a `_truncate_for_history(text)` helper used by `persist_turn`'s INSERT. TS gateway (`api/src/routes/ask.ts`) mirrors the constants and adds `truncateForHistory(text)` (codepoint-safe iterator, same marker). User leg + assistant leg both go through the helper before the PG write. Smoke: empty preserved, "hello world" preserved, 10 000 'x' truncated to exactly 8 000 chars with the marker at the tail, 4 000 emoji preserved without surrogate split.

Build / test: `ruff check audit.py router.py` clean. Python smoke confirms redactor + truncator work end to end. web `bun run typecheck` + `bun run lint` exit 0. api `bun run typecheck` clean; `bun test` reports 183 passes / 0 fails / 382 expect() calls. 27 agents pytest cases pass (3 PG-required skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 11 should:
- Diff against this file's "Out of scope" list — top candidates: APPPREP1 (`sanitize_resume_for_cover_letter` helper before LLM call), API_E2 (4xx vs 5xx UI copy split now that ApiError carries `code`), AUDIT_PII4 (decision on retention: pg_cron job or external Sweeper service).
- Verify rounds 1-10 fixes hold (31 markers across ~20 files).
- Re-audit areas still un-covered: `api/src/db.ts` connection-pool lifecycle + leak detection; `agents/nodes/interview_agent.py` weak_points aggregation across sessions; `web/src/components/chat/markdown-message.tsx` sanitization (round-7 SEC2 carry-over); `web/public` static asset hygiene; chrome-extension `apps/extension/manifest.json` permissions tightness (round-3 carry-over).
- Stretch: pick the highest-traffic ApiError caller (likely `store.ts` `loadJobs` / `loadApplications`) and ship per-`code` retry UX — closes API_E2 + API_E5 in one pass.
