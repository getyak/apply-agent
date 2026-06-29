"""Unit tests for agents.tools.browser — mock MCP client + custom-event sink.

PR4 acceptance:
  - browser_snapshot is NOTIFY (no interrupt), emits relay.browser_snapshot
  - browser_fill_form drops credential fields BEFORE the MCP call
  - missing extension token → BROWSER_EXT_NOT_INSTALLED, no crash
  - large screenshots offload to MinIO (mocked); small ones stay inline
  - write tools carry __relay_permission__ == "APPROVE"; snapshot == "NOTIFY"
"""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest

import agents.tools.browser as browser
from agents.harness import events
from agents.harness.permissions import permission_of

# ── helpers ────────────────────────────────────────────────────────────────


class FakeMCPClient:
    """Records calls and returns canned snapshot results."""

    def __init__(self, *, snapshot_b64: str = "", text: str = "{}") -> None:
        self.snapshot_b64 = snapshot_b64
        self.text = text
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((name, arguments))
        if name == "browser_snapshot":
            return {
                "text": self.text,
                "images": [self.snapshot_b64] if self.snapshot_b64 else [],
                "is_error": False,
                "structured": None,
            }
        return {"text": "", "images": [], "is_error": False, "structured": None}


@pytest.fixture
def sink():
    """Bind a list-capturing custom-event sink so emit_custom_event records frames."""
    frames: list[str] = []
    em = events.RelayEmitter(run_id="r1", thread_id="t1", trace_id="trace-1")
    tokens = events.bind_custom_sink(em, frames.append)
    yield frames
    events.reset_custom_sink(tokens)


def _patch_client(monkeypatch, fake: FakeMCPClient, *, token: str | None = "tok") -> None:
    """Make PlaywrightMCPClient() return `fake`, with token presence controlled."""
    if token:
        monkeypatch.setenv("PLAYWRIGHT_MCP_EXTENSION_TOKEN", token)
    else:
        monkeypatch.delenv("PLAYWRIGHT_MCP_EXTENSION_TOKEN", raising=False)
    monkeypatch.setattr(browser, "PlaywrightMCPClient", lambda *a, **k: fake)


def _custom_names(frames: list[str]) -> list[str]:
    out = []
    for f in frames:
        obj = json.loads(f[len("data: ") : -2])
        if obj.get("type") == "CUSTOM":
            out.append(obj.get("name"))
    return out


# ── permission levels ────────────────────────────────────────────────────


def test_snapshot_is_notify_writes_are_approve() -> None:
    assert permission_of(browser.browser_snapshot) == "NOTIFY"
    assert permission_of(browser.browser_navigate) == "APPROVE"
    assert permission_of(browser.browser_click) == "APPROVE"
    assert permission_of(browser.browser_fill_form) == "APPROVE"


# ── snapshot ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_snapshot_emits_custom_and_returns_ok(monkeypatch, sink) -> None:
    fake = FakeMCPClient(snapshot_b64="aGVsbG8=", text='{"role":"document"}')
    _patch_client(monkeypatch, fake)

    result = await browser.browser_snapshot("https://jobs.example.com")

    assert result["status"] == "ok"
    assert result["url"] == "https://jobs.example.com"
    assert result["has_screenshot"] is True
    assert _custom_names(sink) == ["relay.browser_snapshot"]
    # snapshot is read-only — exactly one MCP call, no fill/click
    assert [c[0] for c in fake.calls] == ["browser_snapshot"]


@pytest.mark.asyncio
async def test_snapshot_missing_token_returns_ext_not_installed(monkeypatch, sink) -> None:
    monkeypatch.delenv("PLAYWRIGHT_MCP_EXTENSION_TOKEN", raising=False)
    # Do NOT patch the client — real constructor must raise BrowserExtNotInstalled.
    result = await browser.browser_snapshot("https://jobs.example.com")
    assert result["status"] == "error"
    assert result["code"] == "BROWSER_EXT_NOT_INSTALLED"
    assert sink == []  # nothing emitted


