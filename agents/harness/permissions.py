"""Permission system — wraps tools with @requires_approval → LangGraph interrupt().

Caller: agents/tools/approve.py decorates each APPROVE-level tool with this.
Resume flow: graph.invoke(Command(resume={"type": "approve"}), config=cfg).

Four levels (mirroring docs/architecture/agent-harness.md § Tool 权限系统):
  AUTO     — register tool directly, no notification
  NOTIFY   — emit WebSocket notification after execution
  APPROVE  — interrupt() before execution, wait for user decision
  BLOCK    — not registered to tools list (handled at registry layer)
"""
from __future__ import annotations

from functools import wraps
from typing import Any, Callable, Literal

from langgraph.types import interrupt


PermissionLevel = Literal["AUTO", "NOTIFY", "APPROVE", "BLOCK"]


def requires_approval(action_name: str) -> Callable:
    """Decorator: pauses graph via interrupt() and resumes on user decision.

    Usage:
        @tool
        @requires_approval("submit_form")
        def submit_form(job_url: str, fields: dict) -> str:
            ...

    The decorated function MUST be idempotent (the user might approve twice
    on retry).
    """

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            decision = interrupt(
                {
                    "action": action_name,
                    "args": args,
                    "kwargs": kwargs,
                    "message": f"Agent wants to {action_name}. Approve?",
                }
            )
            d_type = (decision or {}).get("type") if isinstance(decision, dict) else None
            if d_type == "approve":
                # Allow user to mutate args at approval time.
                final_kwargs = {**kwargs, **(decision.get("kwargs", {}) if isinstance(decision, dict) else {})}
                return fn(*args, **final_kwargs)
            if d_type == "reject":
                return {"status": "rejected", "reason": (decision or {}).get("reason", "user cancelled")}
            return {"status": "timeout", "reason": "no decision received"}

        wrapper.__relay_permission__ = "APPROVE"  # type: ignore[attr-defined]
        return wrapper

    return decorator


def mark_notify(fn: Callable) -> Callable:
    """Tag a tool as NOTIFY — the API layer reads __relay_permission__ and pushes
    a WebSocket event after the tool returns.
    """
    fn.__relay_permission__ = "NOTIFY"  # type: ignore[attr-defined]
    return fn


def mark_auto(fn: Callable) -> Callable:
    """Tag a tool as AUTO — explicit marker for readability; default if untagged."""
    fn.__relay_permission__ = "AUTO"  # type: ignore[attr-defined]
    return fn


def permission_of(fn: Callable) -> PermissionLevel:
    return getattr(fn, "__relay_permission__", "AUTO")  # type: ignore[no-any-return]
