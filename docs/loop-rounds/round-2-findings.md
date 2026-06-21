# Round 2 — Findings & Plan

**Trigger:** `/loop 30min` agent teams second iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-1-baseline's "not yet covered" areas — Trends / Onboarding / Mock live / Extension entry. Round-1 commit (`d6719d8`) verified untouched.

---

## Issues found (22 new)

### Critical

- **N-C1. Trends is "planned, not delivered" end-to-end** — `agents/coordinator/router.py:283` returns `not_implemented_yet`; `agents/events/consumers.py:49-59` is log-only ("Phase 1: log only").
- **N-C2. Trends ETL = seed data masquerading as market truth** — `infra/postgres/migrations/005_jobs.sql` + `scripts/seed.sql`. No Greenhouse/Lever/Ashby pipeline.
- **N-C3. `/api/trends/personalized` insight string never reaches UI** — `api/src/routes/trends.ts:88-90` generates "Learning ${skill} could unlock…"; `web/src/lib/store.ts:301-306, 960-967` never consumes the field.
- **N-C4. HITL `interrupt()` has zero frontend** — `agents/harness/permissions.py:23-59` + `agents/tools/approve.py:14-30` mark approve, but `web/` has no WebSocket listener, no approve/reject UI; user gets stuck silently.

### High

- **N-H1. Dock greeting is context-free** — `web/src/components/ask-vantage/dock.tsx:1428`. "Good morning, X" plays even while async résumé parse is mid-flight; user gets no confirmation that upload was received.
- **N-H2. Mock live sidebar collapse not wired** — `web/src/app/app/layout.tsx:75` only collapses dock; `web/src/components/layout/sidebar.tsx` ignores `hintedCollapse`. Immersive promise half-broken (vantage-ui-mapping.md §3.6 requires *both*).
- **N-H3. Mock has no "skip / retry / I'm stuck" affordance** — `web/src/components/screens/mock-interview.tsx:821-824, 389-403`. Single X button discards everything.
- **N-H4. Mock weak_points are saved to PG but never re-surfaced** — `agents/nodes/interview_agent.py:357-426` writes; no frontend reads. The "this is my recurring weakness" feedback loop is broken.
- **N-H5. Mock translate_feedback is a single blocking call (no streaming)** — `agents/nodes/interview_agent.py:277-330`. 1-3s blank screen between answer and feedback.
- **N-H6. Web app has no entry point to the extension** — `apps/extension/manifest.json` exists; `web/` has no install CTA, no download link, no deep-link.
- **N-H7. Tailored résumé is server-only, never mirrored to `chrome.storage.local`** — `apps/extension/src/profile.ts:52-69` only stores base profile. Offline = no tailored résumé.
- **N-H8. AppPrep `fallback:true` cover letter is invisible to UI** — already in round-1 H3 but reconfirmed by extension-audit angle.

### Medium

- **N-M1. Onboarding is forced — no "explore without résumé"** — `web/src/app/app/layout.tsx:139-146`. Returning users without résumé fall through; new users can't preview the product.
- **N-M2. Async parse timeout message ambiguous** — `web/src/lib/store.ts:625`. "Try re-uploading later" hides that an intermediate Markdown was saved.
- **N-M3. Spotlight tour fragile on mobile** — `web/src/components/onboarding-tour.tsx:63-65, 78-89`. `getBoundingClientRect()` math assumes desktop, no `[data-tour]` fallback for collapsed dock.
- **N-M4. Mock 3-perspective feedback is vertical-stacked, not side-by-side** — `mock-interview.tsx:1035-1095`. User must scroll back to compare.
- **N-M5. Extension only covers 3 ATS hosts (gh/lever/ashby)** — `apps/extension/manifest.json:1-35`. Workday/iCIMS/ADP cliff with no graceful fallback message.
- **N-M6. Trends has no drill-down screen** — `web/src/components/views/today-view.tsx:254-258`. Stat card is dead-end.
- **N-M7. Trends has no fabrication-guard on user skills before computing gap** — `api/src/routes/trends.ts:46-60`. If user's résumé has hallucinated skills, gap math feeds garbage.

### Low

- **N-L1. Method B+ (Playwright MCP Chrome Extension) is doc-only** — `docs/architecture/client-side-delivery.md` describes; zero code.
- **N-L2. Greeting `firstName` resolves but ignores `parseJobStatus` even after parse completes (no congratulatory beat)** — minor UX nicety.
- **N-L3. AppPrep prompt is English-only** — affects bilingual users.

---

## Round-2 implementation plan

**Pick: N-H1 (dock greeting context) + N-H2 (sidebar mock-live collapse) + N-H6 reduced scope (applications page client-side delivery info card).**

Why these three:
- **N-H1** is a one-shot prop-threading from `useVantage.parseJobStatus` to `Greeting` component. ~15 lines.
- **N-H2** is one variable rename + one new store subscription. The dock-↔-sidebar contract already exists via `hintedCollapse`; sidebar just needed to listen.
- **N-H6 (reduced)**: full extension install CTA needs CWS URL + design; instead ship a dismissable info card on `/app/applications` that explains the client-side delivery contract ("you submit, we prepare"). This is the educational gap the audit identified, even if the actual install link comes later.

**Out of scope this round (will surface in round-N findings):**
- N-C1 / N-C2 (Trends backend): needs ETL infra, multi-day work.
- N-C3 (Trends insight wiring): requires fabrication guard first (vision.md compliance) → N-M7 must land first.
- N-C4 (HITL frontend): needs WebSocket + decision UI; non-trivial.
- N-H3 / N-H5 (Mock live UX): needs UI design for skip/retry + LLM streaming refactor.
- N-H4 (weak_points history): needs a new page or "Weaknesses" panel.

---

## Shipped this round

- **N-H1** — `web/src/components/ask-vantage/dock.tsx`. Subscribed dock to `useVantage.parseJobStatus`, threaded it through the `Greeting` subcomponent, and branched the paragraph copy: running → "Reading your résumé in the background"; failed → "That parse didn't finish — re-upload"; idle/done → original copy preserved.
- **N-H2** — `web/src/components/layout/sidebar.tsx`. Imported `useDock`, renamed local state to `userCollapsed` (user's saved preference, owned by the toggle button) and derived `collapsed = userCollapsed || hintedCollapse` so Mock live now collapses the sidebar to 74px alongside the dock launcher. Persistence behavior unchanged — `hintedCollapse=false` after the mock screen unmounts (layout.tsx safety net) restores the user's saved pref automatically.
- **N-H6 (reduced)** — `web/src/components/views/tracker-view.tsx`. Added a dismissable "You submit · we prepare" card explaining the client-side delivery contract (Vantage tailors + drafts + pre-fills; user clicks Submit in their own browser). Persists dismissal to `localStorage` key `vantage.applications.deliveryInfoSeen`; first visit always shown.

Build / lint / typecheck: `bun run typecheck` + `bun run lint` exit 0. `bun run build` (production) exit 0 with all 17 routes rendering.

---

## Next-round baseline

Round 3 should:
- Diff against this file's "Out of scope" list — pick from N-C3 / N-C4 / N-H3 / N-H4 / N-H7 / N-M7 etc.
- Verify round-1 (C1/H1/H2) and round-2 (N-H1/N-H2/N-H6) fixes hold.
- Re-audit areas not yet covered: Resume Studio change-log behavior under tailored-variants; ask-vantage SSE event ordering; chrome.storage.local sync; postgres checkpointer health.
- Consider hitting a real area gap: Auth/login UX, settings page, mobile breakpoints (round-1 audit on another project flagged "mobile basically unusable").
