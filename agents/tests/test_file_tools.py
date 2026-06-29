"""Unit tests for agents.tools.file.edit_resume_bullet — mock DB + event sink.

PR4 acceptance:
  - emits relay.file_edit.preview BEFORE writing, relay.file_edit AFTER
  - resolves a bullet by its stable id (bullet_index path)
  - refuses to edit an original-track résumé (017 immutability)
  - missing résumé / unresolvable bullet → structured error, no crash
"""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import pytest

import agents.tools.file as filetool
from agents.harness import events

# ── fakes ────────────────────────────────────────────────────────────────


class _FakeCursor:
    def __init__(self, rowcount: int = 1) -> None:
        self.rowcount = rowcount
        self.executed: list[tuple[str, tuple]] = []

    async def execute(self, sql: str, params: tuple) -> None:
        self.executed.append((sql, params))

    async def __aenter__(self) -> _FakeCursor:
        return self

    async def __aexit__(self, *a) -> None:
        return None


class _FakeConn:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor
        self.committed = False

    def cursor(self, *a, **k) -> _FakeCursor:
        return self._cursor

    async def commit(self) -> None:
        self.committed = True

    async def __aenter__(self) -> _FakeConn:
        return self

    async def __aexit__(self, *a) -> None:
        return None


@pytest.fixture
def sink():
    frames: list[str] = []
    em = events.RelayEmitter(run_id="r1", thread_id="t1", trace_id="trace-1")
    tokens = events.bind_custom_sink(em, frames.append)
    yield frames
    events.reset_custom_sink(tokens)


def _names_and_values(frames: list[str]) -> list[tuple[str, Any]]:
    out = []
    for f in frames:
        obj = json.loads(f[len("data: ") : -2])
        if obj.get("type") == "CUSTOM":
            out.append((obj["name"], obj["value"]))
    return out


def _resume_record(track: str = "optimized") -> dict[str, Any]:
    bid = "b_abc12345"
    parsed = {
        "work": [{"name": "Acme", "highlights": ["Led the migration to Postgres", "Other line"]}]
    }
    return {
        "id": str(uuid4()),
        "content": {"parsed": parsed},
        "track": track,
        "bullet_index": {
            bid: {
                "path": "work.0.highlights.0",
                "text_hash": "x",
                "anchor_text": "Led the migration to Postgres",
            }
        },
        "version": 3,
    }


def _patch_db(monkeypatch, record: dict[str, Any] | None, *, rowcount: int = 1) -> _FakeCursor:
    async def fake_get_resume(resume_id, user_id):  # noqa: ANN001
        return record

    cursor = _FakeCursor(rowcount=rowcount)
    monkeypatch.setattr(filetool, "get_resume", fake_get_resume)
    monkeypatch.setattr(filetool, "_dsn", lambda: "postgresql://fake")

    async def fake_connect(*a, **k):  # noqa: ANN001
        return _FakeConn(cursor)

    monkeypatch.setattr(filetool.psycopg.AsyncConnection, "connect", fake_connect)
    return cursor


# ── happy path ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_edit_emits_preview_then_final(monkeypatch, sink) -> None:
    rec = _resume_record()
    cursor = _patch_db(monkeypatch, rec)

    result = await filetool.edit_resume_bullet(
        resume_id=uuid4(),
        user_id=uuid4(),
        bullet_id="b_abc12345",
        new_text="Owned the Postgres migration end to end",
    )

    assert result["status"] == "ok"
    evts = _names_and_values(sink)
    # order matters: preview BEFORE final
    assert [n for n, _ in evts] == ["relay.file_edit.preview", "relay.file_edit"]

    preview = evts[0][1]
    assert preview["before"] == "Led the migration to Postgres"
    assert preview["after"] == "Owned the Postgres migration end to end"

    final = evts[1][1]
    assert final["applied"] is True
    assert final["hunks"][0]["after"] == "Owned the Postgres migration end to end"

    # DB write actually ran with the new bullet inside content
    assert cursor.executed, "expected an UPDATE"
    written = cursor.executed[0][1][0]
    assert "Owned the Postgres migration end to end" in written


@pytest.mark.asyncio
async def test_preview_emitted_before_db_write(monkeypatch, sink) -> None:
    """Guard the ordering invariant: preview must fire before the row changes."""
    rec = _resume_record()

    order: list[str] = []

    async def fake_get_resume(resume_id, user_id):  # noqa: ANN001
        return rec

    monkeypatch.setattr(filetool, "get_resume", fake_get_resume)
    monkeypatch.setattr(filetool, "_dsn", lambda: "postgresql://fake")

    cursor = _FakeCursor()
    orig_execute = cursor.execute

    async def tracking_execute(sql, params):  # noqa: ANN001
        order.append("db_write")
        await orig_execute(sql, params)

    cursor.execute = tracking_execute  # type: ignore[method-assign]

    async def fake_connect(*a, **k):  # noqa: ANN001
        return _FakeConn(cursor)

    monkeypatch.setattr(filetool.psycopg.AsyncConnection, "connect", fake_connect)

    em = events.RelayEmitter(run_id="r", thread_id="t", trace_id="tr")

    def tracking_sink(frame: str) -> None:
        obj = json.loads(frame[len("data: ") : -2])
        if obj.get("name") == "relay.file_edit.preview":
            order.append("preview")
        sink.append(frame)

    tokens = events.bind_custom_sink(em, tracking_sink)
    try:
        await filetool.edit_resume_bullet(
            resume_id=uuid4(), user_id=uuid4(), bullet_id="b_abc12345", new_text="New bullet"
        )
    finally:
        events.reset_custom_sink(tokens)

    assert order.index("preview") < order.index("db_write")


# ── refusals / errors ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_original_track_is_refused(monkeypatch, sink) -> None:
    rec = _resume_record(track="original")
    _patch_db(monkeypatch, rec)
    result = await filetool.edit_resume_bullet(
        resume_id=uuid4(), user_id=uuid4(), bullet_id="b_abc12345", new_text="x"
    )
    assert result["status"] == "error"
    assert result["reason"] == "original_immutable"
    assert sink == []  # no preview, no write


@pytest.mark.asyncio
async def test_resume_not_found(monkeypatch, sink) -> None:
    _patch_db(monkeypatch, None)
    result = await filetool.edit_resume_bullet(
        resume_id=uuid4(), user_id=uuid4(), bullet_id="b_abc12345", new_text="x"
    )
    assert result["status"] == "error"
    assert result["reason"] == "resume_not_found"
    assert sink == []


@pytest.mark.asyncio
async def test_unknown_bullet_id(monkeypatch, sink) -> None:
    rec = _resume_record()
    _patch_db(monkeypatch, rec)
    result = await filetool.edit_resume_bullet(
        resume_id=uuid4(), user_id=uuid4(), bullet_id="b_nope", new_text="x"
    )
    assert result["status"] == "error"
    assert result["reason"] == "bullet_not_found"
    assert sink == []
