"""PostgresSaver factory — reuses PG 5433 (infra/CLAUDE.md).

Caller:
  - coordinator/router.py     ask_vantage thread (thread_id = ask_vantage:{user_id})
  - nodes/interview_agent.py  per-session mock graphs (thread_id = mock:{session_id})
  - coordinator/dock_agent.py  dock ReAct graph (lifetime per-user)

Failure: lazy-init. If PG unreachable, returns MemorySaver for the current call
and logs an error — this lets dev/tests run without infra, but production must
have PG up (audit.py will fail loudly when it can't insert into agent_tasks).

P0-3 fix: ``PostgresSaver.from_conn_string`` in
``langgraph-checkpoint-postgres>=2.x`` returns an ``Iterator[PostgresSaver]``
(a context manager that yields the saver and closes the connection on exit).
The pre-fix code treated it as a plain value, so ``.setup()`` was being called
on the *context manager* — silently raising AttributeError, which the broad
except swallowed into a MemorySaver fallback. Production HITL was running
on MemorySaver without anyone knowing. We now explicitly enter the CM and
hold both it and the saver for the process lifetime; the connection only
closes at interpreter shutdown via ``atexit``.
"""
from __future__ import annotations

import atexit
import os
from functools import lru_cache
from typing import Any

from langgraph.checkpoint.memory import MemorySaver

# Held strong-refs for the lifetime of the process. Closing the CM would
# tear down the underlying psycopg connection, which is exactly what we
# want to NOT happen between requests.
_HELD_CMS: list[Any] = []


def _close_held_cms() -> None:
    """Close any held PostgresSaver context managers on interpreter shutdown."""
    while _HELD_CMS:
        cm = _HELD_CMS.pop()
        try:
            cm.__exit__(None, None, None)
        except Exception:  # noqa: BLE001 — best-effort shutdown
            pass


atexit.register(_close_held_cms)


@lru_cache(maxsize=1)
def get_checkpointer():
    """Return the configured checkpointer (Postgres or Memory fallback).

    Lazily imports PostgresSaver to keep MemorySaver-only test runs fast.
    Holds the underlying context manager for process lifetime so the
    psycopg connection stays open between LangGraph invocations.
    """
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return MemorySaver()

    try:
        # Imported here so unit tests don't need psycopg installed.
        from langgraph.checkpoint.postgres import PostgresSaver  # type: ignore

        # from_conn_string returns Iterator[PostgresSaver] — a context
        # manager. We enter it (yielding the actual saver) and KEEP the
        # cm in _HELD_CMS so its __exit__ isn't called until atexit.
        cm = PostgresSaver.from_conn_string(dsn)
        saver = cm.__enter__()
        _HELD_CMS.append(cm)
        saver.setup()
        return saver
    except Exception as exc:  # noqa: BLE001 — boundary, log + degrade
        import structlog

        structlog.get_logger().error(
            "checkpointer.postgres_init_failed",
            error=str(exc),
            kind=type(exc).__name__,
            fallback="memory",
        )
        return MemorySaver()


def ask_vantage_thread_id(user_id: str) -> str:
    """Deterministic, per-user thread for the ask_vantage dock."""
    return f"ask_vantage:{user_id}"


def mock_thread_id(session_id: str) -> str:
    """Per-session thread for a Mock interview run."""
    return f"mock:{session_id}"


def build_resume_thread_id(user_id: str, session_id: str) -> str:
    """Per-session thread for build_from_scratch workflow."""
    return f"build_resume:{user_id}:{session_id}"


def resume_studio_thread_id(user_id: str, resume_root_id: str) -> str:
    """Per-résumé-branch thread for the Resume Studio vibe chat.

    See vantage-ui-mapping.md §2.6. Each résumé root (the base version's id —
    its variants share the same root) gets its own conversation so the chat
    doesn't carry "which résumé are we talking about" as in-context state.
    """
    return f"resume_studio:{user_id}:{resume_root_id}"
