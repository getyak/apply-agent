"""Unit tests for agents/tools/web.py — open-web search + fetch primitives.

Locks down the P1-1 fix:
  - empty / invalid query rejected
  - Tavily backend used when TAVILY_API_KEY is set
  - DDG lite scraper parses the result table correctly
  - DDG fallback fires when Tavily fails
  - web_fetch rejects non-http URLs
  - web_fetch strips script/style/nav and caps text
  - web_fetch reports HTTP errors as status=error

We don't make any real network calls — httpx.MockTransport returns canned
responses keyed by URL. This is the hermetic way (httpx-internal, no
extra dep) per httpx docs.
"""
from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from agents.tools.web import _extract_text, _extract_title, web_fetch, web_search


@pytest.fixture(autouse=True)
def _no_tavily(monkeypatch):
    """Default: Tavily NOT configured. Tests that want it opt in."""
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)


def _install_mock_transport(handler):
    """Helper: patch httpx.AsyncClient to use a MockTransport with `handler`."""
    fake_transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def patched_client(*a, **kw):
        kw["transport"] = fake_transport
        return real_async_client(*a, **kw)

    return patch("agents.tools.web.httpx.AsyncClient", side_effect=patched_client)


# ─────────────────────────────────────────────────────────────────────
# web_search
# ─────────────────────────────────────────────────────────────────────


async def test_web_search_empty_query_rejected():
    out = await web_search("   ")
    assert out["status"] == "error"
    assert out["results"] == []


async def test_web_search_ddg_parses_results():
    """The DDG lite parser must pull title+url+snippet out of the HTML."""
    sample_html = """
    <html><body>
      <table>
        <tr><td>
          <a rel="nofollow" class="result-link" href="https://example.com/a">
            Anthropic interview process &mdash; 2026
          </a>
        </td></tr>
        <tr><td class="result-snippet">A summary of the Anthropic loop &amp; expectations.</td></tr>
        <tr><td>
          <a class="result-link" href="https://reddit.com/r/cscareer/post">
            r/cscareer thread
          </a>
        </td></tr>
        <tr><td class="result-snippet">User experiences with Anthropic phone screens.</td></tr>
      </table>
    </body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "lite.duckduckgo.com"
        assert "anthropic" in request.url.params["q"].lower()
        return httpx.Response(200, text=sample_html)

    with _install_mock_transport(handler):
        out = await web_search("Anthropic interview process")

    assert out["status"] == "ok"
    assert out["source"] == "duckduckgo"
    assert len(out["results"]) == 2
    first = out["results"][0]
    assert first["url"] == "https://example.com/a"
    assert "Anthropic interview process" in first["title"]
    assert "Anthropic loop" in first["snippet"]


async def test_web_search_tavily_used_when_key_set(monkeypatch):
    """If TAVILY_API_KEY is set, hit Tavily and skip DDG."""
    monkeypatch.setenv("TAVILY_API_KEY", "tk_test_1234")

    seen_url: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_url.append(str(request.url))
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Tavily-sourced title",
                        "url": "https://example.com/from-tavily",
                        "content": "Snippet from Tavily.",
                    }
                ]
            },
        )

    with _install_mock_transport(handler):
        out = await web_search("query")

    assert out["status"] == "ok"
    assert out["source"] == "tavily"
    assert len(out["results"]) == 1
    assert out["results"][0]["url"] == "https://example.com/from-tavily"
    assert any("tavily.com" in u for u in seen_url)


async def test_web_search_tavily_failure_falls_back_to_ddg(monkeypatch):
    """If Tavily 5xxs, we must transparently fall back to DDG, not blow up."""
    monkeypatch.setenv("TAVILY_API_KEY", "tk_test_failing")

    def handler(request: httpx.Request) -> httpx.Response:
        if "tavily.com" in str(request.url):
            return httpx.Response(503, text="Tavily down")
        return httpx.Response(
            200,
            text=(
                '<a class="result-link" href="https://ddg.example/x">DDG result</a>'
                '<td class="result-snippet">via DDG.</td>'
            ),
        )

    with _install_mock_transport(handler):
        out = await web_search("query")

    assert out["status"] == "ok"
    assert out["source"] == "duckduckgo"
    assert out["results"][0]["url"] == "https://ddg.example/x"


# ─────────────────────────────────────────────────────────────────────
# web_fetch
# ─────────────────────────────────────────────────────────────────────


async def test_web_fetch_rejects_non_http_url():
    out = await web_fetch("file:///etc/passwd")
    assert out["status"] == "error"
    assert "invalid" in out["message"]


async def test_web_fetch_rejects_empty_url():
    out = await web_fetch("")
    assert out["status"] == "error"


async def test_web_fetch_extracts_title_and_strips_scripts():
    html = """
    <!doctype html>
    <html><head>
      <title>Anthropic Careers &mdash; Engineering</title>
      <style>body { color: red; }</style>
    </head><body>
      <nav>Top nav junk</nav>
      <script>tracker('foo')</script>
      <h1>Engineering roles</h1>
      <p>We hire engineers who care about AI safety.</p>
      <footer>Footer junk</footer>
    </body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    with _install_mock_transport(handler):
        out = await web_fetch("https://example.com/")

    assert out["status"] == "ok"
    assert "Anthropic Careers" in out["title"]
    assert "Engineering" in out["title"]
    # Body must contain the main text and NOT the nav/footer/script.
    assert "Engineering roles" in out["text"]
    assert "AI safety" in out["text"]
    assert "tracker" not in out["text"]
    assert "Top nav junk" not in out["text"]
    assert "Footer junk" not in out["text"]


async def test_web_fetch_returns_error_on_http_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="server boom")

    with _install_mock_transport(handler):
        out = await web_fetch("https://broken.example/")

    assert out["status"] == "error"
    assert "http_error" in out["message"]


# ─────────────────────────────────────────────────────────────────────
# Pure helpers
# ─────────────────────────────────────────────────────────────────────


def test_extract_title_picks_first():
    assert _extract_title("<title>A &amp; B</title>") == "A & B"


def test_extract_title_no_title_returns_empty():
    assert _extract_title("<html><body>nothing</body></html>") == ""


def test_extract_text_collapses_whitespace_and_caps():
    html = "<p>hello\n\n\nworld</p>" + "<p>x</p>" * 5000
    out = _extract_text(html, max_chars=100)
    assert len(out) == 100
    assert "hello world" in out
