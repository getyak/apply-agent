---
name: todo-next
description: Pick the highest-impact ready task from TODO.md and execute it end-to-end
trigger: /todo-next
---

# /todo-next

Automatically select the best next task from TODO.md and implement it. Designed for repeated invocation across sessions — each run is self-contained.

## Usage

```
/todo-next                    # auto-pick best task and implement
/todo-next AGENT-001          # implement a specific task by ID
/todo-next --dry-run          # show what would be picked without implementing
/todo-next --batch 3          # pick and implement up to N independent tasks
/todo-next --continue         # resume an in-progress (🔄) task from a prior session
/todo-next INFRA              # pick best task from a specific dimension
/todo-next P0                 # pick best P0 task
```

## Context Management Strategy

Each task is a **self-contained unit of work**. This skill is designed to survive context compaction and session boundaries:

1. **State lives in files, not in conversation** — TODO.md status markers + `.todo-log/` completion records are the source of truth
2. **Each invocation re-reads everything** — never assumes prior context exists
3. **Large tasks get chunked** — >4h tasks are split into sub-steps with checkpoints written to `.todo-log/`
4. **Minimal context loading** — only read files needed for THIS task, not the whole project

## What You Must Do When Invoked

### Phase 0: Context Recovery (always run first)

1. **Check for in-progress tasks**: Scan TODO.md for any `🔄` markers
   - If `--continue` flag: resume that task (read its log from `.todo-log/`)
   - If starting a new task but `🔄` exists: warn user and ask whether to continue it or abandon (mark `⏳`)
2. **Read recent completion log**: `ls -t .todo-log/*.md | head -3` — scan the last 3 completed task logs for context on what was recently built
3. **This is your "memory"** — these logs replace conversation history after compaction

### Phase 1: Task Selection

1. Read `TODO.md` from the project root
2. Parse all tasks (same logic as /todo skill)
3. If `$ARGUMENTS` is a specific task ID (e.g. AGENT-001), select that task
4. If `$ARGUMENTS` is a dimension or priority, filter to that scope
5. Otherwise, auto-select using this priority algorithm:

**Selection Algorithm** (score each ready task, pick highest):
```
score = priority_weight + unblock_weight + effort_efficiency

priority_weight:
  P0 = 100, P1 = 60, P2 = 30, P3 = 10

unblock_weight:
  count tasks whose Dependencies include this task ID
  × 15 points per downstream task

effort_efficiency:
  if effort <= 4h: +20 (quick win)
  if effort <= 6h: +10
  if effort > 8h: -10

critical_path_bonus:
  +30 if task is on the critical path:
  AGENT-001→002→003→004→007→008→013→018→030→031→037
  or API-005→001→015→009
  or WEB-001→002→005→006
```

6. If `--dry-run`, output the selection reasoning and stop
7. If `--batch N`, select up to N ready tasks that have NO dependency on each other

### Phase 2: Pre-Implementation

1. **Mark task as in-progress**: Edit TODO.md, append `🔄` to the task's `####` heading

2. **Create work log**: Write `.todo-log/{TASK-ID}.md` immediately:
   ```markdown
   # {TASK-ID} · {Title}
   Status: in-progress
   Started: {timestamp}
   
   ## Plan
   (filled in during planning step)
   
   ## Files
   (updated as files are created/modified)
   
   ## Progress
   - [ ] Step 1: ...
   - [ ] Step 2: ...
   ```

3. **Load ONLY what's needed** (context budget):
   - The task description from TODO.md (~20 lines)
   - For Agent tasks: `docs/architecture/agent-harness.md` + existing agent files
   - For API tasks: the specific route file being modified
   - For Extension tasks: `docs/architecture/client-side-delivery.md`
   - For Infra tasks: `infra/CLAUDE.md` + relevant workflow file
   - **DO NOT read all architecture docs** — only the one relevant to this task
   - **DO NOT read the full TODO.md** — only parse the summary + this task's section

4. **Verify preconditions**: Check that dependency outputs exist (grep for expected files/exports)

### Phase 3: Implementation

Follow the project's 5-phase workflow:

