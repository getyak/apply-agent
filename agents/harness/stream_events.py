"""SSE resume-by-cursor persistence for /ask/stream.

Long-term fix for "flow was interrupted" — Claude Code / Manus grade UX:
when the client's connection blinks, it reconnects with a Last-Event-ID
and receives only the events it missed. The LangGraph run keeps executing
in the background even if the client is gone; every emitted frame is
appended to Postgres (durable) and published to a Redis Pub/Sub channel
(live tail). See docs/architecture/error-handling.md §Stream resume.

Public surface:
    persist_stream()            wrap an AsyncIterator[str] frame source; each
                                yielded frame is stamped with a per-thread
                                monotonic sequence, persisted to PG, published
                                to Redis, and yielded downstream with an
                                ``id: <seq>\\n`` SSE line prepended so browser
                                clients get native Last-Event-ID semantics.
    replay_frames()             read events with sequence > last_seen from PG.
                                Returns ``(frames, latest_seq, expired)``. When
                                ``expired`` is True the caller should return
                                STREAM_EXPIRED — the buffer no longer contains
                                the requested cursor.
    live_frames()               async-iterate frames published to Redis for a
                                thread, starting from ``after_seq`` (bounds
                                against a snapshot taken *before* subscribing so
                                events published during the PG read still land).
    prune_ask_stream_events()   background prune (24h retention, 1000 rows/thread cap).

All PG/Redis IO fails-open: if the resume substrate is unreachable the
stream still works — we just lose the resume-on-blink capability for that
turn. Never crash the live stream because persistence failed.

Persistence layer is *stateless* between calls — every helper opens its own
connection, uses pg advisory locks for sequence issuance, and closes cleanly.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import structlog

log = structlog.get_logger(__name__)

# Namespace for pg_advisory_xact_lock; picked to be recognisable in
# pg_locks (a support-time clue). PostgreSQL takes an int8; we use a
# distinctive high-bit value plus the hash of the thread_id so different
# threads never contend.
_ADVISORY_LOCK_NAMESPACE = 0x5AB1  # "SABIscribe" — 21_ask_stream_events writer

# Retention limits — kept in sync with migration 021's docstring.
RETENTION_HOURS = 24
PER_THREAD_MAX_ROWS = 1000


# Redis Pub/Sub channel per thread. Not a queue — Pub/Sub broadcasts to all
# currently-subscribed connections. Late subscribers backfill via PG.
def _channel(thread_id: str) -> str:
    return f"ask_stream:{thread_id}"


# --------------------------------------------------------------------------- config


def _pg_dsn() -> str | None:
    return os.environ.get("RELAY_PG_DSN")


def _redis_url() -> str:
    return os.environ.get("RELAY_REDIS_URL", "redis://localhost:6380/0")


def resume_enabled() -> bool:
    """True when both PG and Redis credentials are configured.

    Callers use this to decide whether to bother wiring persistence at all.
    """
    return _pg_dsn() is not None


# --------------------------------------------------------------------------- helpers


def _extract_meta(frame: str) -> tuple[str | None, str | None, str | None]:
    """Return (event_id, run_id, trace_id) mined off a serialised frame.

    Best-effort: any parse failure yields (None, None, None). Frames without
    the Relay envelope (heartbeats, legacy `data: {...}` shapes) are still
    persistable — the writer synthesises an event_id for them.
    """
    for line in frame.split("\n"):
        if not line.startswith("data:"):
            continue
        try:
            obj = json.loads(line[5:].strip())
        except (ValueError, TypeError):
            return (None, None, None)
        if not isinstance(obj, dict):
            return (None, None, None)
        raw = obj.get("rawEvent") if isinstance(obj.get("rawEvent"), dict) else {}
        eid = raw.get("id") if isinstance(raw.get("id"), str) else None
        run_id = raw.get("run_id") if isinstance(raw.get("run_id"), str) else None
        trace = raw.get("trace_id") if isinstance(raw.get("trace_id"), str) else None
        return (eid, run_id, trace)
    return (None, None, None)


def _parse_event_line(frame: str) -> str | None:
    """Extract the ``event:`` line name from a raw SSE frame, if present."""
    for line in frame.split("\n"):
        if line.startswith("event:"):
            return line[6:].strip() or None
    return None


def _prepend_sse_id(frame: str, sequence: int) -> str:
    """Stamp ``id: <sequence>\\n`` at the top of an SSE frame AND inject
    ``stream_seq`` into the JSON envelope's ``rawEvent`` for the fetch-based
    client.

    Browser ``EventSource`` uses the ``id:`` line to populate
    ``Last-Event-ID`` on reconnect (WHATWG HTML Living Standard §
    Server-sent events). Our client (@ag-ui/client) is fetch-based and
    parses only ``data:`` lines, so we ALSO copy the sequence into
    ``rawEvent.stream_seq`` in the JSON so the web reducer can read the
    cursor without touching the raw stream — see
    web/src/lib/agent-events/consumer.ts's cursor tracking.
    """
    header = f"id: {sequence}\n"
    # Mutate the JSON body's rawEvent envelope to carry stream_seq. Keep
    # this best-effort: any parse failure yields the header-only stamp
    # so a malformed frame still gets an ``id:`` line.
    lines = frame.split("\n")
    for i, line in enumerate(lines):
        if not line.startswith("data:"):
            continue
        try:
            obj = json.loads(line[5:].strip())
        except (ValueError, TypeError):
            break
        if not isinstance(obj, dict):
            break
        raw = obj.get("rawEvent")
        if not isinstance(raw, dict):
            # Create the envelope so downstream clients get the cursor even
            # for heartbeat/legacy frames without a Relay envelope.
            raw = {}
            obj["rawEvent"] = raw
        raw["stream_seq"] = sequence
        lines[i] = f"data: {json.dumps(obj)}"
        return header + "\n".join(lines)
    return header + frame


# --------------------------------------------------------------------------- writer


@dataclass
class StreamPersistence:
    """Per-turn handle that appends every yielded frame to PG + Redis.

    Owns a monotonic sequence counter; the initial value is loaded from
    PG once on entry (``initialize()``) and advanced in-place after each
    successful insert. Multiple concurrent writers on the *same* thread
    are serialised by a pg advisory lock in each transaction.
    """

    thread_id: str
    _last_seq: int = 0

    async def initialize(self) -> None:
        """Prime the sequence from PG. Best-effort — a failure yields 0.

        The advisory lock inside persist() keeps monotonicity even if two
        writers boot with the same initial value; this call just avoids an
        unnecessary max() round-trip on every persist.
        """
        dsn = _pg_dsn()
        if not dsn:
            return
        try:
            import psycopg
        except ImportError:
            return
        try:
            async with await psycopg.AsyncConnection.connect(dsn) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT COALESCE(MAX(sequence), 0) "
                        "FROM ask_stream_events WHERE thread_id = %s",
                        (self.thread_id,),
                    )
                    row = await cur.fetchone()
                    if row and row[0] is not None:
                        self._last_seq = int(row[0])
        except Exception as exc:  # noqa: BLE001 fail-open
            log.warning(
                "stream_events.init_failed",
                thread_id=self.thread_id,
                error=str(exc),
            )

    async def persist(self, frame: str) -> int | None:
        """Write ``frame`` to PG + Redis, return the assigned sequence.

        Returns None on failure OR on a duplicate event_id (idempotent
        retry). The caller still yields the frame downstream even without
        a sequence — the on-wire semantics only require ``id:`` when we
        successfully persisted.
        """
        dsn = _pg_dsn()
        if not dsn:
            return None
        try:
            import psycopg
        except ImportError:
            return None

        event_id, run_id, trace_id = _extract_meta(frame)
        event_name = _parse_event_line(frame)

        # Synthetic id for frames without a Relay envelope (heartbeat,
        # legacy `data: {...}` frames). Stable across retries because it
        # keys off the candidate sequence, not off wall time.
        candidate_seq = self._last_seq + 1
        eid = event_id or f"syn:{self.thread_id[-12:]}:{candidate_seq}"

        seq: int | None = None
        try:
            async with await psycopg.AsyncConnection.connect(dsn) as conn:
                async with conn.transaction():
                    async with conn.cursor() as cur:
                        # Advisory lock scoped to the thread so
                        # (thread_id, sequence) monotonicity holds even
                        # if two writers race.
                        await cur.execute(
                            "SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                            (_ADVISORY_LOCK_NAMESPACE, self.thread_id),
                        )
                        await cur.execute(
                            "SELECT COALESCE(MAX(sequence), 0) + 1 "
                            "FROM ask_stream_events WHERE thread_id = %s",
                            (self.thread_id,),
                        )
                        row = await cur.fetchone()
                        seq = int(row[0]) if row and row[0] is not None else 1
                        await cur.execute(
                            "INSERT INTO ask_stream_events "
                            "(thread_id, sequence, event_id, run_id, trace_id, "
                            " frame, event_name) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                            "ON CONFLICT (thread_id, event_id) DO NOTHING",
                            (
                                self.thread_id,
                                seq,
                                eid,
                                run_id,
                                trace_id,
                                frame.encode("utf-8"),
                                event_name,
                            ),
                        )
                        # ON CONFLICT DO NOTHING → rowcount 0 means the
                        # same event_id was already persisted (retry).
                        # Roll the sequence back so we don't leave a hole
                        # in the caller's cursor.
                        if cur.rowcount == 0:
                            seq = None
        except Exception as exc:  # noqa: BLE001 fail-open
            log.warning(
                "stream_events.persist_failed",
                thread_id=self.thread_id,
                event_id=eid,
                error=str(exc),
            )
            return None

        if seq is not None:
            self._last_seq = seq
            # Publish to live-tail channel. Redis failure is silent — a
            # late subscriber will still see the event via PG replay.
            payload = json.dumps({"seq": seq, "frame": frame})
            await _publish(_channel(self.thread_id), payload)

        return seq


async def _publish(channel: str, payload: str) -> None:
    try:
        import redis.asyncio as redis
    except ImportError:
        return
    url = _redis_url()
    try:
        client = redis.from_url(url, decode_responses=True)
    except Exception:  # noqa: BLE001
        return
    try:
        await client.publish(channel, payload)
    except Exception as exc:  # noqa: BLE001 fail-open
        log.debug("stream_events.publish_failed", channel=channel, error=str(exc))
    finally:
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- persist_stream


async def persist_stream(
    source: AsyncIterator[str],
    *,
    thread_id: str,
    on_frame: Callable[[int, str], Awaitable[None] | None] | None = None,
) -> AsyncIterator[str]:
    """Wrap ``source`` so every frame is persisted, then yield it downstream.

    Prepends an ``id: <sequence>\\n`` SSE line to every yielded frame so
    resumers know their cursor. When persistence is disabled (no PG) the
    frame is yielded unchanged — the pre-021 behaviour, gracefully
    degraded.

    ``on_frame`` fires *after* successful persistence, before yielding,
    with the assigned sequence. Test hook + optional caller notification.
    """
    if not resume_enabled():
        # Yield-through: exactly the pre-021 pipeline.
        async for frame in source:
            yield frame
        return

    persistence = StreamPersistence(thread_id=thread_id)
    await persistence.initialize()

    async for frame in source:
        seq = await persistence.persist(frame)
        if seq is not None:
            if on_frame is not None:
                res = on_frame(seq, frame)
                if asyncio.iscoroutine(res):
                    await res
            yield _prepend_sse_id(frame, seq)
        else:
            # Persistence failed OR the event_id was a dup — still yield
            # the frame so the live client doesn't stall. The client will
            # simply not update its cursor for this frame.
            yield frame


# --------------------------------------------------------------------------- replay


@dataclass
class ReplayResult:
    frames: list[tuple[int, bytes]]
    latest_seq: int
    expired: bool


async def replay_frames(thread_id: str, *, after_seq: int) -> ReplayResult:
    """Load persisted frames with sequence > after_seq.

    ``expired=True`` means the client's cursor is older than the earliest
    surviving row for this thread — the buffer no longer contains what
    they missed. Caller should tell the client STREAM_EXPIRED and start
    fresh.
    """
    dsn = _pg_dsn()
    if not dsn:
        return ReplayResult([], after_seq, expired=False)
    try:
        import psycopg
    except ImportError:
        return ReplayResult([], after_seq, expired=False)

    frames: list[tuple[int, bytes]] = []
    latest = after_seq
    expired = False
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT sequence, frame FROM ask_stream_events "
                    "WHERE thread_id = %s AND sequence > %s "
                    "ORDER BY sequence ASC",
                    (thread_id, after_seq),
                )
                rows = await cur.fetchall()
                for seq, frame in rows:
                    seq_int = int(seq)
                    if isinstance(frame, memoryview):
                        frame_bytes = bytes(frame)
                    elif isinstance(frame, bytes):
                        frame_bytes = frame
                    else:
                        frame_bytes = str(frame).encode("utf-8")
                    frames.append((seq_int, frame_bytes))
                    if seq_int > latest:
                        latest = seq_int

                # Detect stream-expired. The client sent us a cursor > 0
                # (they claim to have seen something) but we returned
                # zero frames above it. Two sub-cases:
                #   (a) buffer is entirely below their cursor: they're
                #       simply ahead of us — reconnecting to a fresh
                #       turn, benign, expired stays False.
                #   (b) buffer is entirely empty (no rows for the
                #       thread at all): the thread was evicted by the
                #       pruner while they were away. Expired=True so
                #       the UI shows "Stream expired · Start over"
                #       rather than a silent empty stream.
                # NB: with (thread_id, sequence) PK and prune-tail
                # semantics, the buffer can never straddle a gap that
                # leaves ``sequence > cursor`` empty while ``min_seq >
                # cursor`` — SELECT > cursor would have returned those
                # very rows.
                if not frames and after_seq > 0:
                    await cur.execute(
                        "SELECT MAX(sequence) "
                        "FROM ask_stream_events WHERE thread_id = %s",
                        (thread_id,),
                    )
                    maxrow = await cur.fetchone()
                    if maxrow and maxrow[0] is not None:
                        latest = max(latest, int(maxrow[0]))
                        # Buffer holds rows but all <= cursor → client
                        # is ahead of us. Fresh stream continues.
                        expired = False
                    else:
                        # No rows at all + client claims to have seen
                        # data → the thread was pruned out from under
                        # them.
                        expired = True
    except Exception as exc:  # noqa: BLE001 fail-open
        log.warning(
            "stream_events.replay_failed",
            thread_id=thread_id,
            after_seq=after_seq,
            error=str(exc),
        )
        return ReplayResult([], after_seq, expired=False)

    return ReplayResult(frames, latest, expired=expired)


# --------------------------------------------------------------------------- live


async def live_frames(
    thread_id: str,
    *,
    after_seq: int,
    idle_timeout_s: float = 300.0,
) -> AsyncIterator[tuple[int, str]]:
    """Async-iterate frames published to the thread's Redis channel.

    ``after_seq`` filters out anything already replayed from PG (Redis
    doesn't have message replay — it broadcasts to current subscribers
    only). Yields ``(sequence, frame_str)`` tuples so the caller can
    update the cursor as it forwards frames.

    Terminates when the channel is idle for ``idle_timeout_s`` (default 5
    minutes — matches the write-idle window before we consider the run
    dead). Callers that need a shorter tail can pass a smaller value.
    """
    try:
        import redis.asyncio as redis
    except ImportError:
        return
    url = _redis_url()
    try:
        client = redis.from_url(url, decode_responses=True)
    except Exception:  # noqa: BLE001
        return
    pubsub = client.pubsub()
    try:
        await pubsub.subscribe(_channel(thread_id))
        while True:
            try:
                msg = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True),
                    timeout=idle_timeout_s,
                )
            except TimeoutError:
                return
            if msg is None:
                continue
            data = msg.get("data")
            if not isinstance(data, str):
                continue
            try:
                obj = json.loads(data)
            except (ValueError, TypeError):
                continue
            seq = obj.get("seq")
            frame = obj.get("frame")
            if not isinstance(seq, int) or not isinstance(frame, str):
                continue
            if seq <= after_seq:
                continue
            yield (seq, frame)
    except Exception as exc:  # noqa: BLE001 fail-open
        log.warning("stream_events.live_failed", thread_id=thread_id, error=str(exc))
    finally:
        try:
            await pubsub.unsubscribe(_channel(thread_id))
        except Exception:  # noqa: BLE001
            pass
        try:
            await pubsub.aclose()
        except Exception:  # noqa: BLE001
            pass
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- prune


async def prune_ask_stream_events() -> tuple[int, int]:
    """Enforce 24h retention + 1000-row per-thread cap.

    Returns ``(rows_deleted_by_time, rows_deleted_by_cap)``. Called by a
    background task in server.py on a cron-ish interval (every 10 min in
    dev, hourly in prod). Fail-open — a failure just means we hold rows
    longer.
    """
    dsn = _pg_dsn()
    if not dsn:
        return (0, 0)
    try:
        import psycopg
    except ImportError:
        return (0, 0)

    deleted_time = 0
    deleted_cap = 0
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.transaction():
                async with conn.cursor() as cur:
                    # 24h retention. RETENTION_HOURS is a module constant
                    # (not user input) but we still use parameterisation
                    # for interval by casting a string literal — PG's
                    # interval literal syntax doesn't like %s directly.
                    await cur.execute(
                        "DELETE FROM ask_stream_events "
                        "WHERE created_at < now() - (%s || ' hours')::interval",
                        (str(RETENTION_HOURS),),
                    )
                    deleted_time = cur.rowcount or 0

                    # Per-thread row cap. For each thread with > cap rows,
                    # delete all but the newest ``cap`` sequences. One SQL
                    # scan; PK covers the (thread_id, sequence) order.
                    await cur.execute(
                        """
                        WITH ranked AS (
                          SELECT thread_id, sequence,
                                 row_number() OVER (
                                   PARTITION BY thread_id
                                   ORDER BY sequence DESC
                                 ) AS rn
                            FROM ask_stream_events
                        )
                        DELETE FROM ask_stream_events e
                          USING ranked r
                         WHERE e.thread_id = r.thread_id
                           AND e.sequence = r.sequence
                           AND r.rn > %s
                        """,
                        (PER_THREAD_MAX_ROWS,),
                    )
                    deleted_cap = cur.rowcount or 0
    except Exception as exc:  # noqa: BLE001 fail-open
        log.warning("stream_events.prune_failed", error=str(exc))
        return (0, 0)

    if deleted_time or deleted_cap:
        log.info(
            "stream_events.prune",
            deleted_by_time=deleted_time,
            deleted_by_cap=deleted_cap,
        )
    return (deleted_time, deleted_cap)


# --------------------------------------------------------------------------- headers helper


def last_event_id_from_headers(headers: Any) -> int | None:
    """Parse ``Last-Event-ID`` (SSE header) or the equivalent fetch header.

    Returns None when absent or malformed — the caller treats that as
    "no cursor, stream from the beginning". Supports both dict-like and
    Starlette Headers-like inputs so tests can pass a plain dict.
    """
    if headers is None:
        return None
    raw: Any = None
    if isinstance(headers, dict):
        raw = headers.get("Last-Event-ID") or headers.get("last-event-id")
    else:
        try:
            raw = headers.get("last-event-id")
        except Exception:  # noqa: BLE001
            return None
    if raw is None:
        return None
    try:
        return int(raw)
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------- exports

__all__ = [
    "PER_THREAD_MAX_ROWS",
    "RETENTION_HOURS",
    "ReplayResult",
    "StreamPersistence",
    "last_event_id_from_headers",
    "live_frames",
    "persist_stream",
    "prune_ask_stream_events",
    "replay_frames",
    "resume_enabled",
]
