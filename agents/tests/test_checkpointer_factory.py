"""Unit tests for agents/harness/checkpointer.py — the PostgresSaver factory.

Locks down the P0-3 → P0-5 evolution of the checkpointer:
  - No RELAY_PG_DSN env → returns MemorySaver (back-compat)
  - PG unreachable → logged + falls back to MemorySaver (not crash)
  - P0-5 (2026-07-02): the saver is backed by an ``AsyncConnectionPool``,
    not a single ``from_conn_string`` connection — the pool transparently
    recycles idle-killed conns via ``max_idle`` / ``max_lifetime``.
  - Half-initialised pools MUST NOT leak into ``_HELD_CMS``: if
    ``pool.open()`` or ``saver.setup()`` raises, the pool is closed and
    the fallback branch runs with a clean held list.
  - The cached singleton means repeated calls return the same saver (no
    duplicate psycopg pool).
  - atexit hook closes held pools by driving their async ``close()`` on
    the dedicated background loop.

These tests run hermetically — no real PG. The pool is stubbed with an
object exposing ``open`` and ``close`` as ``AsyncMock`` so we can watch
who called what.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langgraph.checkpoint.memory import MemorySaver

from agents.harness import checkpointer as cp


@pytest.fixture(autouse=True)
def _isolate_dsn(monkeypatch):
    """Clear any inherited RELAY_PG_DSN + the cached singleton between tests."""
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    cp.reset_for_tests()
    yield
    cp.reset_for_tests()


def _stub_pool(open_side_effect=None):
    """Stand-in for ``psycopg_pool.AsyncConnectionPool``.

    ``open()`` / ``close()`` are AsyncMocks so tests can assert who drove
    the lifecycle. ``open_side_effect`` lets a test simulate PG being
    unreachable.
    """
    pool = MagicMock(name="AsyncConnectionPool")
    if open_side_effect is not None:
        pool.open = AsyncMock(side_effect=open_side_effect)
    else:
        pool.open = AsyncMock(return_value=None)
    pool.close = AsyncMock(return_value=None)
    return pool


def _stub_saver():
    """Stand-in for ``AsyncPostgresSaver`` — only ``setup()`` is awaited."""
    saver = MagicMock(name="AsyncPostgresSaver")
    saver.setup = AsyncMock(return_value=None)
    return saver


def test_no_dsn_returns_memory_saver():
    saver = cp.get_checkpointer()
    assert isinstance(saver, MemorySaver)
    assert cp._HELD_CMS == []  # no pool held when there's no PG


def test_dsn_set_but_postgres_unreachable_falls_back(monkeypatch):
    """P0-5: If pool.open() fails, close the pool and fall back to Memory.

    The half-open pool must NOT be left in ``_HELD_CMS`` — otherwise the
    atexit hook would try to close a broken pool at process shutdown.
    """
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://nobody@127.0.0.1:1/none")

    pool = _stub_pool(open_side_effect=ConnectionRefusedError("no PG here"))

    with patch("psycopg_pool.AsyncConnectionPool", return_value=pool):
        saver = cp.get_checkpointer()

    assert isinstance(saver, MemorySaver)
    pool.open.assert_awaited_once()
    # The failure path must close the pool before propagating.
    pool.close.assert_awaited_once()
    # We should NOT have held on to a half-open pool.
    assert cp._HELD_CMS == []


def test_dsn_set_and_pg_reachable_returns_postgres_saver(monkeypatch):
    """Happy path: open pool → setup saver → hold the pool → return saver."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    pool = _stub_pool()
    fake_saver = _stub_saver()

    with (
        patch("psycopg_pool.AsyncConnectionPool", return_value=pool),
        patch(
            "langgraph.checkpoint.postgres.aio.AsyncPostgresSaver",
            return_value=fake_saver,
        ),
    ):
        saver = cp.get_checkpointer()

    assert saver is fake_saver
    pool.open.assert_awaited_once()
    fake_saver.setup.assert_awaited_once()
    # CRITICAL: the pool is held so the connection stays open across turns.
    assert cp._HELD_CMS == [pool]
    # And close() has NOT been called yet (would tear down the pool).
    pool.close.assert_not_awaited()


def test_singleton_means_one_init_per_process(monkeypatch):
    """Repeated get_checkpointer() returns the same instance, no double init."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    pool = _stub_pool()
    fake_saver = _stub_saver()

    with (
        patch(
            "psycopg_pool.AsyncConnectionPool", return_value=pool
        ) as pool_factory,
        patch(
            "langgraph.checkpoint.postgres.aio.AsyncPostgresSaver",
            return_value=fake_saver,
        ),
    ):
        a = cp.get_checkpointer()
        b = cp.get_checkpointer()
        c = cp.get_checkpointer()

    assert a is b is c
    pool_factory.assert_called_once()
    fake_saver.setup.assert_awaited_once()
    # Still only one pool held.
    assert len(cp._HELD_CMS) == 1


def test_close_held_pools_calls_close(monkeypatch):
    """The atexit hook drains _HELD_CMS by awaiting ``close()`` on each pool."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    pool = _stub_pool()
    fake_saver = _stub_saver()

    with (
        patch("psycopg_pool.AsyncConnectionPool", return_value=pool),
        patch(
            "langgraph.checkpoint.postgres.aio.AsyncPostgresSaver",
            return_value=fake_saver,
        ),
    ):
        cp.get_checkpointer()

    assert cp._HELD_CMS == [pool]

    cp._close_held_cms()

    pool.close.assert_awaited_once_with()
    assert cp._HELD_CMS == []


def test_thread_id_helpers_unchanged():
    """Sanity: must NOT change thread_id naming (would break HITL resume)."""
    u = "00000000-0000-0000-0000-000000000001"
    s = "00000000-0000-0000-0000-000000000002"
    r = "00000000-0000-0000-0000-000000000003"

    assert cp.ask_vantage_thread_id(u) == f"ask_vantage:{u}"
    assert cp.mock_thread_id(s) == f"mock:{s}"
    assert cp.build_resume_thread_id(u, s) == f"build_resume:{u}:{s}"
    assert cp.resume_studio_thread_id(u, r) == f"resume_studio:{u}:{r}"
