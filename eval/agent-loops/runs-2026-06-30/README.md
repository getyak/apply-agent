# Agent Loop Runs · 2026-06-30

First end-to-end demonstration of the self-improving agent loop designed in
[`test.md`](../../../test.md). Six goals across five Relay agent capabilities
were exercised with the same Generator → Evaluator → Refiner → Verifier
pipeline; this directory archives each run's slim score-card (logs + final
result, transient agent transcripts dropped).

## Result matrix

| # | Goal                                             | Status              | Best score | Verify     | Notable finding |
|---|--------------------------------------------------|---------------------|-----------:|------------|-----------------|
| 1 | resume.customize (v1 · 3-judge soft verify)      | PASS                | 99/100     | 3-0        | Linear refine R0=94 → R1=99 works. |
| 2 | resume.customize.v2 (4-judge strict + red_team)  | REFUTED_BY_VERIFY   | 90/100     | 2-2        | red_team caught semantic inflation: "incident response leader" not supported by base "led on-call rotation". |
| 3 | interview.translate_feedback (pressure_drill)    | REFUTED_BY_VERIFY   | 93/100     | mixed      | correctness judge found 5 specific fabrications in suggested_rephrase ("wrote a brief", "two weeks earlier", etc.). |
| 4 | jobmatch.parse_jd (Greenhouse Stripe SRE)        | REFUTED_BY_VERIFY†  | 97/100     | 0-4 (infra)| Eval phase worked (96→97); all 4 verify judges rate-limited. Honest verdict: scoring system OK, infra failed. |
| 5 | appprep.cover_letter (warm tone · Linear)        | FAIL_ALL_TERMINAL   | n/a        | n/a        | All 3 generators rate-limited. Infrastructure failure, not agent failure. |
| 6 | error_envelope.db_unavailable (cross-layer)      | REFUTED_BY_VERIFY   | **100**/100| 3-1        | **Highest signal run.** Six rubric axes scored full marks; one verifier independently executed `traceCodeFromTraceId` and found the agent's `R-AGJV` should have been `R-YNWZ`. |

† Verify quorum 0-4 caused by Anthropic API rate-limiting (`Server is temporarily limiting requests`), not by judge dissent.

## What this exercise validated about the design in `test.md`

1. **Self-fix closes the loop** (goal 1). Deductions from round 0 fed back into the agent as a structured refine brief produced a measurable score lift (94 → 99) without human authorship.
2. **Tournament outperforms linear refine at the boundary** (goal 6). Three diverse generation strategies in parallel + surgical polish reached the only true 100 of the run; linear single-strategy refine on the same task plateaued at 99.
3. **Strict verify catches what evaluators miss** (goals 2, 3, 6). Especially goal 6: full panel + polish scored 100/100 across six axes, yet the trace-integrity verifier independently re-derived the `traceCode` algorithm and refuted the artifact. This is the design's most important property — verify is the only thing standing between "passes rubric" and "actually correct".
4. **Honest grounding has a real ceiling at ~90–95** (goals 2, 3). Anywhere the agent must rephrase content with a vision.md no-fabrication constraint, the ceiling is not 100. Pure-extraction (goal 4) and pure-schema (goal 6) goals can hit it.
5. **Infrastructure is the real bottleneck**, not LLM capability. Three of six runs ate rate-limit failures; the design's resilience (null-safe must_pass, default-refute verifiers, resume-from-cache) kept the runs interpretable rather than crashing.

## File format

Each `goalN-*.json` keeps:

- `task_id` — Workflow task id, for cross-referencing the live transcript directory.
- `summary` — one-line description supplied by `meta.description` in the script.
- `agent_count`, `duration_ms` — cost / wall-clock observability.
- `logs` — the narrator's `log()` stream (phase boundaries, per-axis scores, trajectory).
- `failures` — partial-failure records (rate-limits, schema retry-cap exhaustion).
- `result` — the final score-card returned by the workflow script. Shape mirrors
  [`test.md` §7](../../../test.md#7-报告与-score-card):
  `{ goal_id, status, final_score, winning_strategy, trajectory, panel_results, final_breakdown, verify, final_artifact }`.

## Reproducing a single goal

These inline workflow scripts were exploratory. The canonical artifact going
forward is the per-goal YAML test.md prescribes for the W1+ landing
(`eval/agent-loops/<agent>/<goal>.yaml`). To reproduce one of these runs,
lift its rubric and strategy briefs out of the corresponding `result.json`
into a YAML file and feed it to the runner defined in test.md §9.
