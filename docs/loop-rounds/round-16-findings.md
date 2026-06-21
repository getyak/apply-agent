# Round 16 — Findings & Plan

**Trigger:** `/loop 30min` agent teams sixteenth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-15-baseline's "not yet covered" areas — `web/src/lib/store.ts` chat-history hydration race / `agents/coordinator/workflows.py` saga finalize partial-write recovery / `api/src/routes/files.ts` PDF / DOCX MIME validation depth / `web/src/components/screens/extension.tsx` "you submit, we prepare" copy review. Rounds 1-15 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`, `cc7fef0`, `665e347`, `bad2c6e`, `6484ea4`, `7a60173`, `d425052`, `1b2b48a`) verified untouched (46/46 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (real data damage + security)

- **MIME1. No magic-byte verification on uploads** — `api/src/extract.ts:35-49`. `classifyKind` trusts the browser-reported MIME + filename extension. A renamed `.exe` claiming `application/pdf` would reach `unpdf`; polyglot files (valid PDF + valid ZIP) slip past the kind check.
- **MIME4. Presigned download URLs have no `Content-Disposition`** — `api/src/storage.ts:106`. MinIO renders PDFs inline; an HTML / SVG polyglot would execute JavaScript at the storage origin where the API's `nosniff` and CSP don't apply.
- **PASTE5. No NUL / control-character strip on pasted résumé text** — `web/src/lib/store.ts:544-553`. Round-15 baseline carry-over. ASCII C0 controls pass through to the LLM, the DB column, and any downstream parser.
- **SAGA_F1. prepare saga never publishes `application:prepared`** — `agents/coordinator/workflows.py:439-445`. Downstream consumers (TTAR, UI refresh) can't react because the event was never wired.
- **SAGA_F3. application_id reuse triggers full saga rerun** — `agents/coordinator/workflows.py:407-410`. A previously-saved cover letter or form-answers set gets overwritten with each retry — no idempotency.
- **HYDR2. chatMessages stays empty after a transient network failure** — `web/src/lib/store.ts:856-880`. No retry, no last-good-state cache.
- **AUTH4. No `/logout` endpoint, no server-side JWT invalidation** — `api/src/routes/auth.ts`. Round-15 baseline carry-over; 30-day token usable after device loss.
- **AUTH2. No `/forgot-password` endpoint** — same file. Round-15 baseline carry-over; locked-out users have zero recovery.

### High

- **HYDR3. No cross-tab message sync** — `web/src/lib/ask-vantage-store.ts:291-297`. Tab B doesn't see Tab A's new messages until remount.
- **HYDR1. Tab-switch retriggers `/api/ask/recent` with no dedup** — `web/src/app/app/layout.tsx:62-79`. Rapid switching floods the API.
- **HYDR5. SSR hydration mismatch — empty first paint** — `web/src/components/views/chat-view.tsx:51-58`. Network latency adds visible jank.
- **SAGA_F2. PG UPDATE + downstream `publish()` are not atomic** — `agents/coordinator/workflows.py:506-529`. If publish was added in the future (per SAGA_F1) the failure mode would leak: consumers see the event, DB row doesn't reflect it.
- **SAGA_F4. No `status='partial_write'` marker on application_drafts** — `infra/postgres/migrations/006` + `workflows.py:506-529`. Recovery flow can't distinguish "never tried" from "halfway done".
- **SAGA_F5. Generic `internal_error` envelope on saga failures** — `agents/api/server.py:131-141`. User can't tell whether parse_jd or DB write failed.
- **EXT_C1. Extension main screen copy doesn't say "submit happens in your browser"** — `web/src/components/screens/extension.tsx:158`. Only "You press submit, not us" — silent on the WHERE.
- **EXT_C4. No copy explaining sensitive fields (race / SSN / visa) are auto-skipped** — same file. Users see "filled 4 fields" with no hint why some weren't.

### Medium

- **MIME2. Polyglot files (PDF+ZIP) might bypass kind discrimination** — `api/src/markdown.ts:142-147`. Documented; MIME1 fix mitigates.
- **MIME3. `unpdf` and `mammoth` are trusted to fail loudly** — `api/src/extract.ts:51-62`. No size/page cap before parsing.
- **MIME5. Presigned URL TTL is 300s** — `api/src/storage.ts:108`. Long enough to share/leak.
- **EXT_C2. "AI drafted answer" copy doesn't explain data leaves device** — `extension.tsx:142-150`.
- **EXT_C5. No failure / partial-fill explanatory copy** — `extension.tsx`. Only success state is rendered.
- **TEST_RL1. `prepare-from-jd.test.ts` shares a Redis rate-limit key across runs** — `api/src/routes/prepare-from-jd.test.ts:18`. After round-13's Redis bundle made the local client reliably connect, the hardcoded `USER_A` causes test flake within the 60s window.

### Low

- **HYDR4. `chatHydrating` boolean is well-guarded** — `web/src/lib/store.ts:856-880`. Confirmed safe.
- **PASTE4. Paste path is verified to route through `/parse-async` and not `/ask/stream`** — round-15 carry-over.

---

## Round-16 implementation plan

**Pick: MIME1 (magic-byte verification) + MIME4 (presigned `Content-Disposition: attachment`) + PASTE5 (NUL/control-char strip on pasted text), plus an opportunistic TEST_RL1 fix uncovered by the build chain.**

