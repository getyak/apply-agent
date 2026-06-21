# Round 13 — Findings & Plan

**Trigger:** `/loop 30min` agent teams thirteenth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-12-baseline's "not yet covered" areas — `web/src/components/screens/builder.tsx` text input sanitization & persistence / `agents/coordinator/persist_turn` SQL injection surface / `api/src/redis.ts` connection lifecycle / `apps/extension/src/cloud-fill.ts` per-field deny-list. Rounds 1-12 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`, `cc7fef0`, `665e347`, `bad2c6e`, `6484ea4`) verified untouched (37/37 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (reliability + privacy + state-loss)

- **REDIS1. `ioredis` client has no `retryStrategy` / `maxRetriesPerRequest`** — `api/src/redis.ts:4`. Transient outage = immediate request failures.
- **REDIS3. No `error` listener, no SIGTERM/SIGINT `redis.quit()`, no boot ping** — same file. Idle-client failures crash Node; rolling deploys yank sockets mid-request; misconfigured URL stays green until first error.
- **REDIS4. `installRedisShutdownHandlers` not symmetric with round-11 PG shutdown** — `api/src/index.ts:68-69`. Round-11 closed PG; redis was left exposed.
- **BUILD4. Builder has no `beforeunload` guard** — `web/src/components/screens/builder.tsx`. User can lose multi-step progress (`builderStep`, `builderTarget`, `builderChoices`) on tab close.
- **EXT_SEC1. Local-fill (`apps/extension/src/local-fill.ts`) has zero sensitive-field detection** — single point of failure on the backend.
- **EXT_SEC4. SENSITIVE_TOKENS denylist missing DOB / sex / DOB variants / marital status / orientation / religion / driver's license / TIN / national insurance** — `agents/nodes/appprep_agent.py:181-193`. Workday EEO labels slip through.
- **EXT_SEC5. `/extension/map-fields` trusts the client-supplied label** — `agents/api/server.py:509-514`. A renamed `<input name="ssn">` with `<label>First name</label>` reaches the LLM.

### High

- **REDIS2. Fail-open inconsistent across routes** — `cache.ts:30-38` and `rate-limit.ts:114-123` fail open; `jobs.ts:84-103` propagates errors as 500. UX diverges per-route.
- **PT_INJ1. `thread_id` lacks format validation** — `router.py:631`. Up to 200 chars accepted; DoS vector but not SQL injection (psycopg parameterised).
- **PT_INJ5. `log.error("router.persist_turn_failed", error=str(exc))`** — `router.py:732`. Exception text can leak duplicate-key violation details with PII.
- **BUILD3. Validation asymmetry — builder skips frontend required-field checks** — `builder.tsx:163`. Silent MVP failure; settings has detailed inline errors.
- **EXT_SEC2. Client (label) vs server (label) field-detection strategies don't agree** — `local-fill.ts:78-80` vs `appprep_agent.py:215-216`. `name="ssn"` survives empty-label fields.
- **EXT_SEC3. No "I authorise uploading this field" UX** — `popup.ts:139-167`. All-or-nothing posture.

### Medium

- **BUILD2. Free-text rendered via React text children — auto-escaped, safe by default** — `builder.tsx:220-222`. Documented as confirmed-safe.
- **BUILD5. `parsedResume` updates are non-versioned in builder** — `builder.tsx`. No version lock; today builder doesn't save, so no race, but future write-path lacks an obvious guard.
- **PT_INJ2-4. `user_message` / `assistant_text` / `metadata` are properly parameterised** — `router.py:720-729`. Confirmed-safe; documented as audit hits.

### Low

- **JOBS_FIX. `JOBS` hardcoded fixture is still imported in store.ts** — `web/src/lib/store.ts`. Dev shortcut; no production user-facing risk today.

---

## Round-13 implementation plan

**Pick: REDIS bundle (REDIS1+REDIS3+REDIS4) + EXT_SEC4 (expand SENSITIVE_TOKENS) + BUILD4 (`beforeunload` on builder).**

