"""Unit tests for agents/harness/stream_events.py.

Covers three angles:

  1. Pure helpers (_extract_meta, _parse_event_line, _prepend_sse_id,
     last_event_id_from_headers) — no IO, run everywhere.
  2. PG round-trip: writer → replay. Uses the real local PG (relay-postgres
     container on :5433) when RELAY_PG_DSN is set; skipped otherwise so CI
     without infra still passes collection.
  3. Redis Pub/Sub live tail: two coroutines — one persists, one live-tails
     — assert the tail sees only events past the cursor.

All PG-touching tests share a per-thread namespace (thread_id includes a
uuid) so they never collide with real data or with each other in parallel.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest

from agents.harness.stream_events import (
    PER_THREAD_MAX_ROWS,
    ReplayResult,
    StreamPersistence,
    _extract_meta,
    _parse_event_line,
    _prepend_sse_id,
    last_event_id_from_headers,
    live_frames,
    persist_stream,
    prune_ask_stream_events,
    replay_frames,
    resume_enabled,
)

_HAS_PG = bool(os.environ.get("RELAY_PG_DSN"))
requires_pg = pytest.mark.skipif(not _HAS_PG, reason="no local RELAY_PG_DSN")


def _agui_frame(*, seq_hint: int = 1, ulid: str | None = None, run_id: str = "run_x") -> str:
    """Build a realistic AG-UI SSE frame (matches RelayEmitter.emit output)."""
    envelope = {
        "id": ulid or f"01HZ4S7X8N2M9P3Q{seq_hint:04X}",
        "seq": seq_hint,
        "trace_id": "7bd33291-b161-4ec2-bdeb-cf05739dcc55",
        "run_id": run_id,
        "thread_id": "ask_vantage:test",
        "protocol_version": "agui-0.1.19+relay-1",
    }
    body = {
        "type": "TEXT_MESSAGE_CONTENT",
        "messageId": f"msg_{seq_hint}",
        "delta": f"chunk_{seq_hint}",
        "rawEvent": envelope,
    }
    return f"data: {json.dumps(body)}\n\n"


# --------------------------------------------------------------------------- helpers


def test_extract_meta_pulls_relay_envelope():
    frame = _agui_frame(seq_hint=7, ulid="01HZAAAAAAAAAAAAAAAAAAAAAA")
    eid, run_id, trace_id = _extract_meta(frame)
    assert eid == "01HZAAAAAAAAAAAAAAAAAAAAAA"
    assert run_id == "run_x"
    assert trace_id == "7bd33291-b161-4ec2-bdeb-cf05739dcc55"


def test_extract_meta_handles_heartbeat():
    frame = "event: heartbeat\ndata: {}\n\n"
    eid, run_id, trace_id = _extract_meta(frame)
    assert (eid, run_id, trace_id) == (None, None, None)


def test_extract_meta_handles_malformed_json():
    frame = "data: {not: valid, json:\n\n"
    assert _extract_meta(frame) == (None, None, None)


def test_parse_event_line_reads_heartbeat():
    assert _parse_event_line("event: heartbeat\ndata: {}\n\n") == "heartbeat"
    assert _parse_event_line("data: {}\n\n") is None


def test_prepend_sse_id_stamps_id_line():
    original = "data: {}\n\n"
    stamped = _prepend_sse_id(original, 42)
    assert stamped.startswith("id: 42\n")
    # For frames without a rawEvent envelope we inject a fresh one so
    # the client can read stream_seq without a special case.
    assert "\"stream_seq\": 42" in stamped or '"stream_seq":42' in stamped


def test_prepend_sse_id_injects_stream_seq_into_rawEvent():
    original = 'data: {"type":"TEXT","rawEvent":{"id":"u1","run_id":"r1"}}\n\n'
    stamped = _prepend_sse_id(original, 7)
    assert stamped.startswith("id: 7\n")
    assert '"stream_seq": 7' in stamped or '"stream_seq":7' in stamped
    # Existing envelope fields survive.
    assert '"id": "u1"' in stamped or '"id":"u1"' in stamped
    assert '"run_id": "r1"' in stamped or '"run_id":"r1"' in stamped


def test_prepend_sse_id_malformed_json_is_header_only():
    original = "data: {not-valid\n\n"
    stamped = _prepend_sse_id(original, 5)
    assert stamped.startswith("id: 5\n")
    # No stream_seq injection when we couldn't parse.
    assert "stream_seq" not in stamped


def test_last_event_id_from_headers_reads_both_cases():
    assert last_event_id_from_headers({"Last-Event-ID": "17"}) == 17
    assert last_event_id_from_headers({"last-event-id": "3"}) == 3
    assert last_event_id_from_headers({}) is None
    assert last_event_id_from_headers({"last-event-id": "not-int"}) is None
    assert last_event_id_from_headers(None) is None


def test_resume_enabled_gated_on_dsn(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RELAY_PG_DSN", "postgres://x")
    assert resume_enabled() is True
    monkeypatch.delenv("RELAY_PG_DSN")
    assert resume_enabled() is False


# --------------------------------------------------------------------------- PG round-trip


@requires_pg
@pytest.mark.asyncio
async def test_persist_then_replay_returns_missed_frames():
    tid = f"ask_vantage:test:{uuid.uuid4()}"
    p = StreamPersistence(thread_id=tid)
    await p.initialize()
    seq1 = await p.persist(_agui_frame(seq_hint=1, ulid=f"01U{uuid.uuid4().hex[:24].upper()}"))
    seq2 = await p.persist(_agui_frame(seq_hint=2, ulid=f"01U{uuid.uuid4().hex[:24].upper()}"))
    seq3 = await p.persist(_agui_frame(seq_hint=3, ulid=f"01U{uuid.uuid4().hex[:24].upper()}"))
    assert (seq1, seq2, seq3) == (1, 2, 3)

    # Client saw up to seq1; replay from cursor=1 → returns 2 and 3.
    result = await replay_frames(tid, after_seq=1)
    assert isinstance(result, ReplayResult)
    assert result.expired is False
    assert [s for s, _ in result.frames] == [2, 3]
    assert result.latest_seq == 3

    # Client at the tip: no frames, not expired.
    tip = await replay_frames(tid, after_seq=3)
    assert tip.frames == []
    assert tip.expired is False


@requires_pg
@pytest.mark.asyncio
async def test_duplicate_event_id_is_idempotent():
    """Persisting the same event_id twice yields sequence None the second time."""
    tid = f"ask_vantage:test:{uuid.uuid4()}"
    ulid = f"01DUP{uuid.uuid4().hex[:22].upper()}"
    p = StreamPersistence(thread_id=tid)
    seq_first = await p.persist(_agui_frame(seq_hint=1, ulid=ulid))
    seq_dup = await p.persist(_agui_frame(seq_hint=1, ulid=ulid))
    assert seq_first == 1
    assert seq_dup is None


@requires_pg
@pytest.mark.asyncio
async def test_replay_partial_prune_still_serves_client():
    """Straddling prune: buffer keeps some rows > cursor → client gets them.

    Contract: expired only fires when the buffer has zero rows AND the
    client claims a > 0 cursor. Prefer to hand over surviving frames so
    the reducer heals via run_id resets.
    """
    tid = f"ask_vantage:test:{uuid.uuid4()}"
    p = StreamPersistence(thread_id=tid)
    for i in range(1, 4):
        await p.persist(_agui_frame(seq_hint=i, ulid=f"01EX{uuid.uuid4().hex[:24].upper()}"))

    import psycopg

    dsn = os.environ["RELAY_PG_DSN"]
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            # Drop rows 1 and 2 — simulate a prune.
            await cur.execute(
                "DELETE FROM ask_stream_events WHERE thread_id = %s AND sequence <= 2",
                (tid,),
            )
        await conn.commit()

    r = await replay_frames(tid, after_seq=1)
    assert [s for s, _ in r.frames] == [3]
    assert r.expired is False


@requires_pg
@pytest.mark.asyncio
async def test_replay_expired_when_buffer_fully_evicted():
    """The narrow expired path: cursor > 0 AND buffer is empty."""
    tid = f"ask_vantage:test:{uuid.uuid4()}"
    # Client claims to have seen events (cursor=5) but the thread has
    # never been persisted OR was fully evicted — no rows exist.
    r = await replay_frames(tid, after_seq=5)
    assert r.frames == []
    assert r.expired is True

    # Sanity: fresh client (cursor=0) is NOT expired even on an empty
    # buffer — that's just "you haven't started yet".
    r_fresh = await replay_frames(tid, after_seq=0)
    assert r_fresh.frames == []
    assert r_fresh.expired is False


@requires_pg
@pytest.mark.asyncio
async def test_replay_client_ahead_is_not_expired():
    """Cursor > buffer max is benign — client reconnects to a fresh turn."""
    tid = f"ask_vantage:test:{uuid.uuid4()}"
    p = StreamPersistence(thread_id=tid)
    await p.persist(_agui_frame(seq_hint=1, ulid=f"01AH{uuid.uuid4().hex[:24].upper()}"))
    # Client cursor=99 → nothing > 99, buffer has [1] → NOT expired.
    r = await replay_frames(tid, after_seq=99)
    assert r.frames == []
    assert r.expired is False


@requires_pg
@pytest.mark.asyncio
async def test_persist_stream_stamps_id_line():
    """The wrapper yields frames prepended with ``id: <seq>`` for the client."""
    tid = f"ask_vantage:test:{uuid.uuid4()}"

    async def source():
        yield _agui_frame(seq_hint=1, ulid=f"01WR{uuid.uuid4().hex[:24].upper()}")
        yield _agui_frame(seq_hint=2, ulid=f"01WR{uuid.uuid4().hex[:24].upper()}")

    out = []
    async for chunk in persist_stream(source(), thread_id=tid):
        out.append(chunk)
    assert out[0].startswith("id: 1\n")
    assert out[1].startswith("id: 2\n")


# --------------------------------------------------------------------------- live tail


@requires_pg
@pytest.mark.asyncio
async def test_live_frames_delivers_post_cursor_events():
    """Redis Pub/Sub tail sees events published after subscribe."""
    tid = f"ask_vantage:test:{uuid.uuid4()}"

    async def consumer_task():
        received: list[tuple[int, str]] = []
        async for seq, frame in live_frames(tid, after_seq=0, idle_timeout_s=2.0):
            received.append((seq, frame))
            if len(received) >= 2:
                break
        return received

    async def producer_task():
        # Give the consumer a moment to subscribe.
        await asyncio.sleep(0.2)
        p = StreamPersistence(thread_id=tid)
        await p.persist(_agui_frame(seq_hint=1, ulid=f"01LT{uuid.uuid4().hex[:24].upper()}"))
        await p.persist(_agui_frame(seq_hint=2, ulid=f"01LT{uuid.uuid4().hex[:24].upper()}"))

    consumer, _producer = await asyncio.gather(consumer_task(), producer_task())
    assert [s for s, _ in consumer] == [1, 2]


# --------------------------------------------------------------------------- prune


@requires_pg
@pytest.mark.asyncio
async def test_prune_is_a_noop_when_under_limits():
    tid = f"ask_vantage:test:{uuid.uuid4()}"
    p = StreamPersistence(thread_id=tid)
    for i in range(1, 6):
        await p.persist(_agui_frame(seq_hint=i, ulid=f"01PR{uuid.uuid4().hex[:24].upper()}"))
    deleted_time, deleted_cap = await prune_ask_stream_events()
    assert deleted_time >= 0 and deleted_cap >= 0
    r = await replay_frames(tid, after_seq=0)
    assert [s for s, _ in r.frames] == [1, 2, 3, 4, 5]


def test_prune_constants_are_documented():
    """Guard: any change to these constants must land in mig 021 docstring too."""
    assert PER_THREAD_MAX_ROWS == 1000
    from agents.harness.stream_events import RETENTION_HOURS

    assert RETENTION_HOURS == 24
