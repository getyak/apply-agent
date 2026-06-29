"""Browser tools — drive the user's logged-in tab via the Playwright MCP Chrome Extension.

These are the §方案 B+ tools (docs/architecture/client-side-delivery.md): the agent
reads + fills forms inside the *user's own browser* over MCP; the user clicks
Submit themselves. Four tools:

  browser_snapshot   NOTIFY   — read-only accessibility snapshot + screenshot
  browser_navigate   APPROVE  — change the tab's URL (a state change)
  browser_fill_form  APPROVE  — type into fields (mutation; password fields blocked)
  browser_click      APPROVE  — click an element (mutation)

Permission model (CLAUDE.md HITL red line + agent-event-stream.md §8.2):
  - Writes hard-gate on @requires_approval → LangGraph interrupt(). PR2's
    dock_agent translates that interrupt into a CUSTOM relay.hitl_prep card. We
    do NOT emit hitl_prep here — the tool only emits browser_snapshot /
    browser_action CUSTOM events; HITL is the dock's job.
  - browser_snapshot is NOTIFY: reads are safe, no approval needed.

Password safety (hard requirement): browser_fill_form drops any field whose name
matches _FORBIDDEN_FIELD_NAMES *before* the MCP call — we never type a password,
PIN, SSN, or card number on the user's behalf, even if the LLM asks.

Screenshots: large PNGs (>256 KiB) are offloaded to MinIO and the CUSTOM event
carries screenshot_url; small ones stay inline as screenshot_b64
(agents/harness/screenshot_store.py).

Graceful degradation: when the extension token is unset, tools return
``{"status": "error", "code": "BROWSER_EXT_NOT_INSTALLED", ...}`` and never crash.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import structlog
from ulid import ULID

from agents.coordinator.dock_tools import _USER_CTX
from agents.harness.events import emit_custom_event
from agents.harness.mcp_client import BrowserExtNotInstalled, PlaywrightMCPClient
from agents.harness.permissions import mark_notify, requires_approval
from agents.harness.screenshot_store import maybe_offload_screenshot

log = structlog.get_logger("agents.tools.browser")


# Fields we MUST NOT auto-fill on the user's behalf. Matched as a lowercased
# substring against the field name/key. Mirrors the spirit of appprep's
# SENSITIVE_TOKENS but here it's a hard *credential* block, not a "user decides"
# skip — we never type these even on explicit approval.
_FORBIDDEN_FIELD_NAMES = {"password", "pwd", "passwd", "pin", "ssn", "credit_card"}


def _current_user_id() -> str:
    """User id for screenshot key namespacing — falls back to 'anon' off-turn."""
    uid = _USER_CTX.get()
    return str(uid) if isinstance(uid, UUID) else "anon"


def _ext_error(action: str) -> dict[str, Any]:
    return {
        "status": "error",
        "code": BrowserExtNotInstalled.code,
        "action": action,
        "message": (
            "Connect the Playwright MCP Chrome Extension to let Relay see your "
            "browser tab, then try again."
        ),
    }


def _filter_credentials(fields: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Drop credential-like fields. Returns (safe_fields, dropped_names)."""
    safe: dict[str, Any] = {}
    dropped: list[str] = []
    for name, value in fields.items():
        if any(token in str(name).lower() for token in _FORBIDDEN_FIELD_NAMES):
            dropped.append(str(name))
            continue
        safe[name] = value
    return safe, dropped


async def _emit_snapshot(
    client: PlaywrightMCPClient, *, url: str | None, step_id: str
) -> dict[str, Any]:
    """Take a snapshot via MCP, offload the screenshot, emit relay.browser_snapshot.

    Returns the snapshot payload dict (also the value of the CUSTOM event).
    """
    args: dict[str, Any] = {}
    if url:
        args["url"] = url
    result = await client.call("browser_snapshot", args)

    b64 = result["images"][0] if result.get("images") else ""
    shot = maybe_offload_screenshot(b64, user_id=_current_user_id())

    a11y: Any = None
    if result.get("text"):
        try:
            a11y = json.loads(result["text"])
        except (json.JSONDecodeError, TypeError):
            a11y = result["text"]  # raw snapshot text is still useful to render

    payload = {
        "url": url,
        "screenshot_b64": shot["screenshot_b64"],
        "screenshot_url": shot["screenshot_url"],
        "accessibility_tree": a11y,
    }
    emit_custom_event("relay.browser_snapshot", payload, step_id=step_id)
    return payload


