# Round 15 — Findings & Plan

**Trigger:** `/loop 30min` agent teams fifteenth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-14-baseline's "not yet covered" areas — `agents/api/server.py` `/mock/start` payload validation symmetry / `web/src/components/screens/onboarding.tsx` paste PII redaction / `agents/tools/pg_query` exception logging / `api/src/routes/auth.ts` magic-link + OAuth surface. Rounds 1-14 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`, `cc7fef0`, `665e347`, `bad2c6e`, `6484ea4`, `7a60173`, `d425052`) verified untouched (43/43 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (asymmetric guards + PII leak + missing auth surface)

- **MOCK_S1. `MockStartPayload` has no `Field` length bounds** — `agents/api/server.py:544-549`. HITL_R3 (round-8) capped MockResumePayload at 128 / 50 000; MockStartPayload accepts 1 MB strings into the cache-key composition and structured logs.
- **MOCK_S2. `mode_slug` has no `Literal` / enum constraint** — same file. parameterised SQL means no injection, but any string reaches the `WHERE slug = %s` lookup.
- **PG_R1. Three `error=str(exc)` sites in `agents/api/server.py` skipped the round-14 redaction** — `agents/api/server.py:134, 263, 425`. `unhandled_exception` / `ask_stream.dispatch_failed` / `applications.submitted.db_write_failed` still leak DSNs and paths.
- **PG_R2. Three `error=str(exc)` sites in `agents/nodes/jobmatch_agent.py`** — `agents/nodes/jobmatch_agent.py:445, 458, 592`. `jobmatch.no_llm_key`, `jobmatch.llm_failed`, `jobmatch.upsert_failed` all on the raw path.
- **EXT_SEC1. No client-side sensitive-field deny-list** — `apps/extension/src/local-fill.ts`. Round-13 added the server-side `SENSITIVE_TOKENS`; the extension client never had a mirror, so a future endpoint that skips the server guard would still upload SSN / DOB / visa fields.
- **PASTE2. Raw résumé text persists to `resumes.raw` indefinitely** — `api/src/routes/resumes.ts:174`. Parse failure still writes the full PII to the row; no purge hook.
- **AUTH2. No `/forgot-password` / `/reset` endpoint** — entire `api/src/routes/auth.ts`. A locked-out user has no recovery path.
- **AUTH4. No `/logout` endpoint, no server-side token invalidation** — same file. A stolen JWT is usable for the full 30 days.

### High

- **MOCK_S3. `company` / `role` are user free text with no max length** — `agents/api/server.py:547-548`. Reaches the `intel_brief:{company}:{role}:{round}` Redis cache key.
- **AUTH1. Only email/password — no magic-link, no OAuth/SSO** — entire file. Phishing surface concentration.
- **AUTH3. JWT expires in 30 days, no refresh token** — `api/src/middleware/auth.ts:12`. Long-lived token + no rotation.
- **AUTH5. No CSRF token, no session rotation** — entire `auth.ts`. CSRF mitigated by JWT-in-Authorization-header today, but no defence-in-depth.
- **PASTE1. Frontend textarea has no maxlength** — `web/src/components/screens/onboarding.tsx:147`. 60 KB hard cap at the API rejects silently; user gets no progressive feedback.
- **PASTE5. No control-char / NUL byte stripping on pasted text** — `web/src/lib/store.ts:545`. Passes through to the LLM and DB unchecked.

### Medium

- **PASTE3. Redis cache for analysis output keeps for 7 days** — `api/src/cache.ts:16-20`. Analysed PII (extracted email/phone) can linger.
- **PASTE4. Paste hits parse-async, not ask/stream** — verified clean; conversation_messages don't get the paste content.
- **MOCK_S4. `round_type` is open-ended** — `agents/api/server.py:548`. The 009 migration has a CHECK constraint on `interview_sessions.stage`, but the payload doesn't enforce it.

### Low

- **PG_R3. `pg_query` doesn't wrap raw psycopg exceptions** — `agents/tools/auto.py:115-128`. Today bound by audit() in nodes; documented as confirmed-safe.
- **MOCK_S5. Reference to HITL_R3 round-8 documentation gives the pattern for any new payload class** — `agents/api/server.py:585-599`. Documented as the template.

---

## Round-15 implementation plan

**Pick: PG_R1 + PG_R2 (finish the round-14 redaction sweep) + MOCK_S1 (Field bounds on MockStartPayload) + EXT_SEC1 (client-side `sensitive.ts` deny-list).**

