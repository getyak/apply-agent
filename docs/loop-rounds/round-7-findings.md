# Round 7 — Findings & Plan

**Trigger:** `/loop 30min` agent teams seventh iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-6-baseline's "not yet covered" areas — Bun API rate-limit coverage + abuse defenses / résumé content rendering & markdown injection / `applications/{id}/submitted` flow under PG drop / jobmatch `parse_jd_from_url` robots+SSRF+paywall. Rounds 1-6 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`) verified untouched (17/17 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (security + reliability)

- **API_RL1. Only `/api/auth` is rate-limited. `/parse-async`, `/prepare-from-jd`, `/optimize`, `/chat`, `/ask/stream`, `/interviews`, `/files`, `/users/me` have no per-user ceiling** — `api/src/routes/`. Authenticated LLM-spam attack vector.
- **API_RL2. `x-forwarded-for` is fully trusted; no proxy whitelist** — `api/src/middleware/rate-limit.ts:42-50` + `api/src/routes/auth.ts:18-24`. Header-spoofed IP defeats the auth limiter.
- **API_RL3. Redis-down fail-open + no circuit breaker** — `rate-limit.ts:112-124`. Attacker can DoS Redis to bypass all limits.
- **API_RL5. Query `?limit=999999999` not capped** — `api/src/routes/jobs.ts:33` etc. Memory / query explosion vector.
- **SEC3. LLM-rewritten résumé fields stored & re-rendered unsanitized** — `api/src/routes/resumes.ts:414-416` + `web/src/components/screens/resume-view.tsx:2046`. Prompt-injection lands in DB and renders via ReactMarkdown (no `rehypeSanitize`).
- **SEC5. `exportResume()` JSON includes raw LLM output** — `web/src/components/screens/resume-view.tsx:309-322`. If a payload reaches downstream tools they execute the embedded HTML.
- **SUB1. `/applications/{id}/submitted` returns 200 even when PG write was swallowed** — `agents/api/server.py:399-422`. UI thinks the submit succeeded, DB never updated.
- **SUB2. PG UPDATE + Redis publish are non-transactional** — same endpoint. Inconsistency in either direction.
- **JD2. Login / paywall HTML is parsed as JD** — `agents/nodes/jobmatch_agent.py:312-324`. Garbage tailoring with no detection.
- **JD3. SSRF — user-supplied URL can target `http://localhost:5432/`, AWS metadata, RFC1918 IPs** — `agents/nodes/jobmatch_agent.py:333-343`. No host validation, scheme not allowlisted.
- **JD5. No response-size cap — a 200MB HTML response soaks RAM + token budget** — same `_http_get`.

### High (UX + content + reliability)

- **API_RL4. No HTML/markdown/shell sanitisation of user input** — `api/src/middleware/security.ts`. Free-form JSONB inputs stored as-is.
- **SEC1. `<img onerror>` in markdown-style payload renders live** — `web/src/components/screens/resume-view.tsx:2046`. ReactMarkdown denylist is incomplete.
- **SUB3. PII (`user_id`, `application_id`, company, role) is logged + republished into unauthenticated Redis** — `agents/api/server.py:414-420` + `agents/events/consumers.py:43-58`.
- **JD1. No `robots.txt` check** — `agents/nodes/jobmatch_agent.py:153-180`. vision.md §46 "no platform anti-bot evasion" is at risk for the `source=other` path.
- **JD4. Fixed UA, no per-domain rate limit, no UA pool** — `agents/nodes/jobmatch_agent.py:333-343`. Easy to get IP-banned.

### Medium

- **SEC2. `MarkdownMessage` lacks `rehypeSanitize`** — `web/src/components/chat/markdown-message.tsx:132-134`. Defensible today, fragile.
- **SUB4. No idempotency on repeat submit** — `agents/api/server.py:403-404`. Duplicate events trail consumers.
- **SUB5. No "submit-when-PG-fails" negative test (other than the one that asserts publish still runs)** — `agents/tests/test_application_submitted.py:35-71`.
- **JD-content-type. `_http_get` accepts any `Content-Type`** — `agents/nodes/jobmatch_agent.py:341-342`. PDF/image/binary as "HTML" to LLM.

### Low

- **SEC4. Change-log diff render is plain-text** — `web/src/components/screens/resume-change-log-panel.tsx:265-410`. Already safe; document as confirmed.
- **API_RL keying for /auth** — already round-3 P2 was about something else; the round-7 NAT note documents the same `x-forwarded-for` weakness.

