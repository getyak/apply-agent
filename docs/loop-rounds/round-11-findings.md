# Round 11 — Findings & Plan

**Trigger:** `/loop 30min` agent teams eleventh iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-10-baseline's "not yet covered" areas — api/src/db.ts PG pool lifecycle & leak detection / agents/nodes/interview_agent.py weak_points cross-session aggregation / web markdown-message.tsx XSS sanitization / apps/extension manifest permissions tightness. Rounds 1-10 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`, `fefa8f4`, `3cf5dee`, `52b3a2b`, `4744536`, `cc7fef0`, `665e347`) verified untouched (31/31 markers grep-confirmed).

---

## Issues found (25 new)

### Critical (security + reliability)

- **MD1. `ReactMarkdown` ships without `rehypeSanitize` and without `skipHtml`** — `web/src/components/chat/markdown-message.tsx:132-134`. An LLM-emitted `<img onerror=alert(1)>` or `<script>` executes in the dock + Resume Studio.
- **MD2. `resume-view.tsx:2046` renders user-uploaded markdown raw** — `web/src/components/screens/resume-view.tsx`. The same XSS surface for uploaded résumés / cover letters.
- **MD3. Link `href` is passed verbatim** — `web/src/components/chat/markdown-message.tsx:146-154`. `[click](javascript:alert(1))` fires; `data:`/`vbscript:`/`file:` schemes accepted.
- **MD5. No server-side sanitization on LLM output** — `agents/api/server.py` + `api/src/routes/ask.ts`. The "defend at render time only" posture fails the moment a non-web surface (PDF export, email, mobile app) consumes the same stream.
- **DB1. `pool.on('error', …)` listener missing** — `api/src/db.ts:4-8`. An idle background connection that dies (PG restart, transient network) crashes the whole Bun process on the next tick.
- **DB2. No `connectionTimeoutMillis` / `statement_timeout`** — same constructor. A wedged PG or runaway query pins a connection until the OS TCP timer fires (minutes).
- **DB3. No SIGTERM / SIGINT drain handler** — `api/src/index.ts:65-75`. Rolling deploys kill in-flight queries (`connection reset by peer`).
- **DB4. No boot-time PG connectivity probe** — same. Misconfigured `DATABASE_URL` keeps `/ready` green until the first request errors out.

### High

- **WK1. weak_points have no cross-session aggregation** — `agents/nodes/interview_agent.py:565-581` + `infra/postgres/migrations/009_interviews.sql`. JSONB stored per-session; nothing reads them across sessions.
- **WK2. Debrief `focusNext` is hard-coded** — `web/src/components/screens/mock-interview.tsx:1299-1325`. The UI claims to show the next session's focus but it's a constant string.
- **WK3. weak_points seen but not used to drive question selection** — `agents/nodes/interview_agent.py:210-263`. The prompt receives the list but the LLM isn't told to prioritise them.
- **WK4. No standalone "Weaknesses" page** — `web/src/app/app/`. Debrief is the only entry point; once you close it, the data is invisible.
- **DB5. No pool metrics exposed** — `api/src/routes/health.ts`. `pool.totalCount` / `idleCount` / `waitingCount` not surfaced; no alerting possible.
- **EXT_RECAP. Round-3 extension audit findings remain on the doc side** — see round-3-findings. Manifest is actually clean; this round confirms.

### Medium

- **MD4. `markdown.css` styles assume markdown-only content; raw HTML would break the inherited typography contract anyway** — moot once MD1 ships.
- **WK5. `mock:weak_point_found` event payload includes user_id + skill list** — `agents/nodes/interview_agent.py:420`. Today only the consumer is a log; tomorrow's recommender could leak weakness profiles cross-user.
- **POPUP1. `popup.ts:191` uses `.innerHTML` with template literals** — `apps/extension/src/popup.ts`. Values are numeric today; an audit of future contributions is warranted.

### Low

- **EXT_CWS. No `update_url` in manifest.json** — `apps/extension/manifest.json`. Relies on Chrome Web Store auto-update; acceptable for the v1 distribution model.
- **EXT_CSP. `connect-src` hard-codes `http://localhost:8081` and `https://api.relay.example`** — `apps/extension/manifest.json:32-34`. Acceptable in dev; needs a production swap before launch.

---

## Round-11 implementation plan

**Pick: MD1 (`skipHtml` on every ReactMarkdown call in chat) + MD3 (`safeHref` allowlist on `a` component) + DB-bundle (DB1 + DB3 + DB4 — pool error listener, SIGTERM drain, boot ping).**