1. **Research**: Check existing code patterns. Use `grep`/`find` to understand conventions.
2. **Plan**: For tasks >4h, briefly outline the approach (3-5 bullet points) and **write them to the work log**. For smaller tasks, proceed directly.
3. **Implement**: Write the code/config. Follow project conventions:
   - TypeScript for api/, Python for agents/
   - Use absolute imports matching existing style
   - File size: 200-400 lines optimal, 800 max
   - No hardcoded secrets, parameterized queries only
4. **Test**: Implement the test described in the task's "Test:" field. Run it.
5. **Verify**: Run relevant linters/typecheckers:
   - Python: `uv run ruff check . && uv run mypy agents/`
   - TypeScript: `bun run lint && bun run typecheck`
   - SQL: verify via `make db-health` if applicable

**Chunking large tasks (>4h effort):**
- Break into sub-steps of ~1-2h each
- After completing each sub-step, update the work log with:
  - Which files were created/modified
  - What was tested
  - What's next
- If context is getting heavy (you've read >15 files), tell the user:
  "This task has more work remaining. Current progress saved to `.todo-log/{TASK-ID}.md`. Run `/todo-next --continue` in a new session to resume."

### Phase 4: Completion

1. **Mark task completed**: Edit TODO.md, replace `🔄` with `✅` on the task heading
2. **Finalize work log**: Update `.todo-log/{TASK-ID}.md`:
   ```markdown
   # {TASK-ID} · {Title}
   Status: completed
   Started: {start-timestamp}
   Completed: {end-timestamp}
   
   ## Files Created/Modified
   - agents/harness/base.py (new) — BaseAgent wrapper for create_react_agent
   - agents/harness/guards.py (new) — pre/post_model_hook loop guards
   
   ## Tests
   - pytest agents/tests/test_base.py — 4 passed
   
   ## Key Decisions
   - Used state dict directly in hooks (not InjectedState) per langgraph#4841
   - Degrade chain: V4 Pro → GLM-4.7 → V4 Flash
   
   ## Unblocked
   - AGENT-018 (ResumeAgent) — can now subclass BaseAgent
   - AGENT-019 (JobMatchAgent) — same
   ```
3. **Report to user** (concise):
   ```
   ## Completed: TASK-ID · Title

   Files: path/to/new.py (new), path/to/mod.ts (modified)
   Tests: describe result
   Unblocked: TASK-X, TASK-Y
   Suggested next: TASK-Z (highest-impact ready task)
   ```

### Phase 5: Session Boundary Advice

After completing a task, assess context usage:
- If this is the **1st task** in session and effort was ≤4h → suggest "Run `/todo-next` again for the next task"
- If this is the **2nd+ task** or effort was >4h → suggest "Context is getting heavy. Best to start a fresh session: `/todo-next`"
- If the task was **partially completed** → suggest "Run `/todo-next --continue` in a new session"

## Resuming Work (--continue)

When `--continue` is specified:
1. Find the task marked `🔄` in TODO.md
2. Read its `.todo-log/{TASK-ID}.md` for the work log
3. The "Progress" checklist shows what's done and what remains
4. The "Files" section shows what exists — verify those files are actually there
5. Continue from the first unchecked step
6. Do NOT re-read files you already processed (they're summarized in the log)

## Important Rules

- **Never skip the test step** — every task has a "Test:" field, implement and run it
- **Respect project constraints** (from CLAUDE.md):
  - Hybrid backend: TS API ↔ Python agents via HTTP only, never mix
  - LLM via OpenRouter (OPENROUTER_BASE_URL + ChatOpenAI), not Claude API
  - Non-standard ports: PG 5433, Redis 6380
  - Client-side execution: job submissions in browser extension, never server-side
  - No credential storage, no resume fabrication
  - HITL required for submit_form/send_email/delete_*
  - LangGraph create_react_agent, NOT legacy AgentExecutor
  - post_model_hook bug (#4841): guards use state dict directly, not InjectedState
- **One task per invocation** unless --batch is specified
- **Write the work log BEFORE starting implementation** — it's your recovery point
- **If context is heavy, stop and checkpoint** rather than rushing a half-done task
- **If blocked** (dependency not actually done, missing config, etc.), mark the task heading with `⏳`, log the reason, and auto-pick the next ready task
- **Commit conventions**: `feat:`, `fix:`, `refactor:`, `test:`, `chore:` — but do NOT auto-commit unless the user explicitly asks