Why these three:
- **REDIS bundle** mirrors the round-11 db.ts work exactly: `maxRetriesPerRequest=3` + `retryStrategy` for transient backoff, `redis.on("error", …)` to keep an idle-client failure from crashing Node, `installRedisShutdownHandlers()` for SIGTERM/SIGINT `redis.quit()`, and `pingRedisAtBoot()` so a misconfigured URL leaves a loud breadcrumb instead of silently turning every cache/rate-limit lookup into a runtime error. `api/src/index.ts` wires both into the boot sequence next to the PG handlers.
- **EXT_SEC4** ships the new denylist tokens the round-13 audit listed: `gender identity`, `sex`, `social security number`, `national insurance`, `tax id`, `tin`, all four DOB variants (`date of birth`, `dob`, `birth date`, `birthdate`), `marital status`, `sexual orientation`, `religion`, `driver's license`, `drivers license`, `license number`. Comment block documents the matching policy and notes the per-entry round-13 origin so a future audit can tell which generation each came from.
- **BUILD4** mirrors the round-5 settings S3 guard: `useEffect` installs a `beforeunload` listener while builder state is dirty (`builderStep > 0` or any chip picked); browser-native confirm dialog protects multi-step progress. No persistence change — just the "are you sure?" prompt.

**Out of scope this round (will surface in future findings):**
- REDIS2 (cache.ts / rate-limit.ts fail-open vs jobs.ts fail-closed): needs a per-route policy decision.
- PT_INJ1 (`thread_id` format guard): needs a UUID regex + a 401-vs-400 decision.
- PT_INJ5 (exception text redaction in router.persist_turn_failed): we already redact in `audit.py` (round-10); apply the same helper here.
- EXT_SEC1 (client-side denylist mirror): needs `apps/extension/src/sensitive.ts` + content.ts wiring.
- EXT_SEC2 (label-vs-name fallback alignment): needs a content-script API change.
- EXT_SEC3 (per-field user authorisation): needs popup UX redesign.
- EXT_SEC5 (server-side label re-derive from HTML): needs structural changes to `/extension/map-fields`.
- BUILD3 / BUILD5 (validation symmetry, builder persistence): bigger refactor.
- JOBS_FIX: dev cleanup, defer.

---

## Shipped this round

- **REDIS bundle (REDIS1+REDIS3+REDIS4)** — `api/src/redis.ts` + `api/src/index.ts`. The client constructor now passes `maxRetriesPerRequest=3` and a `retryStrategy: (times) => Math.min(times * 200, 2_000)`. A module-level `redis.on("error", …)` catches idle-socket failures so Node doesn't crash on the next tick. New exported `installRedisShutdownHandlers()` and `pingRedisAtBoot()` mirror the round-11 PG helpers; `index.ts` wires both into the boot sequence right after the PG hooks.
- **EXT_SEC4** — `agents/nodes/appprep_agent.py:181-193`. SENSITIVE_TOKENS widened with 16 new entries — every one of the Workday / iCIMS / Greenhouse aliases the round-13 audit flagged, with a `# round-13` comment per entry so the next audit can read the provenance. The match is still case-insensitive substring against `label.lower()` (see `generate_form_answers`), so the broader denylist captures both stand-alone and embedded references.
- **BUILD4** — `web/src/components/screens/builder.tsx:1-7, 24-44`. Added `useEffect` import; new effect computes `isBuilderDirty = builderStep > 0 || builderChoices.length > 0` and installs a `beforeunload` listener while dirty. Browser native confirm dialog protects builder progress; the listener is a strict no-op when the builder is in its clean initial state, so users who briefly open and close the screen don't get pestered.

Build / test: `ruff check appprep_agent.py` clean. web `bun run typecheck` + `bun run lint` exit 0. api `bun run typecheck` clean; `bun test` shows 183 passes / 0 fails / 383 expect() calls. 27 agents pytest cases pass (3 PG-required skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 14 should:
- Diff against this file's "Out of scope" list — top candidates: PT_INJ5 (reuse `_redact_exception_text` from round-10 in `router.persist_turn_failed`); REDIS2 (decide per-route fail-open vs fail-closed policy); EXT_SEC1 (client-side `sensitive.ts` denylist mirror).
- Verify rounds 1-13 fixes hold (40 markers across ~24 files).
- Re-audit areas still un-covered: `agents/coordinator/workflows.py` `_jobs_node` cross-saga retry semantics; `web/src/components/views/tracker-view.tsx` keyboard navigation; `api/src/middleware/security.ts` Content-Security-Policy header completeness; `agents/nodes/interview_agent.py` mode-switch state preservation when interrupting; `web/src/app/auth/callback/page.tsx` (if it exists) magic-link error UX.
- Stretch: PT_INJ5 is a literal copy-paste of round-10's `_redact_exception_text` into `agents/coordinator/router.py`'s persist_turn exception path. Round-14 should also extract the helper into `agents/harness/redact.py` so audit.py and router.py share one implementation — closes the round-10 "stretch: extract the round-7 + round-9 SSRF guard to agents/harness/security.py" carry-over.
