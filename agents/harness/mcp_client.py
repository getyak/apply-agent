"""Playwright MCP Chrome Extension client.

Connects the agents layer to the Playwright MCP **Chrome Web Store Extension**
(id ``mmlmfjhmonkocbjadbfplnigmagldckm``) running inside the user's own browser,
so browser tools (agents/tools/browser.py) drive the *user's logged-in tab*.
This is the §方案 B+ topology from docs/architecture/client-side-delivery.md:
the agent never operates from a stranger IP/fingerprint — the user clicks
submit themselves.

See docs/architecture/agent-event-stream.md §8 for the event-stream wiring.

Transport: MCP streamable-HTTP. The extension bridge listens on a local URL
(``PLAYWRIGHT_MCP_EXTENSION_URL``, default the loopback port the extension
publishes); auth is a bearer token (``PLAYWRIGHT_MCP_EXTENSION_TOKEN``) the
user copies from the extension popup.

Graceful degradation (hard requirement):
  When the token is absent the client does NOT crash and does NOT attempt a
  connection. It raises ``BrowserExtNotInstalled`` carrying
  ``code == "BROWSER_EXT_NOT_INSTALLED"`` so browser tools can return a
  friendly "install/connect the extension" message instead of a stack trace.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import structlog

log = structlog.get_logger("agents.harness.mcp_client")

# Chrome Web Store id of the Playwright MCP extension. Surfaced here (not just
# in docs) so the friendly error can point the user at the exact listing.
PLAYWRIGHT_MCP_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"

# Where the extension bridge publishes its MCP streamable-HTTP endpoint.
# Overridable for users whose extension binds a non-default port.
_DEFAULT_MCP_URL = "http://127.0.0.1:8931/mcp"


class BrowserExtNotInstalled(RuntimeError):
    """Raised when the Playwright MCP Chrome Extension token is not configured.

    Browser tools catch this and turn it into a structured tool result
    ``{"status": "error", "code": "BROWSER_EXT_NOT_INSTALLED", ...}`` — the
    dock then renders "connect your browser extension" rather than failing the
    whole turn.
    """

    code = "BROWSER_EXT_NOT_INSTALLED"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message
            or (
                "Playwright MCP Chrome Extension is not connected. Install it from the "
                f"Chrome Web Store (id {PLAYWRIGHT_MCP_EXTENSION_ID}) and paste its token "
                "into PLAYWRIGHT_MCP_EXTENSION_TOKEN."
            )
        )


def extension_token() -> str | None:
    """Return the configured extension token, or None when unset/blank."""
    tok = os.environ.get("PLAYWRIGHT_MCP_EXTENSION_TOKEN", "").strip()
    return tok or None


def extension_url() -> str:
    return os.environ.get("PLAYWRIGHT_MCP_EXTENSION_URL", _DEFAULT_MCP_URL)


def require_extension_token() -> str:
    """Return the token or raise BrowserExtNotInstalled.

    Call this at the top of any browser tool *before* doing work so missing
    config fails fast and friendly.
    """
    tok = extension_token()
    if tok is None:
        raise BrowserExtNotInstalled()
    return tok


class PlaywrightMCPClient:
    """Thin async wrapper over an MCP ``ClientSession`` to the extension.

    Use as an async context manager — one short-lived session per browser
    tool call. Holds no global state, so concurrent tool calls each get their
    own session (the dock forces ``max_concurrency=1`` anyway, see plan §2.2).
    """

    def __init__(self, *, url: str | None = None, token: str | None = None) -> None:
        # token defaults to env; require_extension_token() raises if truly absent.
        self._token = token if token is not None else require_extension_token()
        self._url = url or extension_url()
        self._session: Any | None = None

    @asynccontextmanager
    async def session(self) -> AsyncIterator[Any]:
        """Open an initialized MCP ClientSession to the extension bridge.

        Imports the transport lazily so that simply importing this module (e.g.
        during test collection) never requires the network stack to be wired.
        """
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        headers = {"Authorization": f"Bearer {self._token}"}
        async with streamablehttp_client(self._url, headers=headers) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                self._session = session
                try:
                    yield session
                finally:
                    self._session = None

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Call one extension tool inside a fresh session; return a normalized dict.

        Returns ``{"text": str, "images": [base64...], "is_error": bool,
        "structured": object|None}``. Browser tools pick the field they need.
        """
        async with self.session() as session:
            result = await session.call_tool(name, arguments)
        return _normalize_result(result)


def _normalize_result(result: Any) -> dict[str, Any]:
    """Flatten an MCP CallToolResult into a plain dict browser tools can read.

    MCP returns a list of content blocks (text / image). We collapse text into
    one string and collect any image base64 payloads separately so the caller
    can decide whether to offload them to MinIO.
    """
    texts: list[str] = []
    images: list[str] = []
    for block in getattr(result, "content", None) or []:
        btype = getattr(block, "type", None)
        if btype == "text":
            texts.append(getattr(block, "text", "") or "")
        elif btype == "image":
            data = getattr(block, "data", None)
            if data:
                images.append(data)
    return {
        "text": "\n".join(texts),
        "images": images,
        "is_error": bool(getattr(result, "isError", False)),
        "structured": getattr(result, "structuredContent", None),
    }


__all__ = [
    "PlaywrightMCPClient",
    "BrowserExtNotInstalled",
    "PLAYWRIGHT_MCP_EXTENSION_ID",
    "extension_token",
    "extension_url",
    "require_extension_token",
]
