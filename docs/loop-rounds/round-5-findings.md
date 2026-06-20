# Round 5 — Findings & Plan

**Trigger:** `/loop 30min` agent teams fifth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-4-baseline's "not yet covered" areas — agents API server.py error envelopes / Resume Studio compare-mode a11y / Settings form validation + GDPR / extension cloud-fill fallback chain. Rounds 1-4 commits (`d6719d8`, `d120197`, `2b3a5c7`, `a963906`) verified untouched (12/12 markers grep-confirmed).

---

## Issues found (20 new)

### Critical (server + data)

- **API1. FastAPI has no global exception handler, no trace_id propagation** — `agents/api/server.py:65,200,235`. Errors surface as default `{"detail": "..."}` envelopes; support has no thread to grep for when a user reports an outage.
- **API2. SSE `error` frame leaks raw `str(exc)`** — `agents/api/server.py:163-165`. CostGuard's "session cost 12.4567c > 50.0c" debug string reaches the dock verbatim; internal field names and dollar math meant for logs land in the UI.
- **API3. CostGuard message has no localisation / no actionable hint** — `agents/harness/guards.py:80-81`. Technical "c" unit, no "upgrade" / "wait" / "contact support" path.
- **API4. HTTP status semantics are mixed** — `agents/api/deps.py:33` returns 400 for invalid UUID (correct); `server.py:200,235` use 422 for business failures (wrong — 422 is reserved for Pydantic schema rejection).
- **API5. `interrupt()` has no SSE frame in the dock protocol** — `interview_agent.py:483-499`. Mock & Build use a separate POST `/resume` polling path; the dock stream has no "I'm waiting on a decision" event in `ask-stream.ts:101-116`.
- **EXT1. `/api/extension/map-fields` is called by the extension but unregistered on the API server** — `apps/extension/src/cloud-fill.ts:27` POSTs there; `api/src/index.ts:40-57` doesn't mount any `/api/extension` router. Cloud-fill always 404s, then silently degrades to local rules with no popup error.
- **EXT2. extension cloud-fill sends no auth, no JWT, no cookie** — `cloud-fill.ts:24-40`. Any user (signed-out or signed-in) gets the same null response.
- **EXT3. No sensitive-field deny-list anywhere in the extension** — `local-fill.ts:43-64`. Visa status / race / SSN / salary can be auto-filled by client rules or (when implemented) by cloud LLM, with no hard guard.

### High (a11y + UX)

- **A11Y1. Version timeline nodes are `<button>`s but lack `aria-current="page"` for the active version** — `resume-view.tsx:679-739`.
- **A11Y2. Compare-mode toggle has no `aria-pressed`** — `resume-view.tsx:524`. Visible label flips ("Compare" ↔ "Exit compare"); screen readers can't tell it's a *mode* toggle.
- **A11Y3. Change-log list lacks structured SR labels** — `resume-change-log-panel.tsx:212-280`. SR reads the diff as a div soup; "Change 1 of 3" / "Before / After" not announced.
- **A11Y4. Destructive actions (version select, approve) have zero confirm dialog + no focus trap** — `resume-view.tsx:681` + `resume-change-log-panel.tsx:181`. WCAG 2.1 AA § 3.3.4.
- **A11Y5. Secondary text fails AAA contrast; 200% zoom may break the diff grid** — `resume-view.tsx:1034`, `resume-change-log-panel.tsx:344`.
- **S1. Salary 10M client / server caps are asymmetric** — `settings-view.tsx:170` vs `api/src/schemas.ts:132`. Server rejects >10M; client only checks negative.
- **S2. Save failure shows generic toast, no field highlight** — `settings-view.tsx:395-399`. Salary is the only field with inline error.
- **S3. No `beforeunload` / dirty-state warning** — `settings-view.tsx`. User can edit five fields, navigate away, and lose every change silently.
- **S4. `crowdsourceOptIn` deletion path is unclear** — `settings-view.tsx:416-425` + `legal/privacy/page.tsx:50`. Toggling off does not delete already-pooled data; copy doesn't say so.