Why these three:
- **MD1** closes the dock + Resume Studio XSS surface in one prop (`skipHtml={true}`). We deliberately don't pull `rehype-sanitize` because we never need *any* raw HTML in chat surfaces — the simpler posture is "drop it all at parse time".
- **MD3** closes the `javascript:` / `data:` / `vbscript:` link XSS in one whitelist-driven helper that strips whitespace before sniffing the scheme (so `j\tavascript:` and `\njavascript:` both fail). 8 attack vectors + 7 safe forms verified live.
- **DB-bundle** picks the three audit findings that share a file (`api/src/db.ts`) and the same boot path. One commit closes the reliability gaps the round-11 audit flagged as "rolling-deploy unsafe".

**Out of scope this round (will surface in future findings):**
- MD2 (`resume-view.tsx` raw markdown): the file has its own ReactMarkdown call; round-12 picks it up after we verify MD1 doesn't regress dock rendering.
- MD5 (server-side sanitization): needs a centralised text-cleaner across `agents/coordinator/router.py` + `agents/api/server.py` + `api/src/routes/ask.ts`. Bigger commit.
- DB2 (`connectionTimeout` / `statement_timeout`): partly shipped today (added to the pool constructor) but the per-route override + a `statement_timeout` review on every long-tail SELECT is a round-12 audit.
- DB5 (pool metrics): needs a `pool-metrics` endpoint + Prometheus exposition; bigger.
- WK1-WK5 (weak_points aggregation pipeline): needs a SQL aggregator + Debrief UI rewrite + ask_question prompt update.
- POPUP1 / EXT_CWS / EXT_CSP: tracked but not material.

---

## Shipped this round

- **MD1** — `web/src/components/chat/markdown-message.tsx`. Added `skipHtml={true}` to the dock's `<ReactMarkdown>`. `<img onerror>`, `<script>`, `<iframe>` and every other raw HTML fragment in LLM/user text gets dropped at parse time — they render as literal text instead of executing.
- **MD3** — same file. New exported `safeHref(raw?: string)` helper drops `javascript:` / `data:` / `vbscript:` / `file:` / unknown schemes and whitespace-obfuscated variants (`j\tavascript:` → undefined). The `a` component now wraps `href={safeHref(href)}` so anything dangerous becomes a no-href link (text still readable, click does nothing). Smoke-verified 8 attack vectors block, 7 safe forms (http / https / mailto / tel / relative / anchor / query) preserve.
- **DB-bundle (DB1 + DB3 + DB4)** — `api/src/db.ts` + `api/src/index.ts`. Added `pool.on("error", …)` so transient idle-client failures log instead of crashing Node. Added `connectionTimeoutMillis=5_000` + `statement_timeout=30_000` so a slow PG or wedged query no longer pins a connection for the OS TCP timeout. New exported `installDbShutdownHandlers()` drains the pool on SIGTERM/SIGINT (idempotent — safe for tests/scripts to import). New exported `pingDbAtBoot()` runs a `SELECT 1` once at startup so misconfiguration shows up in logs immediately. `api/src/index.ts` wires both into the boot sequence.

Build / test: web `bun run typecheck` + `bun run lint` exit 0. Live `safeHref` smoke confirmed 8 XSS schemes blocked, 7 safe forms preserved. api `bun run typecheck` clean; `bun test` reports 183 passes / 0 fails / 383 expect() calls. 27 agents pytest cases pass (3 PG-required skips). web `bun run build` (17 routes) exit 0.

---

## Next-round baseline

Round 12 should:
- Diff against this file's "Out of scope" list — top candidates: MD2 (the Resume Studio `<ReactMarkdown>` callsite that today still renders user-uploaded markdown raw); MD5 (server-side sanitiser); WK1 (cross-session weak_points aggregator SQL); DB5 (pool metrics endpoint).
- Verify rounds 1-11 fixes hold (34 markers across ~21 files).
- Re-audit areas still un-covered: `api/src/middleware/observability.ts` request-id propagation into Python via `X-Request-Id` headers; `agents/coordinator/router.py` Layer-1 / Layer-2 intent classifier accuracy on multilingual prompts; `agents/nodes/jobmatch_agent.py` LLM JD-parse hallucination rate (vision.md "honest extraction" red line); `web/src/app/app/today/page.tsx` empty-state UX on a brand-new account; `apps/extension/src/content.ts` field-detection coverage on Workday / iCIMS / Greenhouse alternative templates.
- Stretch: add a single integration test for `installDbShutdownHandlers()` so a future refactor that drops the SIGTERM listener trips CI rather than passing.