---

## Round-7 implementation plan

**Pick: JD3 (SSRF block) + JD5 (size cap) + API_RL1 partial (rate-limit on the two costliest LLM routes).**

Why these three:
- **JD3** is a *real* SSRF gap that one user URL paste can exploit; the `_is_public_http_url` helper using stdlib `ipaddress.is_global` is small and well-understood.
- **JD5** is one helper extension in the same `_http_get` — content-length pre-check + post-hoc `len(body)` guard.
- **API_RL1 partial** — adding `rateLimit({...})` to `/api/applications/prepare-from-jd` and `/api/resumes/parse-async` is bounded and immediately reduces the LLM-spam blast radius without taking on the whole "every route" project.

**Out of scope this round (will surface in future findings):**
- API_RL1 (remaining routes): `/optimize`, `/chat`, `/ask/stream`, `/interviews`, `/files`, `/users/me`. Each needs a ceiling decision.
- API_RL2 (proxy whitelist), API_RL3 (Redis circuit-break), API_RL4 (input sanitiser), API_RL5 (limit cap): each needs a small design decision.
- SEC1-SEC5: needs a sanitiser policy + an export-payload schema decision.
- SUB1-SUB5: needs a transactional submit + idempotency-key design.
- JD1 (`robots.txt`), JD2 (login-page heuristic), JD4 (per-domain rate limit + UA pool): each is a separate hardening pass.

---

## Shipped this round

- **JD3** — `agents/nodes/jobmatch_agent.py:28-32, 333-417`. Added stdlib `ipaddress` + `socket` imports (aliased `_ipaddress` / `_socket` so future autoflake passes can't strip them as unused-at-module-level). New `_is_public_http_url(url) → (bool, reason)` rejects non-http(s) schemes and any host that resolves to a non-`is_global` address (loopback / link-local / private RFC1918 / multicast / reserved). `_http_get` pre-flights every URL with it; smoke-tested live against `http://localhost:5432`, `http://169.254.169.254`, `http://10.0.0.5`, `file:///etc/passwd`, `https://boards.greenhouse.io/some/123` — only the Greenhouse URL passes.
- **JD5** — same `_http_get`. Added `_JD_MAX_BYTES = 10 MiB` cap. Trusts an honest `Content-Length` header to short-circuit before loading; falls through to a `len(body)` post-hoc check so missing/lying headers still trip the guard.
- **API_RL1 (partial)** — `api/src/routes/applications.ts:6, 22-37, 53` + `api/src/routes/resumes.ts:5, 30-39, 218`. Two new per-user `rateLimit` middlewares: `apps_prepare_jd` (5 req / 60s) and `resume_parse_async` (8 req / 60s). Both rely on the existing auth middleware resolving `c.get("userId")` so `defaultActorKey` keys on `user:<id>`, not `ip:<ip>` — avoids the NAT-sharing problem the round-7 audit (API_RL2) flagged.

Build / test: `ruff check agents/nodes/jobmatch_agent.py` clean. SSRF helper smoke output:
- `http://localhost:5432/` → blocked (`::1 non-public`)
- `http://169.254.169.254/` → blocked (link-local)
- `http://10.0.0.5/` → blocked (RFC1918)
- `https://boards.greenhouse.io/...` → allowed
- `file:///etc/passwd` → blocked (scheme not http/https)

22 agents pytest cases pass (15 jobmatch + 4 application submitted + 3 extension map fields). `bun run typecheck` on `api/` clean. 4 `resumes.test.ts` (migration 016 regression) cases pass. web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 8 should:
- Diff against this file's "Out of scope" list — top candidates: SEC3 (LLM output sanitiser before DB store); SUB1 (return 5xx when PG write was silently dropped); API_RL1 (the next two routes — `/optimize`, `/ask/stream`).
- Verify rounds 1-7 fixes hold (20 markers across 14 files).
- Re-audit areas still un-covered: `agents/coordinator/workflows.py` saga-step replay semantics; `agents/harness/llm.py` provider routing + retry budget; CI lint/typecheck gate completeness in `.github/workflows/`; agents `interrupt()` + `Command(resume=...)` payload schema (round-6 HITL4 carry-over).
- Stretch: scaffold a tiny `e2e/` Playwright spec walking auth → onboarding → mock setup so the next /loop can run it as a regression check — moves us off pure static audit.