Why these three:
- **PG_R1 + PG_R2** completes the round-14 PT_INJ5 / WF_R3 fix. Six remaining `error=str(exc)` sites (three in `agents/api/server.py`, three in `agents/nodes/jobmatch_agent.py`) now route through `redact_exception_text`. Each is a one-line swap and the import was already promoted to a public alias.
- **MOCK_S1** mirrors HITL_R3 (round-8) on `MockStartPayload` — caps `mode_slug` ≤ 64, `company` / `role` ≤ 200, `round_type` ≤ 64. Live smoke confirmed valid input flows through, 1 MB role / empty mode_slug / oversized mode_slug all reject.
- **EXT_SEC1** ships the round-13 baseline carry-over: new `apps/extension/src/sensitive.ts` exports `SENSITIVE_FIELD_TOKENS` + `isSensitiveLabel(haystack)` mirroring the server-side list verbatim. `local-fill.ts` calls it before the regex loop so sensitive fields skip both auto-fill *and* cloud-fill, landing in a new `plan.skippedSensitive` bucket. `content.ts` now reports the real count to the popup instead of a hardcoded 0.

**Out of scope this round (will surface in future findings):**
- MOCK_S2 (`mode_slug` Literal): needs a load_mode round-trip test + enum lift; deferred.
- AUTH1-AUTH5: each is its own surface; magic-link / OAuth / logout-with-token-blacklist / password reset / CSRF token are coherent but bigger commits.
- PASTE1-PASTE5: client-side paste validation + retention policy on `resumes.raw` need a privacy policy decision.
- MOCK_S3 / MOCK_S4: more Field constraints; round-16 can finish.

---

## Shipped this round

- **PG_R1** — `agents/api/server.py:30, 134, 263, 425`. Added `from agents.harness.audit import redact_exception_text` and wrapped the three remaining sites the round-14 sweep missed (`unhandled_exception_handler`, `ask_stream.dispatch_failed`, `applications.submitted.db_write_failed`). Ruff clean; import verified to survive.
- **PG_R2** — `agents/nodes/jobmatch_agent.py:43, 445, 458, 592`. Same swap on the three `jobmatch.*` sites (`no_llm_key`, `llm_failed`, `upsert_failed`). Re-imports `redact_exception_text` from the same alias so both files share one helper.
- **MOCK_S1** — `agents/api/server.py:544-562`. `MockStartPayload` now uses `Field(min_length=1, max_length=64)` for `mode_slug`, `Field(default=None, max_length=200)` for `company` and `role`, and `Field(default=None, max_length=64)` for `round_type`. Live smoke: honest input survives; `x*100` `mode_slug`, `x*1_000_000` `role`, empty `mode_slug` all reject with 422.
- **EXT_SEC1** — `apps/extension/src/sensitive.ts` (new), `apps/extension/src/local-fill.ts:14, 27-40, 76-130`, `apps/extension/src/content.ts:82-95`. New module exports `SENSITIVE_FIELD_TOKENS` (mirrors the round-13 Python list — race / ethnicity / gender / sex / SSN / DOB-variants / visa / etc.) and `isSensitiveLabel(haystack)`. `planLocalFill` checks the haystack first and parks sensitive fields in a new `plan.skippedSensitive: DetectedField[]` bucket so they bypass both the local rule loop *and* the cloud-fill handoff. `content.ts` reports `plan.skippedSensitive.length` in the FillSummary instead of the hardcoded 0.

Build / test: `ruff check api/server.py nodes/jobmatch_agent.py` clean. Python smoke confirms `redact_exception_text` continues to scrub `<path>` / `<dsn>` / `<token>` and that `MockStartPayload` rejects all four attack vectors. extension `bun run typecheck` clean. web `bun run typecheck` + `bun run lint` exit 0. api `bun run typecheck` clean; `bun test` shows 183 passes / 0 fails / 383 expect() calls. 27 agents pytest cases pass (3 PG-required skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 16 should:
- Diff against this file's "Out of scope" list — top candidates: AUTH2 (`/forgot-password` + Redis single-use token); AUTH4 (`/logout` + Redis JWT-id blacklist); PASTE5 (NUL / control-char strip in `parsePastedText`).
- Verify rounds 1-15 fixes hold (46 markers across ~26 files).
- Re-audit areas still un-covered: `web/src/lib/store.ts` chat-history hydration race; `agents/coordinator/workflows.py` saga `finalize_node` partial-write recovery; `api/src/routes/files.ts` PDF / DOCX MIME validation depth; `web/src/components/screens/extension.tsx` "you submit, we prepare" copy review; `agents/nodes/resume_agent.py` `customize` token budget vs round-8 LLM1 retries.
- Stretch: split the round-14 / round-15 `redact_exception_text` use sites into a single `agents/harness/redact.py` module with explicit tests, closing the round-13 / round-14 "extract to shared module" carry-over once and for all.
