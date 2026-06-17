---
name: todo-sprint
description: Plan a focused sprint of parallel-safe tasks from TODO.md
trigger: /todo-sprint
---

# /todo-sprint

Generate a sprint plan — a set of independent, parallel-safe tasks you can work through across multiple sessions.

## Usage

```
/todo-sprint                          # auto-generate optimal sprint (8-16h budget)
/todo-sprint --budget 20h             # custom hour budget
/todo-sprint --focus AGENT            # focus on one dimension
/todo-sprint --focus P0               # focus on priority
/todo-sprint --week                   # plan a full week (~40h)
```

## What You Must Do When Invoked

### Step 1: Analyze Current State

1. Read `TODO.md`, parse all tasks with status/deps/priority/effort
2. Identify all "ready" tasks (deps met, not in-progress/done)
3. Build the dependency graph: for each ready task, check if any OTHER ready task depends on it

### Step 2: Select Sprint Tasks

**Budget**: Default 16h, or from `--budget` arg, or 40h for `--week`

**Selection rules:**
1. Start with all ready tasks
2. If `--focus`, filter to matching dimension or priority
3. Sort by: P0 first → critical-path bonus → unblock count → effort ascending
4. Greedily add tasks to sprint while:
   - Total effort <= budget
   - No task in the sprint depends on another task in the sprint (unless in sequential phases)
   - Max 8 tasks per sprint (cognitive limit for solo dev)

### Step 3: Identify Parallel Groups

Within the sprint, group tasks that share NO dependencies into parallel groups:

```
Group A (can run simultaneously):
  - INFRA-001 (4h) — CI skeleton
  - AGENT-001 (3h) — Python scaffold
  - API-001 (8h) — Zod validation

Group B (after Group A, or independent):
  - TEST-001 (4h) — pytest harness
  - SEC-011 (4h) — secrets scanning
```

### Step 4: Output Sprint Plan

```
## Sprint Plan — {date}

**Budget:** {N}h | **Tasks:** {M} | **Priority mix:** X P0, Y P1, Z P2

### Execution Order

**Phase 1 — Independent (start all)**
| Task | Priority | Effort | Why |
|------|----------|--------|-----|
| AGENT-001 | P0 | 3h | Critical path start + unblocks 8 |
| INFRA-001 | P0 | 4h | CI backbone + unblocks 6 |

**Phase 2 — After Phase 1**
| Task | Priority | Effort | Requires |
|------|----------|--------|----------|
| AGENT-002 | P0 | 2h | AGENT-001 |

**Total:** {sum}h across {phases} phases

### Quick Start
Run these commands to begin:
1. `/todo-next AGENT-001` — start highest-impact task
2. `/todo-next INFRA-001` — in parallel (new session)
3. After both done: `/todo-next AGENT-002`

### What This Sprint Unblocks
After completing all {M} tasks, these become ready:
- TASK-X, TASK-Y, TASK-Z...
```

### Step 5: Optionally Save Sprint

If the user confirms, append a sprint log entry to the bottom of TODO.md:

```markdown
---

## Sprint Log

### Sprint 1 — {date}
- Budget: 16h | Planned: TASK-A, TASK-B, TASK-C
- Status: in-progress
```

### Important Rules

- **Never include tasks whose dependencies aren't met** — even if they're P0
- **Never put task A and task B in the same sprint if B depends on A** — unless they're in sequential phases
- **Prefer breadth over depth** — unblocking multiple dimensions > deep-diving one
- **Respect the hour budget** — don't over-plan
- **Each sprint should leave the project in a testable state** — not half-built features
