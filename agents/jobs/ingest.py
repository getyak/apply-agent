"""Job ingest entry — pull from public ATS boards and upsert into ``jobs``.

Two ways to run:

  1. **CLI (cron-friendly)**:
     ``python -m agents.jobs.ingest``
     Runs all DEFAULT_BOARDS sequentially and exits with non-zero code if
     any board fully failed (zero rows inserted). Suitable for a Bull / k8s
     CronJob / GitHub Actions scheduled run.

  2. **In-process** (e.g. a startup-time warm-up from server.py lifespan):
     ``await ingest_all(DEFAULT_BOARDS)``

Idempotent: ``jobs`` has ``UNIQUE(source, external_id)`` so re-ingest just
updates the row in place via ``ON CONFLICT … DO UPDATE``. ``is_active``
flips OFF for any row of a refetched source whose external_id was NOT in
this run's batch — that's how we mark "this job was taken down".

Boards are intentionally a small list of canonical AI / fintech / dev tools
companies — these are the firms users are actually applying to. Expand the
list as needed.
"""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from typing import Any

import structlog

from agents.jobs.sources import fetch_ashby, fetch_greenhouse, fetch_lever

log = structlog.get_logger("agents.jobs.ingest")


@dataclass(frozen=True)
class Board:
    source: str  # "greenhouse" | "lever" | "ashby"
    slug: str  # the board url slug
    label: str | None = None  # override company name on display


# Seed boards — start small. Each is a public no-auth endpoint.
# To add: append a Board(...) here. No code changes needed beyond that.
DEFAULT_BOARDS: tuple[Board, ...] = (
    Board("greenhouse", "stripe", "Stripe"),
    Board("greenhouse", "anthropic", "Anthropic"),
    Board("greenhouse", "openai", "OpenAI"),
    Board("greenhouse", "vercel", "Vercel"),
    Board("greenhouse", "github", "GitHub"),
    Board("lever", "linear", "Linear"),
    Board("lever", "ramp", "Ramp"),
    Board("ashby", "ashbyhq", "Ashby"),
    Board("ashby", "posthog", "PostHog"),
)


_DISPATCH = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
}


async def ingest_board(board: Board) -> dict[str, Any]:
    """Pull one board and upsert into PG. Returns a summary dict."""
    fetcher = _DISPATCH.get(board.source)
    if fetcher is None:
        return {
            "board": board.slug,
            "source": board.source,
            "fetched": 0,
            "upserted": 0,
            "error": "unknown_source",
        }

    rows = await fetcher(board.slug)
    if board.label:
        for r in rows:
            r["company"] = board.label

    if not rows:
        return {"board": board.slug, "source": board.source, "fetched": 0, "upserted": 0}

    upserted = await _upsert_jobs(rows)
    deactivated = await _deactivate_missing(
        source=board.source,
        company=board.label or rows[0]["company"],
        present_external_ids=[r["external_id"] for r in rows],
    )
    return {
        "board": board.slug,
        "source": board.source,
        "fetched": len(rows),
        "upserted": upserted,
        "deactivated": deactivated,
    }


async def ingest_all(
    boards: tuple[Board, ...] | list[Board] = DEFAULT_BOARDS,
) -> list[dict[str, Any]]:
    """Run all boards sequentially. Sequential is intentional — we don't want
    to slam the agents process with N parallel HTTP fetches + N PG writers
    when this is a backgrounded cron job."""
    results: list[dict[str, Any]] = []
    for board in boards:
        try:
            summary = await ingest_board(board)
        except Exception as exc:  # noqa: BLE001 — never crash the whole run
            log.error(
                "jobs.ingest_board.crashed",
                slug=board.slug,
                source=board.source,
                error=str(exc),
                kind=type(exc).__name__,
            )
            summary = {
                "board": board.slug,
                "source": board.source,
                "fetched": 0,
                "upserted": 0,
                "error": str(exc),
            }
        results.append(summary)
        log.info("jobs.ingest_board.done", **summary)
    return results


# ─────────────────────────────────────────────────────────────────────
# PG side
# ─────────────────────────────────────────────────────────────────────


_UPSERT_SQL = """
INSERT INTO jobs (
    source, external_id, company, role_title, jd_text, url,
    posted_date, expires_at, parsed, is_active, updated_at
) VALUES (
    %(source)s, %(external_id)s, %(company)s, %(role_title)s, %(jd_text)s, %(url)s,
    %(posted_date)s, %(expires_at)s, %(parsed)s::jsonb, true, now()
)
ON CONFLICT (source, external_id) DO UPDATE SET
    company     = EXCLUDED.company,
    role_title  = EXCLUDED.role_title,
    jd_text     = EXCLUDED.jd_text,
    url         = EXCLUDED.url,
    posted_date = EXCLUDED.posted_date,
    expires_at  = EXCLUDED.expires_at,
    is_active   = true,
    updated_at  = now()
"""


async def _upsert_jobs(rows: list[dict[str, Any]]) -> int:
    """Upsert a batch of normalised job rows. Returns number written.

    Skips when RELAY_PG_DSN is unset (so tests / dry-runs don't crash).
    """
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        log.warning("jobs.upsert.no_dsn", n=len(rows))
        return 0

    import json

    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            for r in rows:
                params = {
                    "source": r["source"],
                    "external_id": r["external_id"],
                    "company": r["company"],
                    "role_title": r["role_title"],
                    "jd_text": r.get("jd_text") or "",
                    "url": r.get("url"),
                    "posted_date": r.get("posted_date"),
                    "expires_at": r.get("expires_at"),
                    "parsed": json.dumps(r.get("parsed") or {}),
                }
                await cur.execute(_UPSERT_SQL, params)
        await conn.commit()
    return len(rows)


async def _deactivate_missing(*, source: str, company: str, present_external_ids: list[str]) -> int:
    """Flip ``is_active=false`` for rows of this source+company NOT in this run.

    This is how we mark "the job was taken down on the upstream board" —
    without it, the jobs table would accumulate stale rows forever.
    """
    if not present_external_ids:
        return 0
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return 0

    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE jobs
                   SET is_active = false, updated_at = now()
                 WHERE source = %s
                   AND company = %s
                   AND is_active = true
                   AND external_id <> ALL(%s::text[])
                """,
                (source, company, present_external_ids),
            )
            deactivated = cur.rowcount or 0
        await conn.commit()
    return deactivated


# ─────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────


def _cli() -> int:
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(20),  # INFO
    )
    summaries = asyncio.run(ingest_all())
    total_upserted = sum(s.get("upserted", 0) for s in summaries)
    total_failed = sum(1 for s in summaries if s.get("error"))
    print(
        f"\n=== ingest summary ===\n"
        f"boards: {len(summaries)}\n"
        f"upserted: {total_upserted}\n"
        f"failed: {total_failed}",
        file=sys.stderr,
    )
    # Exit non-zero only if EVERY board failed — a single board's flake
    # shouldn't fail the cron. Cron supervisor can alert on persistent
    # zero-row runs.
    return 0 if total_upserted > 0 or total_failed < len(summaries) else 1


if __name__ == "__main__":
    sys.exit(_cli())
