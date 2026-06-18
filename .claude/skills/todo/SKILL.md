---
name: todo
description: Show TODO.md task status, progress stats, and what's ready to work on
trigger: /todo
---

# /todo

Display current TODO.md status dashboard. Shows progress, available tasks, and bottleneck analysis.

## Usage

```
/todo                    # full dashboard
/todo status             # just progress stats
/todo ready              # only tasks with met dependencies
/todo blocked            # tasks and what blocks them
/todo critical           # critical path tasks only
/todo P0                 # filter by priority
/todo AGENT              # filter by dimension (INFRA/AGENT/API/WEB/EXT/TEST/EVAL/SEC/PERF)
```

## What You Must Do When Invoked

Read `TODO.md` from the project root. Parse every task entry (#### headings) extracting:
- **Task ID** (e.g. AGENT-001)
- **Status**: Look for status markers at the end of the heading line:
  - `✅` = completed
  - `🔄` = in progress
  - `⏳` = blocked
  - No marker = pending
- **Priority** (P0/P1/P2/P3)
- **Dependencies** (from "Dependencies:" field)
- **Effort** (from "Effort:" field)

### Determine "ready" tasks

A task is **ready** when:
1. Its status is pending (no marker)
2. ALL dependencies are either completed (✅) or have "None"
3. It is not blocked by any in-progress prerequisite

### Output Format

If `$ARGUMENTS` is empty or "status", show the full dashboard:

```
## Relay TODO Dashboard

### Progress
| Dimension | Total | ✅ Done | 🔄 Active | ⏳ Blocked | Pending | % |
|-----------|-------|---------|-----------|-----------|---------|---|
| INFRA     | 40    | 3       | 1         | 0         | 36      | 8%|
| ...       |       |         |           |           |         |   |
| **Total** | 187   | ...     | ...       | ...       | ...     | .%|

### Ready to Work (dependencies met)
Sorted by: P0 first, then by downstream-unblock count (tasks that unblock the most others first)

| # | Task | Priority | Effort | Unblocks |
|---|------|----------|--------|----------|
| 1 | AGENT-001 · Python project scaffold | P0 | 3h | 8 tasks |
| 2 | INFRA-001 · CI skeleton | P0 | 4h | 6 tasks |
| ...

### Bottlenecks (completed tasks that would unblock the most)
| Task | Status | Would Unblock |
|------|--------|---------------|
| AGENT-013 · BaseAgent | pending | 8 tasks |

### Critical Path
AGENT-001 → 002 → 003 → 004/006 → 007/008 → 013 → 018 → 030 → 031
```

If `$ARGUMENTS` is "ready", show only the ready-to-work table.
If `$ARGUMENTS` is a dimension prefix (INFRA/AGENT/API/WEB/EXT/TEST/EVAL/SEC), filter to that dimension.
If `$ARGUMENTS` is a priority (P0/P1/P2/P3), filter by priority.
If `$ARGUMENTS` is "critical", show only the critical path tasks and their status.
If `$ARGUMENTS` is "blocked", show tasks that are blocked and what specifically blocks them.

### Important Rules

- **Never modify TODO.md** — this skill is read-only
- Parse the actual file, don't use cached/remembered data
- Count tasks by looking for `####` heading lines containing task IDs (pattern: `UPPERCASE-NNN`)
- Status markers are appended to the heading: `#### AGENT-001 · Title ✅`
- If the file has no status markers yet, all tasks are "pending"
- Always show the "Next recommended" suggestion: the single highest-impact ready task