Why these three (plus TEST_RL1):
- **MIME1** is the largest gap in the file-upload story. The round-7 SSRF work locked down outbound requests, but inbound files were trusted entirely from the browser's MIME header + filename extension. New `verifyMagicBytes(kind, data) → boolean` checks the leading bytes match `%PDF` (`25 50 44 46`) or `PK\003\004` (`50 4B 03 04`) before invoking unpdf / mammoth. Text files always pass. `extractText` now refuses mis-matched bytes with a client-actionable `ExtractionError`.
- **MIME4** closes the `Content-Disposition` gap on presigned download URLs. The storage origin has no CSP and no `nosniff` — an HTML/SVG polyglot delivered as `application/pdf` would execute JavaScript at the storage origin. Force `attachment; filename="<safe>"` via Bun's `contentDisposition` option so the browser always triggers a save dialog.
- **PASTE5** is the round-15 baseline carry-over. New tiny `stripControlChars(s)` helper in `web/src/lib/store.ts` strips ASCII C0 controls (`\x00-\x08`, `\x0b`, `\x0c`, `\x0e-\x1f`) and `\x7f` (DEL) — keeps `\t \n \r` because pastes legitimately contain them; leaves C1 (`\x80-\x9f`) alone because they're valid UTF-8 leading bytes for non-ASCII text. `parsePastedText` invokes it before the length check so a paste that smuggled NUL bytes past `trim()` can't reach the API.
- **TEST_RL1** was uncovered while running the verification chain. `prepare-from-jd.test.ts` hard-coded `USER_A = "user-prepare-a-uuid"`, and after round-13's Redis bundle made the local client reliably connect, the rate-limit key (round-7 API_RL1: 5/60s on `/prepare-from-jd`) leaked across consecutive `bun test` invocations. Switched to `user-prepare-a-${process.pid}-${process.hrtime.bigint()}` so every run gets a fresh rate-limit bucket. The mocked stubQuery treats any user id the same, so the suffix is invisible to the rest of the test. Three consecutive runs now pass 4/4.

**Out of scope this round (will surface in future findings):**
- SAGA_F1-5: needs a saga state-machine refactor + a new event type + an idempotency key. Bigger.
- AUTH2 / AUTH4: each needs a token-blacklist Redis design + an email-service decision.
- HYDR2 / HYDR3 / HYDR5: cross-tab sync via BroadcastChannel + offline-friendly retry on `/api/ask/recent`.
- EXT_C1 / EXT_C2 / EXT_C4 / EXT_C5: copy review needs product-writing pass + user-research sign-off.
- MIME2 / MIME3 / MIME5: page-count cap on unpdf, mime sniffing on polyglots, presigned-URL TTL reduction.

---

## Shipped this round

- **MIME1** — `api/src/extract.ts:50-90` (new `verifyMagicBytes` export + magic-byte gate inside `extractText`). PDF declared kind requires `25 50 44 46` ("%PDF"); DOCX declared kind requires `50 4B 03 04` ("PK\003\004", the ZIP magic — DOCX is a zip). Text kind always passes (UTF-8 has no magic). Mismatched bytes throw `ExtractionError` with a client-actionable message instead of being sent to the parser. Live smoke verified 6 cases: PDF-as-pdf ✓, PDF-as-docx ✗, ZIP-as-docx ✓, EXE-as-pdf ✗, empty-as-pdf ✗, EXE-as-text ✓.
- **MIME4** — `api/src/storage.ts:102-131`. `presign(key, ...)` now derives a safe `Content-Disposition: attachment; filename="<segment>"` header from the last `/`-segment of the storage key and ships it via Bun's `contentDisposition` option, which maps to the S3 `response-content-disposition` query parameter. Server-generated keys (`{user_id}/resumes/originals/{file_id}.{ext}`) make the segment safe to embed verbatim; we still regex out anything outside `[\w.\-]` belt-and-braces. The browser will always render a download dialog instead of inlining the file.
- **PASTE5** — `web/src/lib/store.ts:455-470` (new `stripControlChars` helper) + `545-562` (call site inside `parsePastedText`). Strips ASCII C0 controls (except `\t \n \r`) and `\x7f` (DEL) before the length check. Leaves C1 controls (`\x80-\x9f`) alone since they're valid UTF-8 first bytes for non-ASCII text. A paste that smuggled a NUL byte past `text.trim()` is now silently scrubbed — no error, no extra UX, just clean data.
- **TEST_RL1** — `api/src/routes/prepare-from-jd.test.ts:18-26`. Switched `USER_A` from the hardcoded literal to `user-prepare-a-${process.pid}-${process.hrtime.bigint()}` so each `bun test` run gets a fresh rate-limit bucket. Three back-to-back runs now pass 4/4 (up from 1/4 on second invocation pre-fix).

Build / test: api `bun run typecheck` clean; `bun test` shows 183 passes / 0 fails / 383 expect() calls (includes the 4 prepare-from-jd cases stably green over 3 consecutive runs). The 5-case `extract.test.ts` still passes with the new magic-byte gate. web `bun run typecheck` + `bun run lint` exit 0. 27 agents pytest cases pass (3 PG-required skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 17 should:
- Diff against this file's "Out of scope" list — top candidates: AUTH4 (`/logout` + Redis JWT-id blacklist); HYDR2 (retry-with-cache on `/api/ask/recent`); MIME3 (page-count cap on unpdf so a 5000-page PDF can't lock up the worker).
- Verify rounds 1-16 fixes hold (50 markers across ~28 files).
- Re-audit areas still un-covered: `agents/nodes/resume_agent.customize` token budget vs round-8 LLM1 retries; `web/src/components/views/today-queue.tsx` per-row error surfacing; `api/src/middleware/idempotency.ts` round-9's body-match check vs nested-JSON ordering; `apps/extension/src/dom-fill.ts` keyboard event timing (does `input` fire after dispatched events on React-controlled inputs?); `agents/coordinator/workflows.py` `_jobs_node` saga-vs-prepare overlap.
- Stretch: ship the saga `application:prepared` event (SAGA_F1) + add `status='partial_write'` (SAGA_F4) as a coordinated migration + event-bus change.
