"""TTAR — Time-To-Application-Ready measurement.

Caller: agents/coordinator/workflows.py wraps the prepare_application graph in
`async with measure_ttar(application_id) as t:`; each stage node calls
`t.stage("parse_jd_ms", ms)` (or uses `with t.timing("parse_jd_ms"):`) to push
per-stage latencies into the JSONB blob stored on application_drafts.

The north-star metric lives in docs/architecture/delivery-loop-plan.md § 1.

Design notes
------------
- This is a *side-effect* measurement layer. It must never raise into the
  agent loop on its own — DB write failure is logged and swallowed, same
  contract as agents/harness/audit.py.
- We don't write to ttar_metrics on every stage tick: that would mean N+1
  UPDATEs per workflow. Instead we accumulate in-memory and flush once on
  context exit. Eval jobs only need the final shape.
- Stage names are free-form strings keyed by the workflow; the schema in
  migration 014 documents the canonical names (parse_jd_ms / customize_ms /
  cover_ms / form_ms / extension_ms) but the column does not enforce them.

Schema reference: infra/postgres/migrations/014_ttar_metrics.up.sql
"""
from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog

log = structlog.get_logger("agents.ttar")


@dataclass
class TTARRecord:
    """In-flight TTAR accumulator. Flushed to PG on context exit."""

    application_id: UUID
    started_at: float = field(default_factory=time.perf_counter)
    started_at_iso: str = field(
        default_factory=lambda: datetime.now(tz=UTC).isoformat(timespec="seconds")
    )
    stages: dict[str, int] = field(default_factory=dict)
    fabrication_attempts: int = 0
    success: bool = False
    error_message: str | None = None

    # Field-level breakdown for TTAR-quality (populated by the extension after
    # the user reviews). Optional during the prepare phase.
    fields_total: int | None = None
    fields_auto_filled: int | None = None
    fields_ai_filled: int | None = None
    fields_user_edited: int | None = None

    def stage(self, name: str, ms: int) -> None:
        """Record a single stage's latency in milliseconds."""
        # Idempotent on the *latest* write — useful when a stage is retried,
        # the eval gate only cares about the duration of the successful run.
        self.stages[name] = int(ms)

    @contextmanager
    def timing(self, stage_name: str) -> Iterator[None]:
        """Sugar for `t.stage(name, elapsed_ms)` around a block."""
        start = time.perf_counter()
        try:
            yield
        finally:
            self.stage(stage_name, int((time.perf_counter() - start) * 1000))

    def to_jsonb(self) -> dict[str, Any]:
        """Shape that matches migration 014's documented schema."""
        latency_ms = int((time.perf_counter() - self.started_at) * 1000)
        blob: dict[str, Any] = {
            "started_at": self.started_at_iso,
            "completed_at": datetime.now(tz=UTC).isoformat(timespec="seconds"),
            "latency_ms": latency_ms,
            "success": self.success,
            "stages": self.stages,
            "fabrication_attempts": self.fabrication_attempts,
        }
        if self.error_message:
            blob["error"] = self.error_message[:500]  # cap to keep row small
        for key in (
            "fields_total",
            "fields_auto_filled",
            "fields_ai_filled",
            "fields_user_edited",
        ):
            val = getattr(self, key)
            if val is not None:
                blob[key] = val
        return blob


async def _persist(record: TTARRecord) -> None:
    """Best-effort UPDATE of application_drafts.ttar_metrics."""
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        # Local tests / dry runs: skip DB, the record is still observable via
        # the structlog event below (which graphify-able tooling can scrape).
        log.info("ttar.skipped_no_dsn", **record.to_jsonb())
        return

    try:
        import psycopg
    except ImportError:
        log.error("ttar.psycopg_missing")
        return

    sql = """
        UPDATE application_drafts
           SET ttar_metrics = %s::jsonb,
               updated_at   = now()
         WHERE id = %s
    """
    params = (json.dumps(record.to_jsonb(), default=str), str(record.application_id))
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
            await conn.commit()
    except Exception as exc:  # noqa: BLE001 boundary — never block agent return
        log.error("ttar.persist_failed", error=str(exc), application_id=str(record.application_id))


@asynccontextmanager
async def measure_ttar(application_id: UUID):
    """Async context manager: accumulates stage timings, flushes on exit.

    Usage::

        async with measure_ttar(app.id) as t:
            with t.timing("parse_jd_ms"):
                jd = await jobmatch.parse_jd_from_url(url)
            with t.timing("customize_ms"):
                tailored = await resume.customize(base, jd)
            t.fabrication_attempts = customize_attempts
            t.success = True

    On exception the record is still flushed with ``success=False`` and the
    exception message captured — so failed prepares show up in eval gate
    success-rate calculations rather than disappearing.
    """
    record = TTARRecord(application_id=application_id)
    try:
        yield record
    except Exception as exc:
        record.success = False
        record.error_message = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        # Persist synchronously here (not fire-and-forget) because the eval
        # gate reads the row right after the workflow returns. audit.py uses
        # asyncio.create_task because it only feeds dashboards, not gates.
        with contextlib.suppress(Exception):
            await _persist(record)