### Medium

- **S5. Export JSON has no schema documentation; soft-delete claim isn't verified in code** — `users.ts:74-86` looks like hard-delete.
- **EXT4. AI-filled fields are visually highlighted but no UI forces review/approve** — `dom-fill.ts:100-104`; popup just shows a count.
- **EXT5. DOM fills are one-way; no undo stack, no dry-run** — `dom-fill.ts:27-59`. Hallucinated answers force user to manually edit each cell.

---

## Round-5 implementation plan

**Pick: API1 + API2 (FastAPI exception envelope + sanitized SSE error) + A11Y2 (compare-mode aria-pressed) + S3 (settings beforeunload guard).**

Why these three:
- **API1 + API2** is a single cohesive change — one `_error_envelope()` helper drives both the JSON envelope and the SSE frame, so we cover Python error hygiene in one pass.
- **A11Y2** is a 4-line a11y win that closes a WCAG 2.1 AA § 1.3.1 gap with zero risk.
- **S3** is the round-5 audit's clearest data-loss bug; `beforeunload` + a ref-based snapshot is bounded and trivial.

**Out of scope this round (will surface in future findings):**
- API3 (cost-guard copy localisation): needs i18n decision.
- API4 (HTTP status semantics): needs an audit pass + decision matrix per endpoint.
- API5 (SSE `interrupt` frame): needs frontend protocol design + dock UI for await-decision state.
- EXT1-EXT5: needs server-side `/api/extension/map-fields` implementation, auth wiring, deny-list spec, popup review UI redesign.
- A11Y1, A11Y3, A11Y4, A11Y5: each needs design direction; deferring as the round-6 a11y batch.
- S1, S2, S4, S5: doable as the round-6 settings batch.

---

## Shipped this round

- **API1 + API2** — `agents/api/server.py`. New `_error_envelope(exc, trace_id)` helper that maps `BudgetExhausted` → user-safe "budget used up" copy, `HTTPException` → preserves author-controlled detail, everything else → "Something went wrong on our side." Two `@app.exception_handler` decorators register it for `HTTPException` (preserves 4xx status) and bare `Exception` (returns 500 / 402 for BudgetExhausted). Each response includes a uuid4 `trace_id` in body **and** an `X-Trace-Id` header so support can grep logs by it. The SSE `ask_stream` error path reuses the same helper and emits the envelope as the `error` event payload, so the dock can branch on `code` instead of regexing the message.
- **A11Y2** — `web/src/components/screens/resume-view.tsx:524-547`. Added `aria-pressed={compareOn}` + `aria-label` (announces "Enter compare mode" / "Exit compare mode") + `aria-hidden="true"` on the decorative svg. Screen readers now announce the toggle as a state change, not just a button rename.
- **S3** — `web/src/components/views/settings-view.tsx`. Added `baselineRef` (snapshot of last-saved values) + `snapshotRef` (live snapshot, synced via a tiny effect). A `beforeunload` handler reads both refs at fire time and asks the browser to confirm navigation when they differ. Re-baselining on successful save flips dirty back to false so further saves work normally.

Build / lint / typecheck: web `bun run typecheck` + `bun run lint` exit 0. Python `ruff check agents/api/server.py` clean. `from agents.api import server` import smoke clean. `bun run build` (production, 17 routes) exit 0.

---

## Next-round baseline

Round 6 should:
- Diff against this file's "Out of scope" list — top candidates: A11Y1 (version-rail `aria-current`); EXT1 (`/api/extension/map-fields` server-side stub at minimum); S1 (10M client/server cap parity).
- Verify rounds 1-5 fixes hold (15 markers across 11 files).
- Re-audit areas still un-covered: agents events/consumers.py error semantics (only logs); Coordinator router dispatch error paths; harness/audit.py PG write failures; Postgres advisory-lock starvation under concurrent saves; the build_resume + Mock interrupt resume path on flaky checkpointer.
- Stretch: write a small Playwright spec that walks the Today → Mock → Applications happy path so future rounds can run it as a regression check instead of relying on static audits.
