"""Web search + page-fetch primitives for the dock agent.

These are the cheapest possible way to give the Dock LLM eyes on the open
web — no Tavily / Brave / Bing required for the fallback path, just httpx
against DuckDuckGo's no-JS HTML view. If TAVILY_API_KEY is set in the
environment we use that instead (faster, structured, no scraping).

Why this lives in agents/tools/web.py rather than dock_tools.py:
  These are *primitives* (raw HTTP + parse), not the LangGraph @tool
  facade. dock_tools.web_search / dock_tools.web_fetch are thin wrappers
  that add auditing + the tool decorator. Splitting them keeps the
  primitives unit-testable without the LangGraph context boilerplate.

Safety:
  - 5s HTTP timeout per request (latency cap for the dock loop)
  - HTML body cap (200 KiB raw) to bound memory
  - text extraction strips script/style/nav/footer aggressively
  - URL allowlist not enforced (we trust the LLM not to fetch internal
    things — the agent process has no privileged net access anyway)

Design source: docs/architecture/agent-harness.md § 1.1 (P1-1 — agent
sense of external world). Without this the entire "search company
interview process" / "find recent layoff news" path is blank.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from html import unescape
from typing import Any

import httpx
import structlog

log = structlog.get_logger("agents.tools.web")

# ─────────────────────────────────────────────────────────────────────
# Tunables
# ─────────────────────────────────────────────────────────────────────

WEB_HTTP_TIMEOUT_S = 5.0
WEB_RAW_HTML_CAP_BYTES = 200 * 1024
WEB_TEXT_CAP_CHARS = 8_000
WEB_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/121.0 Safari/537.36 (Relay/Vantage agent)"
)


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    snippet: str


# ─────────────────────────────────────────────────────────────────────
# Search
# ─────────────────────────────────────────────────────────────────────


async def web_search(query: str, *, max_results: int = 5, region: str = "us-en") -> dict[str, Any]:
    """Search the open web. Returns ``{status, source, results: [SearchHit-dict]}``.

    Two backends, picked at call time:
      - **Tavily** (preferred): if ``TAVILY_API_KEY`` is set in the env.
        Structured JSON, no scraping, AI-summarised hits. Free tier
        covers ~1k queries / month which is plenty for an MVP.
      - **DuckDuckGo lite**: HTML view at duckduckgo.com/lite/. No key,
        no JS, just a simple HTML table we parse with regex. Slower
        and less accurate but never returns blank.

    ``query`` is passed verbatim — the LLM (or caller) is responsible for
    crafting a good query string. ``max_results`` caps at 10 either way.
    """
    if not query or not query.strip():
        return {"status": "error", "message": "empty query", "results": []}

    query = query.strip()
    max_results = max(1, min(10, int(max_results)))

    tavily_key = os.environ.get("TAVILY_API_KEY")
    if tavily_key:
        try:
            hits = await _search_tavily(query, max_results=max_results, key=tavily_key)
            return {
                "status": "ok",
                "source": "tavily",
                "query": query,
                "results": [h.__dict__ for h in hits],
            }
        except Exception as exc:  # noqa: BLE001 — fall through to DDG
            log.warning("web_search.tavily_failed", error=str(exc), kind=type(exc).__name__)

    try:
        hits = await _search_ddg(query, max_results=max_results, region=region)
        return {
            "status": "ok",
            "source": "duckduckgo",
            "query": query,
            "results": [h.__dict__ for h in hits],
        }
    except Exception as exc:  # noqa: BLE001 — log + degrade
        log.error("web_search.ddg_failed", error=str(exc), kind=type(exc).__name__)
        return {
            "status": "error",
            "message": "all backends unavailable",
            "query": query,
            "results": [],
        }


async def _search_tavily(query: str, *, max_results: int, key: str) -> list[SearchHit]:
    """Tavily Search API. Docs: https://docs.tavily.com/api"""
    async with httpx.AsyncClient(timeout=WEB_HTTP_TIMEOUT_S) as client:
        resp = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": key,
                "query": query,
                "max_results": max_results,
                "search_depth": "basic",
                "include_answer": False,
            },
        )
        resp.raise_for_status()
        data = resp.json()
    return [
        SearchHit(
            title=str(r.get("title", ""))[:200],
            url=str(r.get("url", "")),
            snippet=str(r.get("content", ""))[:500],
        )
        for r in data.get("results", [])
    ]


