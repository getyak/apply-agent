"""Public ATS feed fetchers — Greenhouse / Lever / Ashby.

Each fetcher is a single coroutine ``fetch_{source}(board_slug)`` that
returns a list of normalised dicts ready for upsert into ``jobs``:

    {
      "source":      "greenhouse" | "lever" | "ashby",
      "external_id": str,
      "company":     str,
      "role_title":  str,
      "jd_text":     str,
      "url":         str,
      "posted_date": datetime | None,
      "expires_at":  None,
      "parsed":      {} (filled in by jobmatch_agent.parse_jd, not here),
    }

Why only public, no-auth endpoints:
  We have a hard product red line (vision.md) — do NOT touch authenticated
  job-board APIs. Greenhouse/Lever/Ashby publish the same data for their
  customer boards via documented JSON endpoints; we hit those.

Adding a new source: write a fetcher coroutine + register its slug in
ingest.DEFAULT_BOARDS. Schema-unique on (source, external_id) makes
re-runs idempotent.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from html import unescape
from typing import Any

import httpx
import structlog

log = structlog.get_logger("agents.jobs.sources")

_FETCH_TIMEOUT_S = 15.0
_JD_TEXT_CAP_CHARS = 30_000


def _strip_html(html: str) -> str:
    """Same lightweight HTML→text used by tools/web.py but inlined to avoid
    importing that whole module here (dock-only use case)."""
    body = re.sub(
        r"<(script|style|noscript)[^>]*>.*?</\1>",
        " ",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    body = re.sub(r"<[^>]+>", " ", body)
    body = unescape(body)
    body = re.sub(r"\s+", " ", body).strip()
    return body[:_JD_TEXT_CAP_CHARS]


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except (ValueError, TypeError):
        return None


def _parse_epoch_ms(ms: int | None) -> datetime | None:
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(int(ms) / 1000.0, tz=UTC)
    except (ValueError, TypeError, OSError):
        return None


# ─────────────────────────────────────────────────────────────────────
# Greenhouse — https://developers.greenhouse.io/job-board.html
# ─────────────────────────────────────────────────────────────────────

GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"


async def fetch_greenhouse(board_slug: str) -> list[dict[str, Any]]:
    """Fetch all jobs from a Greenhouse public board. Idempotent.

    ``board_slug`` is the URL slug — e.g. "stripe" for boards.greenhouse.io/stripe.
    Endpoint returns ``{jobs: [{id, title, absolute_url, updated_at, content, …}]}``
    with ``content=true`` query for the HTML JD body.
    """
    url = GREENHOUSE_API.format(slug=board_slug)
    try:
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S) as client:
            resp = await client.get(url, params={"content": "true"})
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        log.warning("jobs.fetch_greenhouse.http_failed", slug=board_slug, error=str(exc))
        return []
    except Exception as exc:  # noqa: BLE001 — defensive
        log.warning(
            "jobs.fetch_greenhouse.failed",
            slug=board_slug,
            error=str(exc),
            kind=type(exc).__name__,
        )
        return []

    rows: list[dict[str, Any]] = []
    for j in data.get("jobs", []):
        gh_id = j.get("id")
        if gh_id is None:
            continue
        title = (j.get("title") or "").strip()
        if not title:
            continue
        company = board_slug.replace("-", " ").title()
        rows.append(
            {
                "source": "greenhouse",
                "external_id": str(gh_id),
                "company": company,
                "role_title": title,
                "jd_text": _strip_html(j.get("content") or ""),
                "url": j.get("absolute_url"),
                "posted_date": _parse_iso(j.get("updated_at")),
                "expires_at": None,
                "parsed": {},
            }
        )
    log.info("jobs.fetch_greenhouse.ok", slug=board_slug, count=len(rows))
    return rows


# ─────────────────────────────────────────────────────────────────────
# Lever — https://github.com/lever/postings-api
# ─────────────────────────────────────────────────────────────────────

LEVER_API = "https://api.lever.co/v0/postings/{slug}"


async def fetch_lever(board_slug: str) -> list[dict[str, Any]]:
    """Lever's public postings JSON. Returns a list of posting dicts."""
    url = LEVER_API.format(slug=board_slug)
    try:
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S) as client:
            resp = await client.get(url, params={"mode": "json"})
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        log.warning("jobs.fetch_lever.http_failed", slug=board_slug, error=str(exc))
        return []
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "jobs.fetch_lever.failed",
            slug=board_slug,
            error=str(exc),
            kind=type(exc).__name__,
        )
        return []

    if not isinstance(data, list):
        return []
    rows: list[dict[str, Any]] = []
    for p in data:
        ext_id = p.get("id") or p.get("lever_id")
        if not ext_id:
            continue
        title = (p.get("text") or "").strip()
        if not title:
            continue
        company = board_slug.replace("-", " ").title()
        desc = p.get("descriptionPlain") or _strip_html(p.get("description") or "")
        lists_text_parts: list[str] = []
        for entry in p.get("lists", []) or []:
            if not isinstance(entry, dict):
                continue
            heading = (entry.get("text") or "").strip()
            inner = _strip_html(entry.get("content") or "")
            if heading or inner:
                lists_text_parts.append(f"{heading}: {inner}".strip(": "))
        jd = (desc + "\n\n" + "\n".join(lists_text_parts)).strip()[:_JD_TEXT_CAP_CHARS]
        rows.append(
            {
                "source": "lever",
                "external_id": str(ext_id),
                "company": company,
                "role_title": title,
                "jd_text": jd,
                "url": p.get("hostedUrl") or p.get("applyUrl"),
                "posted_date": _parse_epoch_ms(p.get("createdAt")),
                "expires_at": None,
                "parsed": {},
            }
        )
    log.info("jobs.fetch_lever.ok", slug=board_slug, count=len(rows))
    return rows


# ─────────────────────────────────────────────────────────────────────
# Ashby — https://developers.ashbyhq.com/reference/jobboardjoblist
# ─────────────────────────────────────────────────────────────────────

ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board/{slug}"


async def fetch_ashby(board_slug: str) -> list[dict[str, Any]]:
    """Ashby's public job-board postings."""
    url = ASHBY_API.format(slug=board_slug)
    try:
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        log.warning("jobs.fetch_ashby.http_failed", slug=board_slug, error=str(exc))
        return []
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "jobs.fetch_ashby.failed",
            slug=board_slug,
            error=str(exc),
            kind=type(exc).__name__,
        )
        return []

    rows: list[dict[str, Any]] = []
    for p in data.get("jobs", []):
        ext_id = p.get("id")
        title = (p.get("title") or "").strip()
        if not ext_id or not title:
            continue
        company = board_slug.replace("-", " ").title()
        jd = _strip_html(p.get("descriptionHtml") or "")
        rows.append(
            {
                "source": "ashby",
                "external_id": str(ext_id),
                "company": company,
                "role_title": title,
                "jd_text": jd,
                "url": p.get("jobUrl") or p.get("applyUrl"),
                "posted_date": _parse_iso(p.get("publishedAt")),
                "expires_at": None,
                "parsed": {},
            }
        )
    log.info("jobs.fetch_ashby.ok", slug=board_slug, count=len(rows))
    return rows
