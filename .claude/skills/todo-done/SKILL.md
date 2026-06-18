---
name: todo-done
description: Mark a TODO task completed, update dependencies, show what's unblocked
trigger: /todo-done
---

# /todo-done

Mark one or more tasks as completed in TODO.md, write completion logs, and show the cascade effect.

## Usage

```
/todo-done AGENT-001                  # mark single task done
/todo-done AGENT-001 AGENT-002       # mark multiple tasks done
/todo-done --last                     # mark the last in-progress task done
/todo-done AGENT-001 --note "skipped optional caching"   # with note
```

## What You Must Do When Invoked

### Step 1: Identify Tasks

1. Read `TODO.md` from the project root
2. If `$ARGUMENTS` contains task IDs (e.g. AGENT-001), use those
3. If `$ARGUMENTS` is `--last`, find the task(s) currently marked `🔄` (in-progress)
4. If no argument, error: "Specify a task ID or use --last"

### Step 2: Validate Completion

For each task to mark done:
1. Find the `####` heading line containing the task ID
2. Verify the task exists
3. If already `✅`, skip with notice
4. Check if the task has a "Test:" field — remind user if tests weren't run

### Step 3: Update TODO.md

For each task:
1. If heading has `🔄`, replace it with `✅`
2. If heading has `⏳`, replace it with `✅`
3. If heading has no status marker, append ` ✅` to the heading line
4. If `--note` provided, add a line after the heading: `> Completion note: {note}`

### Step 4: Write/Update Completion Log

For each completed task, ensure `.todo-log/{TASK-ID}.md` exists and is finalized:
1. If the file already exists (from `/todo-next`), update Status to `completed` and set Completed timestamp
2. If the file doesn't exist (task was done outside the skill), create a minimal log:
   ```markdown
   # {TASK-ID} · {Title}
   Status: completed
   Completed: {timestamp}
   
   ## Files Created/Modified
   (check git diff or recent file changes if possible)
   
   ## Notes
   {--note content if provided, otherwise "Marked complete via /todo-done"}
   ```

### Step 5: Cascade Analysis

After marking done, analyze what's newly unblocked:

1. Scan ALL tasks in TODO.md
2. For each pending task, check its Dependencies field
3. A task becomes **newly ready** if ALL its dependencies are now `✅`
4. Report the cascade

### Step 6: Update Current State Summary

If ALL tasks in a dimension section are `✅`, update the Status column in the "Current State Summary" table at the top of TODO.md.

### Step 7: Report

```
## Marked Done: TASK-ID · Title

### Newly Unblocked Tasks (ready to work)
| Task | Priority | Effort | Description |
|------|----------|--------|-------------|
| TASK-X | P0 | 3h | Short description |
| TASK-Y | P1 | 5h | Short description |

### Progress Update
- Dimension: X/Y done (Z%)
- Overall: A/187 done (B%)

### Suggested Next
Best ready task: TASK-Z · Title (P0, 3h, unblocks 5 tasks)
→ Run `/todo-next` or `/todo-next TASK-Z` to start it
```

### Important Rules

- **Only modify TODO.md and .todo-log/ files** — never touch any other file
- **Preserve all task content** — only change the heading line (add/replace status emoji)
- **Be accurate about cascade** — only report tasks as "newly ready" if ALL their deps are now done
- **Always write the completion log** — it's the cross-session memory for `/todo-next --continue`
- **Update the summary table** when dimension-level status changes