# DuckDuckGo lite HTML parser — extracted into a regex pattern below so it's
# trivially testable. The lite endpoint is intentional: it returns a simple
# HTML page with no JS, no shadow DOM, and explicit <a class="result-link">
# anchors. The pattern below tolerates whitespace + attribute ordering.
_DDG_RESULT_RE = re.compile(
    r'<a\s+[^>]*?class="[^"]*result-link[^"]*"[^>]*?href="([^"]+)"[^>]*>(.*?)</a>'
    r'.*?<td[^>]*class="result-snippet"[^>]*>(.*?)</td>',
    re.IGNORECASE | re.DOTALL,
)


async def _search_ddg(query: str, *, max_results: int, region: str) -> list[SearchHit]:
    """DuckDuckGo lite (no-JS HTML) scraper. No API key required."""
    async with httpx.AsyncClient(
        timeout=WEB_HTTP_TIMEOUT_S,
        headers={"User-Agent": WEB_USER_AGENT},
        follow_redirects=True,
    ) as client:
        resp = await client.get(
            "https://lite.duckduckgo.com/lite/",
            params={"q": query, "kl": region},
        )
        resp.raise_for_status()
        html = resp.text[:WEB_RAW_HTML_CAP_BYTES]

    hits: list[SearchHit] = []
    for m in _DDG_RESULT_RE.finditer(html):
        url = unescape(m.group(1))
        title = unescape(_strip_tags(m.group(2))).strip()
        snippet = unescape(_strip_tags(m.group(3))).strip()
        if not url or not title:
            continue
        hits.append(SearchHit(title=title[:200], url=url, snippet=snippet[:500]))
        if len(hits) >= max_results:
            break
    return hits


# ─────────────────────────────────────────────────────────────────────
# Page fetch
# ─────────────────────────────────────────────────────────────────────


async def web_fetch(url: str, *, max_chars: int = WEB_TEXT_CAP_CHARS) -> dict[str, Any]:
    """Fetch a URL and return its extracted text body.

    Returns ``{status, url, title, text, length}``. On failure returns
    ``{status: 'error', message, url}``.

    Text extraction:
      - drop <script>, <style>, <nav>, <footer>, <aside>, <form>
      - collapse repeated whitespace
      - decode HTML entities
      - cap at ``max_chars`` (8k default — the LLM only needs the gist)

    No JS execution; SPAs that need JS to render content will return empty
    body. For those, the dock should fall back to web_search snippets.
    """
    if not url or not url.startswith(("http://", "https://")):
        return {"status": "error", "url": url, "message": "invalid url"}

    try:
        async with httpx.AsyncClient(
            timeout=WEB_HTTP_TIMEOUT_S,
            headers={"User-Agent": WEB_USER_AGENT},
            follow_redirects=True,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            html = resp.text[:WEB_RAW_HTML_CAP_BYTES]
    except httpx.HTTPError as exc:
        log.warning("web_fetch.http_error", url=url, error=str(exc))
        return {"status": "error", "url": url, "message": f"http_error: {exc}"}
    except Exception as exc:  # noqa: BLE001
        log.warning("web_fetch.error", url=url, error=str(exc), kind=type(exc).__name__)
        return {"status": "error", "url": url, "message": str(exc)}

    title = _extract_title(html)
    text = _extract_text(html, max_chars=max_chars)
    return {
        "status": "ok",
        "url": str(resp.url),
        "title": title,
        "text": text,
        "length": len(text),
    }


# ─────────────────────────────────────────────────────────────────────
# HTML helpers — small, dependency-free, test-friendly.
# ─────────────────────────────────────────────────────────────────────


_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_DROP_SECTIONS_RE = re.compile(
    r"<(script|style|nav|footer|aside|form|noscript|svg)[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_WS_RE = re.compile(r"\s+")


def _strip_tags(s: str) -> str:
    return _TAG_RE.sub("", s)


def _extract_title(html: str) -> str:
    m = _TITLE_RE.search(html)
    if not m:
        return ""
    return unescape(_strip_tags(m.group(1))).strip()[:200]


def _extract_text(html: str, *, max_chars: int) -> str:
    """Extract readable body text from HTML.

    Strategy: strip noisy sections wholesale, then strip remaining tags,
    decode entities, collapse whitespace. This is intentionally not
    trafilatura/readability quality — for the Dock's "give me the gist"
    use case, ~80% of the time the first 8k chars of stripped body
    contain what the LLM needs.
    """
    body = _DROP_SECTIONS_RE.sub(" ", html)
    body = _strip_tags(body)
    body = unescape(body)
    body = _WS_RE.sub(" ", body).strip()
    return body[:max_chars]
