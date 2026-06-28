"""Unit tests for agents/harness/checkpointer.py — the PostgresSaver factory.

Locks down the P0-3 + P0-4 fixes:
  - No RELAY_PG_DSN env → returns MemorySaver (back-compat)
  - PG unreachable → logged + falls back to MemorySaver (not crash)
  - AsyncPostgresSaver.from_conn_string is an async context manager: we
    enter it on a dedicated background loop and hold the cm so the
    connection survives between invocations
  - The cached singleton means repeated calls return the same saver (no
    duplicate psycopg pool)
  - atexit hook closes held CMs by driving their async __aexit__ on the
    background loop
  - Sync paths (graph.invoke) AND async paths (graph.astream_events) get
    the same saver — the new AsyncPostgresSaver implements BOTH APIs

These tests run hermetically — no real PG. The CM case is exercised with a
stand-in that mimics the langgraph AsyncPostgresSaver async-context-manager
protocol.
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


def _make_async_cm(saver_mock):
    """Build a stand-in that satisfies the async context-manager protocol.

    Mirrors what ``langgraph.checkpoint.postgres.aio.AsyncPostgresSaver
    .from_conn_string(dsn)`` returns — i.e. an object whose ``__aenter__``
    yields the saver and whose ``__aexit__`` releases the connection.
    """
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=saver_mock)
    cm.__aexit__ = AsyncMock(return_value=None)
    return cm


def test_no_dsn_returns_memory_saver():
    saver = cp.get_checkpointer()
    assert isinstance(saver, MemorySaver)
    assert cp._HELD_CMS == []  # no CM held when there's no PG


def test_dsn_set_but_postgres_unreachable_falls_back(monkeypatch):
    """If PG is unreachable, fall back to MemorySaver and log the error."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://nobody@127.0.0.1:1/none")

    # Stub AsyncPostgresSaver.from_conn_string so __aenter__ raises (simulates
    # a connection failure during the CM enter).
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(side_effect=ConnectionRefusedError("no PG here"))
    cm.__aexit__ = AsyncMock(return_value=None)

    with patch(
        "langgraph.checkpoint.postgres.aio.AsyncPostgresSaver.from_conn_string",
        return_value=cm,
    ):
        saver = cp.get_checkpointer()

    assert isinstance(saver, MemorySaver)
    # We should NOT have appended the CM to _HELD_CMS since __aenter__ raised.
    assert cp._HELD_CMS == []


def test_dsn_set_and_pg_reachable_returns_postgres_saver(monkeypatch):
    """Happy path: enter the CM, hold it, return the yielded saver."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    # Simulate the async context manager protocol: __aenter__ returns the
    # saver, which exposes an async setup().
    fake_saver = MagicMock()
    fake_saver.setup = AsyncMock()
    fake_cm = _make_async_cm(fake_saver)

    with patch(
        "langgraph.checkpoint.postgres.aio.AsyncPostgresSaver.from_conn_string",
        return_value=fake_cm,
    ):
        saver = cp.get_checkpointer()

    assert saver is fake_saver
    fake_saver.setup.assert_awaited_once()
    fake_cm.__aenter__.assert_awaited_once()
    # CRITICAL: the CM is held so the connection stays open.
    assert cp._HELD_CMS == [fake_cm]
    # And __aexit__ has NOT been called yet (would close the connection).
    fake_cm.__aexit__.assert_not_awaited()


def test_singleton_means_one_init_per_process(monkeypatch):
    """Repeated get_checkpointer() returns the same instance, no double init."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    fake_saver = MagicMock()
    fake_saver.setup = AsyncMock()
    fake_cm = _make_async_cm(fake_saver)

    with patch(
        "langgraph.checkpoint.postgres.aio.AsyncPostgresSaver.from_conn_string",
        return_value=fake_cm,
    ) as factory:
        a = cp.get_checkpointer()
        b = cp.get_checkpointer()
        c = cp.get_checkpointer()

    assert a is b is c
    factory.assert_called_once()
    fake_saver.setup.assert_awaited_once()
    # Still only one CM held.
    assert len(cp._HELD_CMS) == 1


def test_close_held_cms_calls_aexit(monkeypatch):
    """The atexit hook drains _HELD_CMS by awaiting __aexit__ on each."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    fake_saver = MagicMock()
    fake_saver.setup = AsyncMock()
    fake_cm = _make_async_cm(fake_saver)

    with patch(
        "langgraph.checkpoint.postgres.aio.AsyncPostgresSaver.from_conn_string",
        return_value=fake_cm,
    ):
        cp.get_checkpointer()

    assert cp._HELD_CMS == [fake_cm]

    cp._close_held_cms()

    fake_cm.__aexit__.assert_awaited_once_with(None, None, None)
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
