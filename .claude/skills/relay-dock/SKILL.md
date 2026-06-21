---
name: relay-dock
description: Invoke Relay's Dock Agent tools (plan-first ReAct, résumé tailoring, applications pipeline, mock interview, memory recall) from Claude Code via the relay-dock MCP server. Trigger /relay-dock.
trigger: /relay-dock
---

# /relay-dock

Drive the same plan-first, tool-using **Dock Agent** that powers Relay's
in-app Ask Vantage dock — but from Claude Code instead of the web UI.
Every Dock tool is exposed as an MCP tool over stdio: ``propose_plan``,
``recall_user_memory``, ``recall_past_applications``, ``recall_weak_points``,
``list_my_applications``, ``start_mock_interview``, ``find_jobs``, and
``tailor_resume``.

## Setup

The MCP server lives at ``agents/mcp_dock/server.py`` and is launched on
demand by Claude Code. To wire it up:

1. **Install the MCP extra** (one time):
   ```bash
   cd agents && uv sync --extra dev --extra experimental
   ```

2. **Register the server** in ``~/.claude/settings.json``:
   ```json
   {
     "mcpServers": {
       "relay-dock": {
         "command": "uv",
         "args": ["run", "python", "-m", "agents.mcp_dock.server"],
         "cwd": "/Users/xiongxinwei/data/mine/cubxxw/personal/apply-agent/agents"
       }
     }
   }
   ```

3. **Restart Claude Code**. ``/mcp`` should now list ``relay-dock`` and its
   tools.

## Calling pattern

The Dock prompt rules apply here too — **plan first, then execute**. A
typical session:

```
1. relay-dock:propose_plan(
     user_id="<your uuid>",
     user_goal="Recall how I described myself to the dock last week",
     steps=[
       {"step": "recall", "agent": "coordinator",
        "label": "Look up user_memories", "requires_review": false}
     ],
   )

2. relay-dock:recall_user_memory(
     user_id="<your uuid>",
     query="self-description / target role preferences",
     limit=5,
   )
```

Every tool takes ``user_id`` as its first arg — the relay-dock server
uses that to scope DB reads / writes the same way the web dock does
(via the contextvars set by ``set_dock_context``).

## When to use this

- **Driving Vantage from a terminal / IDE** when the web UI isn't open.
- **Scripting a habit** — `/relay-dock` then a chained tool call lets you
  bake a daily "what did I do yesterday + what's next today" loop into
  your morning Claude Code routine.
- **Adversarial review** of the Dock tool envelopes: if a tool returns
  ``not_implemented`` or ``needs_args``, you see it here exactly as the
  in-app LLM would — useful when triaging "dock said it couldn't" bug
  reports.

## When NOT to use this

- **Side-effecting operations** that the web dock gates with HITL
  ``interrupt()``. ``start_mock_interview`` will return a thread_id but
  there's no way to resume the LangGraph from MCP today — use the web UI
  for actual interview sessions.
- **Multi-turn tailoring** that needs the in-app diff card. The dock's
  ``tailor_resume`` tool returns a ``needs_args`` envelope pointing at
  ``/resume/customize``; from MCP you'd have to materialise the base
  résumé + JD yourself.

## Files

- ``agents/mcp_dock/server.py`` — stdio MCP server registration
- ``agents/mcp_dock/tools.py`` — MCP tool catalog (8 tools)
- ``agents/coordinator/dock_tools.py`` — underlying LangGraph @tool
  implementations (shared with the web dock)
- ``agents/tests/test_mcp_dock_tools.py`` — adapter unit tests
- ``docs/design/chat-agent-system-redesign.md`` — design context

## Troubleshooting

- **"mcp package not installed"** on startup → run the ``uv sync --extra
  experimental`` step above.
- **Tool returns ``status: "unavailable"``** → the underlying recall
  tool degraded because PG was unreachable. Check ``RELAY_PG_DSN`` or
  ``DATABASE_URL`` in your agents shell env.
- **``find_jobs`` always returns ``not_implemented``** → expected; the
  underlying jobmatch_agent action is wired but not generating yet.
  Tracked in the design doc.
