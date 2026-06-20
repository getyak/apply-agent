# Round 3 — Findings & Plan

**Trigger:** `/loop 30min` agent teams third iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-2-baseline's "not yet covered" areas — Auth+Settings / Mobile breakpoints / SSE event order / Resume Studio change-log under tailored variants. Round-1 (`d6719d8`) and round-2 (`d120197`) commits verified untouched (6 markers grep-confirmed).

---

## Issues found (20 new)

### Critical (privacy / availability)

- **P1. signOut() does not clear the dock store** — `web/src/lib/store.ts:1010-1030`. After logout, dock.messages, dock.recentAnchors and the persisted `vantage.dock.thread` survive. On a shared browser (kiosk / family laptop / school lab) the next user opening the dock sees the previous user's prompt history. Real privacy leak.
- **P2. SSE "streaming flag stuck true" race** — `web/src/lib/ask-stream.ts:493`. `clearOwnedStreamState` only fires when `abortController === controller`. After a user-triggered cancel (which sets abortController to null), the orphaned old stream's finally finds `abortController === null !== controller`, skips clear, and `streaming` stays true until full reload.
- **P3. Multi-tab thread collision via localStorage** — `web/src/lib/ask-vantage-store.ts:180,327`. `PERSISTED_THREAD_KEY` is one key shared across tabs; tab A's `reset()` doesn't clear localStorage, so tab B keeps writing to the same thread the server cancelled.
- **P4. MarkdownMessage re-renders O(n²) on every delta** — `web/src/components/chat/markdown-message.tsx:127-169`. >10K-token outputs render-jank at 200-500ms per delta.
- **P5. No trace_id end-to-end** — `agents/api/server.py:109-169` + `agents/harness/audit.py:1-125`. Production debugging requires manual thread_id correlation.

### High (UX / mobile)

- **M1. Main content area squashed to ~44px under 390px viewport** — `web/src/app/app/layout.tsx:206-209`. Sidebar 74px + dock 280-372px + 16px gutters leaves no room for content on a phone.
- **M2. Dock has no mobile-specific mode** — `web/src/components/ask-vantage/dock.tsx:842`. minWidth 280px hard-coded; no auto-collapse on narrow viewport.
- **M3. Tap targets < 44px (Apple HIG)** — `dock.tsx:2167-2181` iconBtnStyle = 28×28; chip ~38px; sidebar nav ~36px.
- **M4. Chip/kanban have zero touch event handlers** — `tracker-view.tsx` + `dock.tsx:1541-1560`. Only onMouseEnter/Leave; iPad swipe is dead.
- **M5. Resume Studio document + dock simultaneously on mobile is unreadable** — `dock.tsx:1198-1211` + `layout.tsx:206-210`.

### High (auth / settings)

- **A1. Email verify is missing in the register flow** — `api/src/routes/auth.ts:38-60` + `web/src/app/auth/page.tsx:112-115`. Typo'd email = silent failure on every notification thereafter.
- **A2. Rate-limit response surfaces as backend log string** — `api/src/middleware/rate-limit.ts:133-135` returns "Rate limit exceeded for auth. Try again in 47s." which the UI shows verbatim.
- **A3. Settings has no Language / Time zone / Email frequency / BYO LLM key** — `web/src/components/views/settings-view.tsx:309-502`. The market-analysis "BYO key for cost = 0" promise has no UI surface.
- **A4. Only email/password auth — no magic link, no OAuth** — `web/src/app/auth/page.tsx:109-113`.

### Medium (Resume Studio)

- **R1. Change-logs are client-side only — reload clears them** — `web/src/components/screens/resume-view.tsx:612-615`. `tailoredChangeLogs[id]` lives in zustand; no server fetch on mount.
- **R2. Change-log diff is per-bullet, not character-level** — `resume-change-log-panel.tsx:36-44, 333-410`. 280-char truncation per side hides long-bullet rewrites.
- **R3. fabrication_guard rejections never surface a *which-entity* reason in UI** — `resume-change-log-panel.tsx` + `agents/nodes/resume_agent.py:95-112`. Generic "regenerate" CTA only.
- **R4. No "Restore this version" UX** — `resume-view.tsx:672`. Caption says it's possible; no button exists.
- **R5. No multi-variant comparison** — `resume-view.tsx:229-231, 773-811`. Binary compare only (variant ↔ master), never variant ↔ variant.
- **R6. Optimistic-lock conflicts have no client-side notification** — `infra/postgres/migrations/016_*.sql` + `resume-view.tsx`. Two tabs both succeed (per-user advisory lock prevents version collision) but UI has no "your sibling tab won the race" banner.

---

## Round-3 implementation plan

**Pick: P1 (signOut clears dock state) + P2 (streaming flag orphan-stream fix) + A2 (auth rate-limit message).**

Why these three:
- **P1** is a *real* privacy bug. Shared-browser scenario isn't theoretical — kiosk and family-laptop users exist. Single-function fix in `signOut`.
- **P2** is a real availability bug — easy to reproduce by clicking "send" twice rapidly. One-line change in `clearOwnedStreamState`'s predicate.
- **A2** is the easiest of the auth findings and improves dignity: turning a backend-log error string into a human-meaningful retry hint.

**Out of scope this round (will surface in future findings):**
- P3 (multi-tab collision): needs sessionStorage migration + per-tab id design.
- P4 (markdown O(n²) re-render): needs incremental-diff or memoization layer.
- P5 (trace_id): needs server-side propagation + UI surfacing.
- M1-M5 (mobile): each needs design direction; deferring as a batch under "mobile-first refactor".
- A1 (email verify): needs email infrastructure (SES/Resend).
- A3 / A4 (Settings expansion / OAuth): needs design + new auth flows.
- R1-R6 (Resume Studio variants): needs server-backed change-log endpoint + multi-variant UX design.

---

## Shipped this round

- **P1** — `web/src/lib/store.ts`. Imported `useDock` from `./ask-vantage-store` (verified no cycle), and on `signOut()` we now call `useDock.getState().reset()` + `useDock.setState({ recentAnchors: [], threadId: null })` + `window.localStorage.removeItem("vantage.dock.thread")`. Wrapped in try/catch because signOut must never throw — it's the user's escape hatch.
- **P2** — `web/src/lib/ask-stream.ts`. Changed the guard from `abortController === controller` to `current === controller || current === null`. The orphan case (controller already cleared by cancelStream / unmount) now also clears `streaming`, closing the rapid-fire race that left the UI permanently spinning.
- **A2** — `web/src/app/auth/page.tsx`. Imported `ApiError`; in handleSubmit's catch, when `err instanceof ApiError && err.status === 429`, parse the `\d+ s` retry-after window from the backend string and display "Too many attempts. Please wait N seconds before trying again." instead of the literal backend log line.

Build / lint / typecheck: `bun run typecheck` + `bun run lint` exit 0. `bun run build` (production, 17 routes) exit 0.

---

## Next-round baseline

Round 4 should:
- Diff against this file's "Out of scope" list — top candidates: M2 (dock mobile auto-collapse, doable in ~30min via matchMedia in dock.tsx); A1 (email verify — needs infra); P3 (sessionStorage thread isolation).
- Verify round-1 / round-2 / round-3 fixes hold (9 markers grep-confirmed).
- Re-audit areas still un-covered: Today/Applications PATCH error states; resume upload edge cases (corrupt PDF / scanned image); agents-side fabrication_guard false positives; Postgres checkpointer growth and cleanup; CI smoke / e2e harness gaps.
- Stretch: actually start `make up` + browser-use + dogfood the Today→Mock→Applications happy path end-to-end. Static audit can't find every interaction bug.