# ── fill_form password filtering ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_fill_form_drops_credentials(monkeypatch, sink) -> None:
    fake = FakeMCPClient(snapshot_b64="aGk=")
    _patch_client(monkeypatch, fake)

    inner = browser.browser_fill_form.__wrapped__  # bypass the interrupt() gate
    result = await inner(
        "https://ats.example.com",
        {"first_name": "Jane", "password": "hunter2", "ssn": "111", "email": "j@x.io"},
    )

    assert result["status"] == "ok"
    assert set(result["filled"]) == {"first_name", "email"}
    assert set(result["dropped_credentials"]) == {"password", "ssn"}

    # The MCP layer NEVER saw password/ssn.
    fill_args = [c[1]["selector"] for c in fake.calls if c[0] == "browser_fill_form"]
    assert all("password" not in s and "ssn" not in s for s in fill_args)
    assert len(fill_args) == 2  # only the two safe fields


@pytest.mark.asyncio
async def test_fill_form_emits_actions_and_two_snapshots(monkeypatch, sink) -> None:
    fake = FakeMCPClient(snapshot_b64="aGk=")
    _patch_client(monkeypatch, fake)

    inner = browser.browser_fill_form.__wrapped__
    await inner("https://ats.example.com", {"first_name": "Jane", "last_name": "Doe"})

    names = _custom_names(sink)
    # snapshot(before) + 2 fills + snapshot(after)
    assert names.count("relay.browser_snapshot") == 2
    assert names.count("relay.browser_action") == 2


@pytest.mark.asyncio
async def test_fill_form_missing_token(monkeypatch, sink) -> None:
    monkeypatch.delenv("PLAYWRIGHT_MCP_EXTENSION_TOKEN", raising=False)
    inner = browser.browser_fill_form.__wrapped__
    result = await inner("https://ats.example.com", {"first_name": "Jane"})
    assert result["code"] == "BROWSER_EXT_NOT_INSTALLED"


# ── navigate / click ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_navigate_emits_action_then_snapshot(monkeypatch, sink) -> None:
    fake = FakeMCPClient(snapshot_b64="aGk=")
    _patch_client(monkeypatch, fake)

    inner = browser.browser_navigate.__wrapped__
    result = await inner("https://jobs.example.com/apply")

    assert result["status"] == "ok"
    names = _custom_names(sink)
    assert names == ["relay.browser_action", "relay.browser_snapshot"]
    assert fake.calls[0] == ("browser_navigate", {"url": "https://jobs.example.com/apply"})


@pytest.mark.asyncio
async def test_click_emits_action(monkeypatch, sink) -> None:
    fake = FakeMCPClient(snapshot_b64="aGk=")
    _patch_client(monkeypatch, fake)

    inner = browser.browser_click.__wrapped__
    result = await inner("#submit-btn")

    assert result["status"] == "ok"
    assert "relay.browser_action" in _custom_names(sink)


# ── screenshot offload ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_large_screenshot_offloads_to_url(monkeypatch, sink) -> None:
    big = base64.b64encode(b"x" * (300 * 1024)).decode()  # > 256 KiB decoded
    fake = FakeMCPClient(snapshot_b64=big)
    _patch_client(monkeypatch, fake)

    # browser.py imported the symbol directly; patch it there.
    monkeypatch.setattr(
        browser,
        "maybe_offload_screenshot",
        lambda b64, *, user_id: {"screenshot_b64": None, "screenshot_url": "https://minio/x.png"},
    )

    await browser.browser_snapshot("https://jobs.example.com")
    snap_frame = next(
        json.loads(f[len("data: ") : -2]) for f in sink if '"relay.browser_snapshot"' in f
    )
    val = snap_frame["value"]
    assert val["screenshot_url"] == "https://minio/x.png"
    assert val["screenshot_b64"] is None
