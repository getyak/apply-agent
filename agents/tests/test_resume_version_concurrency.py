"""Integration tests for migration 016 — atomic per-user resume versioning.

Runs against the real PG container (RELAY_PG_DSN). Skipped without it so unit
CI stays hermetic. Mark `integration` aligns with agents/pyproject.toml line
75-76 and the integration job in .github/workflows/ci.yml.

What this locks down:
- 20 concurrent INSERTs for the SAME user → all succeed, versions are the
  set {1..20}, no UNIQUE(user_id, version) collisions. This is the exact
  failure mode the user hit during onboarding:
    "duplicate key value violates unique constraint resumes_user_id_version_key"
- Concurrent INSERTs across DIFFERENT users do not block each other (the
  per-user advisory lock must not become a global lock).
- save_resume_version() returns the trigger-assigned version, not 0 or NULL.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any

import psycopg
import pytest

pytestmark = pytest.mark.integration


def _dsn() -> str:
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        pytest.skip("RELAY_PG_DSN unset - integration test requires real PG")
    return dsn


async def _make_user(dsn: str, user_id: uuid.UUID, email: str) -> None:
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                (str(user_id), email),
            )
        await conn.commit()


async def _purge_user(dsn: str, user_id: uuid.UUID) -> None:
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            # ON DELETE CASCADE on resumes.user_id removes the rows for us,
            # but be explicit so an aborted prior run can't leave orphans.
            await cur.execute("DELETE FROM resumes WHERE user_id = %s", (str(user_id),))
            await cur.execute("DELETE FROM users WHERE id = %s", (str(user_id),))
        await conn.commit()


async def _insert_row(
    dsn: str, user_id: uuid.UUID, content: dict[str, Any], version: int = 0
) -> int:
    """Direct INSERT bypassing save_resume_version so this test exercises the
    trigger itself, not just the Python wrapper. Returns assigned version."""
    import json

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO resumes (user_id, version, content, is_base)
                VALUES (%s, %s, %s, false)
                RETURNING version
                """,
                (str(user_id), version, json.dumps(content)),
            )
            row = await cur.fetchone()
        await conn.commit()
        assert row is not None
        return int(row[0])


async def test_concurrent_inserts_same_user_no_collisions():
    """20 concurrent INSERTs for the same user must produce versions {1..20}.

    Pre-016 this would fail with 23505 because every coroutine reads the same
    MAX(version) before any commits."""
    dsn = _dsn()
    user_id = uuid.uuid4()
    await _make_user(dsn, user_id, f"concurrency-{user_id}@test.local")
    try:
        results = await asyncio.gather(
            *(_insert_row(dsn, user_id, {"i": i}) for i in range(20)),
            return_exceptions=True,
        )
        # No exception should escape the trigger path.
        for r in results:
            assert not isinstance(r, BaseException), f"unexpected error: {r!r}"
        versions = sorted(int(v) for v in results)  # type: ignore[arg-type]
        assert versions == list(range(1, 21)), f"got non-contiguous versions: {versions}"
    finally:
        await _purge_user(dsn, user_id)


async def test_concurrent_inserts_across_users_dont_block():
    """Per-user advisory lock must not serialise across users.

    We can't prove non-blocking timing reliably in a unit test, but we CAN
    prove correctness: 5 users x 5 concurrent inserts each = 25 inserts, each
    user's versions land as {1..5} regardless of interleaving."""
    dsn = _dsn()
    users = [uuid.uuid4() for _ in range(5)]
    for i, u in enumerate(users):
        await _make_user(dsn, u, f"cross-user-{i}-{u}@test.local")
    try:
        coros = []
        for u in users:
            for i in range(5):
                coros.append(_insert_row(dsn, u, {"u": str(u), "i": i}))
        await asyncio.gather(*coros)

        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                for u in users:
                    await cur.execute(
                        "SELECT version FROM resumes WHERE user_id = %s ORDER BY version",
                        (str(u),),
                    )
                    rows = await cur.fetchall()
                    versions = [int(r[0]) for r in rows]
                    assert versions == [1, 2, 3, 4, 5], (
                        f"user {u} got versions {versions}, expected [1..5]"
                    )
    finally:
        for u in users:
            await _purge_user(dsn, u)


async def test_save_resume_version_returns_trigger_assigned_version():
    """The save_resume_version wrapper must surface the trigger-assigned
    version via RETURNING, not echo the input 0."""
    from agents.tools.notify import save_resume_version

    dsn = _dsn()
    user_id = uuid.uuid4()
    await _make_user(dsn, user_id, f"wrapper-{user_id}@test.local")
    try:
        new_id, version = await save_resume_version(
            user_id=user_id,
            content_json={"basics": {"name": "Concurrency Test"}},
            parent_version_id=None,
            tailored_for_job=None,
            is_base=True,
        )
        assert isinstance(new_id, uuid.UUID)
        assert version == 1, f"expected v1 for first save, got {version}"

        # Second save through the Python wrapper appends a NEW row at v2
        # (Python path doesn't UPDATE-in-place; only the TS re-upload path
        # does that, and it has its own test in api/).
        _, version2 = await save_resume_version(
            user_id=user_id,
            content_json={"basics": {"name": "Second"}},
            parent_version_id=new_id,
            tailored_for_job=None,
            is_base=False,
        )
        assert version2 == 2, f"expected v2 for second save, got {version2}"
    finally:
        await _purge_user(dsn, user_id)