@mark_notify
async def browser_snapshot(url: str | None = None) -> dict[str, Any]:
    """Read the current (or given URL's) page: accessibility tree + screenshot.

    NOTIFY level — read-only, no approval. Emits a relay.browser_snapshot CUSTOM
    event so the dock can render the page state.
    """
    step_id = f"browser-{ULID()}"
    try:
        client = PlaywrightMCPClient()
    except BrowserExtNotInstalled:
        return _ext_error("browser_snapshot")
    try:
        payload = await _emit_snapshot(client, url=url, step_id=step_id)
    except Exception as exc:  # noqa: BLE001 — boundary: surface as structured error
        log.error("browser.snapshot_failed", error=str(exc))
        return {"status": "error", "action": "browser_snapshot", "message": str(exc)[:200]}
    return {
        "status": "ok",
        "action": "browser_snapshot",
        "step_id": step_id,
        "url": payload["url"],
        "has_screenshot": bool(payload["screenshot_b64"] or payload["screenshot_url"]),
    }


@requires_approval("browser_navigate")
async def browser_navigate(url: str) -> dict[str, Any]:
    """Navigate the user's tab to a URL. APPROVE — HITL gated, then snapshots."""
    step_id = f"browser-{ULID()}"
    try:
        client = PlaywrightMCPClient()
    except BrowserExtNotInstalled:
        return _ext_error("browser_navigate")
    try:
        await client.call("browser_navigate", {"url": url})
        emit_custom_event(
            "relay.browser_action",
            {"action": "navigate", "target": url, "value": None},
            step_id=step_id,
        )
        await _emit_snapshot(client, url=url, step_id=step_id)
    except Exception as exc:  # noqa: BLE001
        log.error("browser.navigate_failed", error=str(exc))
        return {"status": "error", "action": "browser_navigate", "message": str(exc)[:200]}
    return {"status": "ok", "action": "browser_navigate", "step_id": step_id, "url": url}


@requires_approval("browser_click")
async def browser_click(selector: str) -> dict[str, Any]:
    """Click an element in the user's tab. APPROVE — HITL gated."""
    step_id = f"browser-{ULID()}"
    try:
        client = PlaywrightMCPClient()
    except BrowserExtNotInstalled:
        return _ext_error("browser_click")
    try:
        await client.call("browser_click", {"selector": selector})
        emit_custom_event(
            "relay.browser_action",
            {"action": "click", "target": selector, "value": None},
            step_id=step_id,
        )
        await _emit_snapshot(client, url=None, step_id=step_id)
    except Exception as exc:  # noqa: BLE001
        log.error("browser.click_failed", error=str(exc))
        return {"status": "error", "action": "browser_click", "message": str(exc)[:200]}
    return {"status": "ok", "action": "browser_click", "step_id": step_id, "selector": selector}


@requires_approval("browser_fill_form")
async def browser_fill_form(url: str, fields: dict[str, Any]) -> dict[str, Any]:
    """Fill form fields in the user's tab. APPROVE — HITL gated.

    Credential-like fields (password / pin / ssn / credit_card …) are dropped
    BEFORE any MCP call — Relay never types those on the user's behalf.
    """
    step_id = f"browser-{ULID()}"
    safe_fields, dropped = _filter_credentials(fields or {})
    if dropped:
        log.warning("browser.fill_form.dropped_credentials", fields=dropped)

    try:
        client = PlaywrightMCPClient()
    except BrowserExtNotInstalled:
        return _ext_error("browser_fill_form")

    try:
        # Snapshot before, so the dock shows the form's starting state.
        await _emit_snapshot(client, url=url, step_id=step_id)

        filled: list[str] = []
        for name, value in safe_fields.items():
            await client.call(
                "browser_fill_form",
                {"selector": f"[name='{name}']", "value": str(value)},
            )
            emit_custom_event(
                "relay.browser_action",
                {"action": "fill", "target": name, "value": str(value)},
                step_id=step_id,
            )
            filled.append(name)

        # Snapshot after.
        await _emit_snapshot(client, url=url, step_id=step_id)
    except Exception as exc:  # noqa: BLE001
        log.error("browser.fill_form_failed", error=str(exc))
        return {"status": "error", "action": "browser_fill_form", "message": str(exc)[:200]}

    return {
        "status": "ok",
        "action": "browser_fill_form",
        "step_id": step_id,
        "url": url,
        "filled": filled,
        "dropped_credentials": dropped,
    }


__all__ = [
    "browser_snapshot",
    "browser_navigate",
    "browser_click",
    "browser_fill_form",
]
