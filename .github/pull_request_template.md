<!--
Purpose: enforce a thinking checklist before merge.
When to edit: when a new class of bug repeatedly slips through (add a checkbox).
-->

## Summary

<!-- One paragraph: what changed and why. -->

## Type

- [ ] feat — new user-facing capability
- [ ] fix — bug fix
- [ ] refactor — no behavior change
- [ ] perf — performance
- [ ] docs — documentation only
- [ ] chore — tooling, deps, config
- [ ] test — tests only

**Scope**: `api` | `agents` | `web` | `extension` | `infra` | `eval` | `prompts` | `docs` | `ci`

## Critical paths touched

- [ ] `infra/postgres/migrations/**`
- [ ] `agents/harness/guards.py` (token/cost/error budgets)
- [ ] `agents/harness/permissions.py` (HITL decorators)
- [ ] `apps/extension/manifest.json`
- [ ] `docs/architecture/**`
- [ ] None of the above

> If any box above is checked, this PR **requires** a second pass before merge.

## Testing

- [ ] Unit tests added/updated
- [ ] Integration tests pass locally (`make test`)
- [ ] Manual smoke test described below

<details>
<summary>Smoke test steps</summary>

1. ...
2. ...

</details>

## LLM-call checklist (fill if this PR adds/changes a LLM call)

- [ ] Model tier chosen with justification (V4 Pro / GLM-4.7 / V4 Flash)
- [ ] Cost per call estimated (USD, p50/p95)
- [ ] Cache key defined (`{namespace}:{user}:{input_hash}`)
- [ ] Cache TTL chosen with reason
- [ ] Fallback model on 5xx / rate limit
- [ ] Token budget guard configured
- [ ] Eval added in `/eval/datasets/` (or N/A with reason)
- [ ] Prompt versioned in `agents/prompts/`

## HITL checklist (fill if this PR adds/changes an APPROVE-tier tool)

- [ ] `@requires_approval` decorator applied
- [ ] `interrupt()` payload contains all fields user needs to decide
- [ ] WebSocket notification path tested
- [ ] Resume path tested with `Command(resume=...)`
- [ ] Checkpointer thread_id strategy documented

## Migration checklist (fill if `infra/postgres/migrations/` touched)

- [ ] Migration filename follows `NNN_descriptive.(up|down).sql`
- [ ] Has matching `down.sql` (rollback)
- [ ] Tested with `make db-reset && make up`
- [ ] No destructive op without explicit comment justifying it

## Eval impact

- [ ] No prompt/model/scorer change
- [ ] Ran `make eval` — results attached or linked
- [ ] No regression on critical scorers (≥ baseline)

## Risk & rollback

- **Blast radius**: <local / single agent / cross-agent / data layer>
- **Rollback plan**: <revert + ... / migration down / cache flush>

## Related

- Closes #
- Refs #
- Langfuse trace (if applicable):
