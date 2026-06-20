# Round 4 — Findings & Plan

**Trigger:** `/loop 30min` agent teams fourth iteration
**Branch:** `feat/mcp-probe-deferred-marketplace`
**Method:** 4 parallel Explore agents audited round-3-baseline's "not yet covered" areas — PATCH error states / résumé upload edge cases / CI smoke + e2e gaps / fabrication_guard false positives. Round-1 (`d6719d8`), round-2 (`d120197`), round-3 (`2b3a5c7`) commits verified untouched (9/9 markers grep-confirmed).

---

## Issues found (22 new)

### Critical (data corruption + silent failures)

- **K1. Kanban drop PATCH failure surfaces no UI signal** — `web/src/components/views/tracker-view.tsx:577`. `await patchApplication(...)` result is discarded; optimistic rollback puts the card back but the user sees an unexplained "snap". Server rejection of a transition is invisible.
- **K5. Kanban concurrent drops can corrupt client state** — `tracker-view.tsx:563-578` + `store.ts:934-963`. `patchApplication` rolls back to its captured `before` snapshot; with two interleaved drops, each rollback overwrites the other's optimistic update, ending with state that doesn't match the server.
- **U1. Scanned PDFs are rejected with no OCR / vision fallback** — `api/src/markdown.ts:163-167`. Users with image-only résumés (camera scans, old templates) are told to "paste the text instead" with no escalation path.
- **U2. 8 MB file-size limit is server-only, no client pre-check** — `api/src/routes/files.ts:25,60-62`. User wastes upload bandwidth before learning their PDF is over budget.
- **F1. fabrication_guard is regex-only (4 patterns), zero golden-case suite** — `agents/nodes/resume_agent.py:220-267`. No NER, no semantic check; "5 engineers" → "5 direct reports" passes (digit kept) even though the unit changed. No measured FP / FN rate.

### High (mobile + i18n + CI)

- **M2_PRIOR. Dock has no mobile auto-collapse on viewport CHANGE** — `web/src/lib/ask-vantage-store.ts:349-361`. `hydrateDockFromStorage` runs once; rotating a tablet / resizing the window leaves the 372px panel chewing the main pane.
- **C1. OpenRouter+国产模型 tool-calling nightly smoke is skipped in CI** — `agents/tests/test_openrouter_tool_calling.py:39-42` `@skipif` on no key; CI uses dummy key. The biggest compatibility risk (per `agent-harness.md`) is therefore never validated.
- **C2. fabrication red-line never reaches eval gate** — `.github/workflows/eval.yml:42-117`. Promptfoo + DeepEval jobs exist but the configs don't have a "hallucination" or "fabrication" assertion mapped to the vision.md red line.
- **C3. DeepEval pytest dir referenced but missing** — `.github/workflows/eval.yml:119-143` runs `pytest tests_deepeval/` but the directory doesn't exist in the repo. Either CI silently skips or fails on the path.
- **C4. No e2e Playwright config + zero happy-path coverage** — `web/` has only hydration + route smoke (200 OK). Today → Mock → Applications has no automated walkthrough.
- **I1. fabrication_guard NER fails for non-Latin scripts** — `resume_agent.py:237-243` `.lower()` substring match. Chinese / Arabic / Cyrillic company names trigger false positives even when the tailored output is verbatim from the base.
- **I2. Translation (zh → en) by the model is structurally indistinguishable from fabrication** — `customize.v2.md:8-16` allows "rephrase" but `_NUMBER_RE` checks substring of the *raw* base; translating 五年 to "5 years" passes only if the digit also appears in the Chinese version, which it usually doesn't.
- **U3. Duplicate uploads silently overwrite the same base row** — `api/src/routes/resumes.ts:169-195`. SHA-256 checksum is stored but unused for dedup; users get no "you already uploaded this" feedback.

### Medium (drawer / 4xx-5xx / parsed-field preview)

