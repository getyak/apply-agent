# Round 1 — Findings & Plan

**Trigger:** `/loop 30min` agent teams deep-experience round
**Started:** 2026-06-21, branch `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited Today queue / Resume Studio dock / Applications kanban / Mock + tech debt — pure static review of the 5 most recent feature commits (42c74e0 → 12cf127).

---

## Issues found (16)

### Critical (ship-blocking on dogfood)

- **C1. Dock messages never reset across surfaces** — `web/src/lib/ask-vantage-store.ts:127, 298-307`. Returning to Resume Studio after visiting Mock shows a hybrid resume_studio + ask_vantage chat. Violates §2.6 "TALKING ABOUT THIS RÉSUMÉ" subtitle promise — subtitle changes, messages don't.
- **C2. Today queue empty state has no CTA** — `web/src/components/views/today-view.tsx:272-276`. Passive text only ("applications, interviews and learn signals will surface here automatically") with no guidance. First-time users get a dead screen.
- **C3. `next_action` reconcile is manual-only** — `api/src/scripts/reconcile-next-action.ts:9-18` runs as one-shot `bun run …`, no cron. Today queue serves a snapshot that drifts the moment any application status changes.

### High

- **H1. Only 1 of 4 Resume Studio chips has anti-fabrication prompt** — `web/src/components/ask-vantage/dock.tsx:76-97`. Only "Tailor this résumé to a JD" carries "without inventing experience"; the other three (weakest spots / map next moves / surface roles) can hallucinate.
- **H2. Queue items have no "why-this-card"** — `api/src/routes/today.ts:32-47`. `priority` (0–100) drives sort but never surfaces. User can't tell why item #1 is #1.
- **H3. Applications kanban hides failure modes** — `web/src/components/tracker-view.tsx:448-454` + appprep_agent `fallback:true` flag. Cards show "Submitted" while underlying cover letter is a fallback template; no badge, no decay.
- **H4. Dock chip "Find roles I should look at today" doesn't write to queue** — `web/src/components/ask-vantage/dock.tsx:58` + `today-view.tsx:162-170`. Scout result lives only in dock chat, no path back to Today queue.
- **H5. Empty-résumé chips disabled but text unchanged** — `dock.tsx:1410-1415`. "Tailor this résumé to a JD" still rendered (just opacity 0.6) when user has no résumé yet — mismatches "NO RÉSUMÉ YET" banner.

### Medium

- **M1. Kanban DnD lacks affordances** — `tracker-view.tsx:220-269`. Native HTML5 only, no ghost / no drop-zone cue.
- **M2. "Draft" + "review" collapse into one "Applied" column with identical styling** — `tracker-view.tsx:32-42`. Unsent and sent applications look the same.
- **M3. No "Prepare to submit" affordance on kanban** — `tracker-view.tsx`. User must go to Today queue to start submission; kanban is tracking-only.
- **M4. `next_action_due` exists in schema but is never rendered** — `tracker-view.tsx:117-142`.
- **M5. Resume change-log is in-page scroll, not co-surface with queue** — `resume-view.tsx:585`. maxHeight:480px, easy to miss.

### Low

- **L1. `_rating_feedback` is a stub** — `agents/nodes/interview_agent.py:333-340`. rating_1to5 mode returns "(rating mode — see ai_rating column)" with no real feedback.
- **L2. `find_jobs` dispatch returns "not_implemented_yet"** — `agents/coordinator/router.py:254`. Layer-1 classifier hits the intent but the handler is a stub.
- **L3. `translate_feedback.v1.md` is English-only** — no zh-cn variant, despite the rest of the product going zh-first.

---

## Round-1 implementation plan

ICE-ranked, 30-minute budget. Pick the highest-impact / lowest-effort items that ship a real diff.

**Pick: C1 (dock thread isolation) + H1 (anti-fabrication on the other 3 chips) + H2 (why-this-card priority surfacing).**

Why these three:
- **C1** is a UX correctness bug, not a feature — bounded edit in `ask-vantage-store.ts` + a single useEffect in `dock.tsx`.
- **H1** is a vision.md red-line gap (resume must not fabricate). Pure prompt-string edits, ~20 lines.
- **H2** turns existing `priority` data into a UI signal — one component change in `today-view.tsx` + small extension to the `TodayAction` interface.

**Out of scope this round (will surface in round-N findings):**
- C2 needs design — what CTA? skip until UX direction agreed.
- C3 needs infra (cron / pg_cron / external scheduler) — too large for 30 min.
- H3 / H4 need cross-page wiring — defer.
- M / L tier — defer.

---

## Shipped this round

- **C1** — `web/src/components/ask-vantage/dock.tsx:1048-1071`. Added an `effectiveThread` memo + a `useRef`-backed prev-thread effect that calls `useDock.reset()` when the thread identity changes (entering/leaving `/app/studio/resume` or switching between résumé ids). Subtitle / chips / messages now all flip together; `recentAnchors` (lifetime ask_vantage rail) untouched.
- **H1** — `web/src/components/ask-vantage/dock.tsx:72-100`. Added the "Critique only what is actually written; do not invent…" red-line constraint to the three This-Résumé chips that previously had none (weakest spots / map next moves / surface roles). Phrasing kept uniform so prompt-eval can grep for the same substring across the group.
- **H2** — `web/src/components/views/today-view.tsx:17-39, 286-302`. Added `whyThisCard(a)` helper that maps existing `kind` + `priority` (already computed in `api/src/routes/today.ts`) to a short mono label rendered under `sub`. Pure UI surfacing; no API change.

Build / lint / typecheck: `bun run typecheck` + `bun run lint` exit 0 against the changes. (`bun run build` running in background as final check.)

---

## Next-round baseline

Next 30-min trigger should diff against this file:
- Re-audit only the items NOT in this round's pick (C2, C3, H3, H4, H5, M1-M5, L1-L3).
- Verify this round's C1/H1/H2 fixes hold (no regression).
- Add fresh issues from areas not covered: Trends screen, Onboarding flow, Mock live state, Extension entry point.
