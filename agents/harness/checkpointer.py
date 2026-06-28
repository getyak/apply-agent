"""PostgresSaver factory — reuses PG 5433 (infra/CLAUDE.md).

Caller:
  - coordinator/router.py     ask_vantage thread (thread_id = ask_vantage:{user_id})
  - nodes/interview_agent.py  per-session mock graphs (thread_id = mock:{session_id})
  - coordinator/dock_agent.py  dock ReAct graph (lifetime per-user)

Failure: lazy-init. If PG unreachable, returns MemorySaver for the current call
and logs an error — this lets dev/tests run without infra, but production must
have PG up (audit.py will fail loudly when it can't insert into agent_tasks).

P0-3 fix (round-1): ``PostgresSaver.from_conn_string`` returns a context
manager; old code treated it as a plain value. Now we enter the CM and hold
it for the process lifetime.

P0-4 fix (round-2, traceId 68f6d78f / ed4f208e): the **sync** ``PostgresSaver``
does not implement the async API (``aget_tuple`` / ``aput`` / etc.) — the
base-class methods raise ``NotImplementedError``. Dock and any other graph
run through ``graph.astream_events(...)`` need those async hooks, so a bare
"hi" → dock turn failed with ``NotImplementedError`` at
``langgraph/checkpoint/base/__init__.py:441 aget_tuple``.

The fix is to use ``AsyncPostgresSaver`` instead — it implements BOTH the
sync and async APIs against the same schema, so all existing callers
(``graph.invoke`` sync paths, ``astream_events`` async paths) keep working
on the same singleton. The CM is async, so we enter it inside an event
loop on first access and hold the underlying saver for the process
lifetime. Reentrant ``get_checkpointer()`` calls return the cached saver
directly (sync), preserving the old call site signature.
"""
from __future__ import annotations

import asyncio
import atexit
import os
import threading
from typing import Any

from langgraph.checkpoint.memory import MemorySaver

# Held strong-refs for the lifetime of the process. The async CM's __aexit__
# would tear down the underlying psycopg pool, which is exactly what we want
# to NOT happen between requests.
_HELD_CMS: list[Any] = []
_HELD_LOOP: asyncio.AbstractEventLoop | None = None
_HELD_THREAD: threading.Thread | None = None

# Cached singleton + init lock. We can't use functools.lru_cache here because
# init is async-aware — we need to drive an event loop to enter the
# AsyncPostgresSaver context manager. A simple double-checked flag suffices.
_SAVER: Any = None
_INIT_LOCK = threading.Lock()


def _close_held_cms() -> None:
    """Close any held PostgresSaver context managers on interpreter shutdown.

    For AsyncPostgresSaver we drive __aexit__ on the dedicated background
    loop that owns the connection — see _HELD_LOOP below.
    """
    global _HELD_LOOP, _HELD_THREAD
    if _HELD_LOOP is not None and _HELD_LOOP.is_running():
        async def _close_all() -> None:
            while _HELD_CMS:
                cm = _HELD_CMS.pop()
                try:
                    aexit = getattr(cm, "__aexit__", None)
                    if aexit is not None:
                        await aexit(None, None, None)
                    else:
                        exit_ = getattr(cm, "__exit__", None)
                        if exit_ is not None:
                            exit_(None, None, None)
                except Exception:  # noqa: BLE001 — best-effort shutdown
                    pass

        try:
            asyncio.run_coroutine_threadsafe(_close_all(), _HELD_LOOP).result(
                timeout=5
            )
        except Exception:  # noqa: BLE001 — best-effort shutdown
            pass
        try:
            _HELD_LOOP.call_soon_threadsafe(_HELD_LOOP.stop)
        except Exception:  # noqa: BLE001
            pass
        if _HELD_THREAD is not None:
            _HELD_THREAD.join(timeout=2)
        _HELD_LOOP = None
        _HELD_THREAD = None
    else:
        # No background loop — fall back to plain sync __exit__ (covers the
        # legacy sync-PostgresSaver path in case someone reverts the saver
        # choice via env var).
        while _HELD_CMS:
            cm = _HELD_CMS.pop()
            try:
                exit_ = getattr(cm, "__exit__", None)
                if exit_ is not None:
                    exit_(None, None, None)
            except Exception:  # noqa: BLE001
                pass


atexit.register(_close_held_cms)


def _start_background_loop() -> asyncio.AbstractEventLoop:
    """Start a daemon thread running a private event loop.

    The AsyncPostgresSaver owns a psycopg connection. That connection must
    live in (and only be touched from) a single event loop. Since FastAPI
    requests can land on any loop (TestClient spawns ephemeral ones, prod
    runs uvicorn's loop, tests use pytest-asyncio's loop…), we pin the
    saver's loop to a dedicated background one and let LangGraph's
    cross-loop scheduling do the rest.

    For the same reason the saver MUST be initialised inside that loop:
    its `__aenter__` opens the psycopg pool and binds it to the currently-
    running loop. We use run_coroutine_threadsafe to schedule the enter.
    """
    global _HELD_LOOP, _HELD_THREAD
    loop = asyncio.new_event_loop()

    def _run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_forever()

    t = threading.Thread(
        target=_run, name="relay-checkpointer-loop", daemon=True
    )
    t.start()
    _HELD_LOOP = loop
    _HELD_THREAD = t
    return loop


def get_checkpointer():
    """Return the configured checkpointer (Postgres or Memory fallback).

    Lazily imports AsyncPostgresSaver to keep MemorySaver-only test runs
    fast. Returns the same singleton across all callers — both
    ``graph.invoke`` (sync) and ``graph.astream_events`` (async) paths share
    one psycopg connection.

    Tests can blow away the cached singleton via ``reset_for_tests()``.
    """
    global _SAVER
    if _SAVER is not None:
        return _SAVER

    with _INIT_LOCK:
        if _SAVER is not None:  # second writer lost the race
            return _SAVER

        dsn = os.environ.get("RELAY_PG_DSN")
        if not dsn:
            _SAVER = MemorySaver()
            return _SAVER

        try:
            # Imported here so unit tests don't need psycopg installed.
            from langgraph.checkpoint.postgres.aio import (  # type: ignore
                AsyncPostgresSaver,
            )

            loop = _HELD_LOOP or _start_background_loop()

            async def _enter() -> Any:
                cm = AsyncPostgresSaver.from_conn_string(dsn)
                saver = await cm.__aenter__()
                _HELD_CMS.append(cm)
                # setup() ensures the three checkpoint tables exist; idempotent.
                await saver.setup()
                return saver

            future = asyncio.run_coroutine_threadsafe(_enter(), loop)
            saver = future.result(timeout=15)
            _SAVER = saver
            return _SAVER
        except Exception as exc:  # noqa: BLE001 — boundary, log + degrade
            import structlog

            structlog.get_logger().error(
                "checkpointer.postgres_init_failed",
                error=str(exc),
                kind=type(exc).__name__,
                fallback="memory",
            )
            _SAVER = MemorySaver()
            return _SAVER


def reset_for_tests() -> None:
    """Drop the cached singleton + tear down the background loop.

    Tests that swap RELAY_PG_DSN or patch the AsyncPostgresSaver class need
    to start clean. Production code MUST NOT call this — it would orphan
    the psycopg connection pool.
    """
    global _SAVER
    _close_held_cms()
    _SAVER = None


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