- **E1. PATCH errors render only inside the drawer banner** — `tracker-view.tsx:448-454`. Failures from outside the drawer (kanban drag, today queue actions) have no surface at all.
- **E2. 4xx vs 5xx not distinguished in UI** — `web/src/lib/store.ts:960`. `err.message` is shown verbatim; user can't tell "your input is wrong" from "server crashed".
- **E3. Offline (`ApiError.status===0`) is not specialised for kanban or today actions** — `web/src/lib/api.ts:122-134, 149-151`. Network-down drag-and-drop just looks broken.
- **U4. Parsed-résumé preview is absent in onboarding** — `web/src/components/screens/onboarding.tsx`. User has no idea which fields the LLM captured until they reach Resume Studio.
- **F2. fabrication_guard rejects "5 years" → "half a decade" as fabrication** — regex sees a missing digit. Round-trippable paraphrases mass-trigger guard.
- **F3. fabrication_guard has no override / "I confirmed this is correct" path** — `resume_agent.py:94-112`. Triple-retry then hard fallback; user can't break out.

### Low

- **L1. CI migration check uses simple SELECTs, not pgTAP** — `.github/workflows/migration-check.yml:72-81`.
- **L2. Resume size cap (30K char) silently truncates** — `agents/nodes/resume_agent.py:47-54`. Long CVs lose tail.
- **L3. No "parser captured these fields" confidence card after onboarding** — companion to U4.

---

## Round-4 implementation plan

**Pick: K1 + K5 (kanban drop failure surfacing + race recovery) + M2 (dock viewport watcher).**

Why these three:
- **K1** is a real silent-failure bug. User-visible PATCH outcome with one banner + ref-counted reload restores trust.
- **K5** is real client-side data corruption under bursty drags. The cheapest robust fix is "fire one reload after the last in-flight settle"; doesn't try to architect a transaction model in 30 min.
- **M2** was *already* the round-3 baseline's recommendation — and it's a real fix to round-3 audit's M2 (mobile dock chokes main pane on resize).

**Out of scope this round (will surface in future findings):**
- U1 (OCR fallback): needs vision model integration.
- U2 (client size pre-check): trivial but needs a moment to decide on copy + UI placement.
- C1 / C2 / C3 / C4 (CI gaps): each requires a workflow edit + verification cycle longer than 30 min.
- I1 / I2 / F1 / F2 / F3 (fabrication_guard): each needs a vision document — guard semantics, override path, multilingual NER. Risky to ship in 30 min.
- E1 / E2 / E3 (error class differentiation): doable as a round-5 batch.
- U3 / U4 / L1-L3: nice-to-haves.

---

## Shipped this round

- **K1** — `web/src/components/views/tracker-view.tsx`. Added `dropError` state + a dismissable red banner above the kanban; `onColumnDrop` now reads the `{ok,error}` result from `patchApplication` and renders the failure message.
- **K5** — same file. Added `pendingDropsRef` (useRef counter; doesn't trigger re-renders). The drop handler increments on entry, decrements in finally, and when the counter hits zero issues a single `loadApplications()` to re-sync from server truth — eliminating the stale-snapshot-rollback race.
- **M2** — `web/src/lib/ask-vantage-store.ts` + `web/src/app/app/layout.tsx`. New export `installDockViewportWatcher` subscribes to `matchMedia("(max-width: 1023px)")`; narrow → force `state: "closed"` (no persist), wide → restore the localStorage preference when the dock is in the auto-forced closed state. Layout mounts it once and returns the teardown from useEffect.

Build / lint / typecheck: `bun run typecheck` + `bun run lint` exit 0. `bun run build` (production, 17 routes) exit 0.

---

## Next-round baseline

Round 5 should:
- Diff against this file's "Out of scope" list — top candidates: U2 (client-side file-size pre-check, ~10 lines); E2/E3 (4xx-vs-5xx surfacing in store.ts); C3 (decide: kill the missing `tests_deepeval/` path or scaffold it).
- Verify rounds 1-4 fixes hold (12 markers across 9 files).
- Re-audit areas still un-covered: agents api/server.py error envelopes; Resume Studio compare-mode keyboard nav; settings page form validation; the extension-side cloud-fill latency / fallback chain.
- Stretch: actually run `make up` + browser-use + screenshot the happy path. Static audits can't see hover/focus/touch.
