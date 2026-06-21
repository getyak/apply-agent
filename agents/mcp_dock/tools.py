"""Adapter layer: dock_tools → MCP tool envelope.

Every MCP tool here is a thin wrapper around the corresponding LangGraph
``@tool`` in ``agents.coordinator.dock_tools``. We accept the same args
(through MCP's JSON Schema) and return the tool's result dict directly so
external MCP clients see exactly what the in-app Dock LLM would see.

Why we don't just re-export the LangGraph tools:
  - LangGraph tools depend on the contextvars set by
    ``dock_tools.set_dock_context`` (for ``user_id``). MCP calls come from
    outside that context, so each adapter has to bind the user explicitly
    from the call argument before invoking the underlying tool.
  - LangGraph tool decorators bake in pydantic validation tied to their
    docstring-derived schema, which doesn't always match MCP's
    JSONSchema dialect. Going through a thin adapter lets us hand-author
    the MCP schema and keep the LangGraph one decoupled.

User scoping:
  Every adapter takes ``user_id`` as its first arg. The MCP client (Claude
  Code) is expected to pass the operator's UUID; we bind it into the
  contextvar for the duration of the underlying tool's invocation. This
  mirrors how the FastAPI ``/ask/stream`` endpoint binds the user from
  ``X-Relay-User-Id``.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from agents.coordinator import dock_tools


def _with_user(user_id: str | UUID):
    """Bind the user, return tokens for reset_dock_context."""
    uid = user_id if isinstance(user_id, UUID) else UUID(str(user_id))
    tokens = dock_tools.set_dock_context(
        user_id=uid,
        thread_id=f"mcp_dock:{uid}",
        surface="mcp_dock",
    )
    return tokens


async def propose_plan(
    user_id: str, user_goal: str, steps: list[dict[str, Any]]
) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return dock_tools.propose_plan.func(user_goal=user_goal, steps=steps)
    finally:
        dock_tools.reset_dock_context(tokens)


async def recall_user_memory(
    user_id: str, query: str, limit: int = 5
) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return await dock_tools.recall_user_memory.ainvoke(
            {"query": query, "limit": limit}
        )
    finally:
        dock_tools.reset_dock_context(tokens)


async def recall_past_applications(
    user_id: str, limit: int = 10
) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return await dock_tools.recall_past_applications.ainvoke({"limit": limit})
    finally:
        dock_tools.reset_dock_context(tokens)


async def recall_weak_points(user_id: str, limit: int = 5) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return await dock_tools.recall_weak_points.ainvoke({"limit": limit})
    finally:
        dock_tools.reset_dock_context(tokens)


async def list_my_applications(user_id: str, limit: int = 25) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return await dock_tools.list_my_applications.ainvoke({"limit": limit})
    finally:
        dock_tools.reset_dock_context(tokens)


async def start_mock_interview(
    user_id: str,
    mode_slug: str = "scene_recreation",
    company: str | None = None,
    role: str | None = None,
    round_type: str | None = None,
) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return await dock_tools.start_mock_interview.ainvoke(
            {
                "mode_slug": mode_slug,
                "company": company,
                "role": role,
                "round_type": round_type,
            }
        )
    finally:
        dock_tools.reset_dock_context(tokens)


async def find_jobs(
    user_id: str,
    role: str | None = None,
    location: str | None = None,
    remote_only: bool = False,
    limit: int = 10,
) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return await dock_tools.find_jobs.ainvoke(
            {
                "role": role,
                "location": location,
                "remote_only": remote_only,
                "limit": limit,
            }
        )
    finally:
        dock_tools.reset_dock_context(tokens)


async def tailor_resume(
    user_id: str,
    job_id: str,
    base_resume_id: str | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    tokens = _with_user(user_id)
    try:
        return await dock_tools.tailor_resume.ainvoke(
            {
                "job_id": job_id,
                "base_resume_id": base_resume_id,
                "notes": notes,
            }
        )
    finally:
        dock_tools.reset_dock_context(tokens)


# Tool catalog kept in sync with server.py's _list_tools().
TOOL_CATALOG: list[dict[str, Any]] = [
    {
        "name": "propose_plan",
        "func": propose_plan,
        "description": (
            "Declare the multi-step plan for this turn before executing "
            "anything. Same contract as the in-app Dock's propose_plan."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string", "description": "Operator UUID"},
                "user_goal": {"type": "string"},
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "step": {"type": "string"},
                            "agent": {"type": "string"},
                            "label": {"type": "string"},
                            "requires_review": {"type": "boolean"},
                        },
                    },
                },
            },
            "required": ["user_id", "user_goal", "steps"],
        },
    },
    {
        "name": "recall_user_memory",
        "func": recall_user_memory,
        "description": "Retrieve user_memories rows relevant to a query.",
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10},
            },
            "required": ["user_id", "query"],
        },
    },
    {
        "name": "recall_past_applications",
        "func": recall_past_applications,
        "description": "Recall the user's most recent application_drafts rows.",
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            },
            "required": ["user_id"],
        },
    },
    {
        "name": "recall_weak_points",
        "func": recall_weak_points,
        "description": "Recall latest mock-interview weak points.",
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10},
            },
            "required": ["user_id"],
        },
    },
    {
        "name": "list_my_applications",
        "func": list_my_applications,
        "description": "List the user's application pipeline (kanban rows).",
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "required": ["user_id"],
        },
    },
    {
        "name": "start_mock_interview",
        "func": start_mock_interview,
        "description": (
            "Start a Mock interview session. Returns thread_id + first question."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "mode_slug": {"type": "string"},
                "company": {"type": "string"},
                "role": {"type": "string"},
                "round_type": {"type": "string"},
            },
            "required": ["user_id"],
        },
    },
    {
        "name": "find_jobs",
        "func": find_jobs,
        "description": "Surface job matches (stub today — returns not_implemented).",
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "role": {"type": "string"},
                "location": {"type": "string"},
                "remote_only": {"type": "boolean"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            },
            "required": ["user_id"],
        },
    },
    {
        "name": "tailor_resume",
        "func": tailor_resume,
        "description": (
            "Customise the user's master résumé for a specific job — returns "
            "needs_args envelope pointing at the /resume/customize endpoint."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "user_id": {"type": "string"},
                "job_id": {"type": "string"},
                "base_resume_id": {"type": "string"},
                "notes": {"type": "string"},
            },
            "required": ["user_id", "job_id"],
        },
    },
]


def find_tool(name: str) -> dict[str, Any] | None:
    """Look up an MCP tool descriptor by name."""
    for spec in TOOL_CATALOG:
        if spec["name"] == name:
            return spec
    return None
