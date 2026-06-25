"""Unit tests for agents/harness/checkpointer.py — the PostgresSaver factory.

Locks down the P0-3 fix:
  - No RELAY_PG_DSN env → returns MemorySaver (back-compat)
  - PG unreachable → logged + falls back to MemorySaver (not crash)
  - PostgresSaver.from_conn_string is a context manager: we enter it and
    hold the cm so the connection survives between invocations
  - lru_cache means repeated calls return the same saver (no leak)
  - atexit hook closes held CMs

These tests run hermetically — no real PG. The CM case is exercised
with a stand-in that mimics the langgraph PostgresSaver context-manager
protocol.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from langgraph.checkpoint.memory import MemorySaver

from agents.harness import checkpointer as cp


@pytest.fixture(autouse=True)
def _isolate_dsn(monkeypatch):
    """Clear any inherited RELAY_PG_DSN + flush the lru_cache between tests."""
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    cp.get_checkpointer.cache_clear()
    cp._HELD_CMS.clear()
    yield
    cp.get_checkpointer.cache_clear()
    cp._HELD_CMS.clear()


def test_no_dsn_returns_memory_saver():
    saver = cp.get_checkpointer()
    assert isinstance(saver, MemorySaver)
    assert cp._HELD_CMS == []  # no CM held when there's no PG


def test_dsn_set_but_postgres_unreachable_falls_back(monkeypatch):
    """If PG is unreachable, fall back to MemorySaver and log the error."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://nobody@127.0.0.1:1/none")

    # Stub PostgresSaver.from_conn_string to raise on __enter__ (simulates a
    # connection failure during the CM enter).
    fake_cm = MagicMock()
    fake_cm.__enter__.side_effect = ConnectionRefusedError("no PG here")

    with patch(
        "langgraph.checkpoint.postgres.PostgresSaver.from_conn_string",
        return_value=fake_cm,
    ):
        saver = cp.get_checkpointer()

    assert isinstance(saver, MemorySaver)
    # We should NOT have appended the CM to _HELD_CMS since __enter__ raised.
    assert cp._HELD_CMS == []


def test_dsn_set_and_pg_reachable_returns_postgres_saver(monkeypatch):
    """Happy path: enter the CM, hold it, return the yielded saver."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    # Simulate the context manager protocol: __enter__ returns the saver,
    # which exposes a no-op setup().
    fake_saver = MagicMock()
    fake_saver.setup = MagicMock()
    fake_cm = MagicMock()
    fake_cm.__enter__ = MagicMock(return_value=fake_saver)

    with patch(
        "langgraph.checkpoint.postgres.PostgresSaver.from_conn_string",
        return_value=fake_cm,
    ):
        saver = cp.get_checkpointer()

    assert saver is fake_saver
    fake_saver.setup.assert_called_once()
    fake_cm.__enter__.assert_called_once()
    # CRITICAL: the CM is held so the connection stays open.
    assert cp._HELD_CMS == [fake_cm]
    # And __exit__ has NOT been called yet (would close the connection).
    fake_cm.__exit__.assert_not_called()


def test_lru_cache_means_one_init_per_process(monkeypatch):
    """Repeated get_checkpointer() returns the same instance, no double init."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    fake_saver = MagicMock()
    fake_saver.setup = MagicMock()
    fake_cm = MagicMock()
    fake_cm.__enter__ = MagicMock(return_value=fake_saver)

    with patch(
        "langgraph.checkpoint.postgres.PostgresSaver.from_conn_string",
        return_value=fake_cm,
    ) as factory:
        a = cp.get_checkpointer()
        b = cp.get_checkpointer()
        c = cp.get_checkpointer()

    assert a is b is c
    factory.assert_called_once()
    fake_saver.setup.assert_called_once()
    # Still only one CM held.
    assert len(cp._HELD_CMS) == 1


def test_close_held_cms_calls_exit(monkeypatch):
    """The atexit hook drains _HELD_CMS by calling __exit__ on each."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@localhost:5433/relay")

    fake_saver = MagicMock()
    fake_cm = MagicMock()
    fake_cm.__enter__ = MagicMock(return_value=fake_saver)

    with patch(
        "langgraph.checkpoint.postgres.PostgresSaver.from_conn_string",
        return_value=fake_cm,
    ):
        cp.get_checkpointer()

    assert cp._HELD_CMS == [fake_cm]

    cp._close_held_cms()

    fake_cm.__exit__.assert_called_once_with(None, None, None)
    assert cp._HELD_CMS == []


def test_thread_id_helpers_unchanged():
    """Sanity: P0-3 must NOT change thread_id naming (would break HITL resume)."""
    u = "00000000-0000-0000-0000-000000000001"
    s = "00000000-0000-0000-0000-000000000002"
    r = "00000000-0000-0000-0000-000000000003"

    assert cp.ask_vantage_thread_id(u) == f"ask_vantage:{u}"
    assert cp.mock_thread_id(s) == f"mock:{s}"
    assert cp.build_resume_thread_id(u, s) == f"build_resume:{u}:{s}"
    assert cp.resume_studio_thread_id(u, r) == f"resume_studio:{u}:{r}"
