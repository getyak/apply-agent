"""PostgresSaver factory — reuses PG 5433 (infra/CLAUDE.md).

Caller:
  - coordinator/router.py     ask_vantage thread (thread_id = ask_vantage:{user_id})
  - nodes/interview_agent.py  per-session mock graphs (thread_id = mock:{session_id})

Failure: lazy-init. If PG unreachable, returns MemorySaver for the current call
and logs an error — this lets dev/tests run without infra, but production must
have PG up (audit.py will fail loudly when it can't insert into agent_tasks).
"""
from __future__ import annotations

import os
from functools import lru_cache

from langgraph.checkpoint.memory import MemorySaver


@lru_cache(maxsize=1)
def get_checkpointer():
    """Return the configured checkpointer (Postgres or Memory fallback).

    Lazily imports PostgresSaver to keep MemorySaver-only test runs fast.
    """
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return MemorySaver()

    try:
        # Imported here so unit tests don't need psycopg installed.
        from langgraph.checkpoint.postgres import PostgresSaver  # type: ignore

        saver = PostgresSaver.from_conn_string(dsn)
        saver.setup()
        return saver
    except Exception as exc:  # noqa: BLE001 — boundary, log + degrade
        import structlog

        structlog.get_logger().error(
            "checkpointer.postgres_init_failed", error=str(exc), fallback="memory"
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
