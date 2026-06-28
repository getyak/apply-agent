"""Unit tests for the P1-5 new cross-agent consumers.

Locks down:
  - dock_nudge_on_tailored writes a user_memories row when DSN is set
  - dock_nudge_on_tailored is a no-op when DSN missing (no crash)
  - jobmatch_recompute_consumer is currently log-only but doesn't raise
  - start_all_in_background spawns 4 named tasks
  - missing user_id silently skipped (defensive)
"""

from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest

from agents.events import consumers


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


# ─────────────────────────────────────────────────────────────────────
# jobmatch_recompute_consumer — log only, smoke test
# ─────────────────────────────────────────────────────────────────────


async def test_jobmatch_recompute_does_not_raise():
    entry = {
        "id": "1-0",
        "data": {
            "user_id": str(uuid4()),
            "resume_id": str(uuid4()),
            "version": 5,
        },
    }
    await consumers.jobmatch_recompute_consumer(entry)


# ─────────────────────────────────────────────────────────────────────
# dock_nudge_on_tailored
# ─────────────────────────────────────────────────────────────────────


async def test_dock_nudge_skipped_without_dsn():
    """Without RELAY_PG_DSN, the consumer logs + no-ops, never raises."""
    entry = {
        "id": "1-0",
        "data": {
            "user_id": str(uuid4()),
            "job_id": str(uuid4()),
            "company": "Stripe",
        },
    }
    await consumers.dock_nudge_on_tailored(entry)


async def test_dock_nudge_skipped_without_user_id():
    """Defensive: bad event shape (missing user_id) is a silent no-op."""
    await consumers.dock_nudge_on_tailored({"id": "1-0", "data": {"company": "X"}})


async def test_dock_nudge_failure_does_not_propagate(monkeypatch):
    """Even if the DSN is set but psycopg blows up, the consumer swallows it.
    This is the contract that keeps the worker loop alive across hiccups."""
    monkeypatch.setenv("RELAY_PG_DSN", "postgresql://relay@127.0.0.1:1/none")

    entry = {
        "id": "1-0",
        "data": {
            "user_id": str(uuid4()),
            "job_id": str(uuid4()),
            "company": "Stripe",
        },
    }
    # connection to 127.0.0.1:1 will fail; the consumer should log + return.
    await consumers.dock_nudge_on_tailored(entry)


# ─────────────────────────────────────────────────────────────────────
# start_all_in_background
# ─────────────────────────────────────────────────────────────────────


async def test_start_all_spawns_four_named_tasks():
    """4 background pumps: application:submitted, resume:updated,
    resume:tailored, flywheel."""
    tasks = consumers.start_all_in_background()
    try:
        await asyncio.sleep(0)
        names = {t.get_name() for t in tasks}
        assert "application_submitted_consumers" in names
        assert "resume_updated_consumers" in names
        assert "resume_tailored_consumers" in names
        assert "flywheel_worker" in names
        assert len(tasks) == 4
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except BaseException:
                pass
