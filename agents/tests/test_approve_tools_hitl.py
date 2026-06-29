"""Round-20 regression: APPROVE-level tools really pause via interrupt()
and resume via Command(resume={"type": "approve"}).

CLAUDE.md gotcha: 'HITL required for submit_form, send_email, delete_*'.
The @requires_approval decorator on `agents/tools/approve.py` is the only
thing standing between an agent and a destructive action. Each tool here
runs through the decorator's interrupt-then-resolve path explicitly, with
the three decision outcomes (approve / reject / timeout) verified.

The tests do NOT spin up a LangGraph runtime: that machinery is exercised
by `test_ask_clarification_tool.py`. Instead we patch
`langgraph.types.interrupt` to deterministically yield each decision shape
and assert the wrapper's behaviour. That keeps the test fast and CI-friendly
while still exercising the wrapper for ALL three APPROVE tools.
"""

from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

import pytest

from agents.harness.permissions import permission_of
from agents.tools.approve import delete_resume, send_email, submit_application

# ── permission tagging is the contract — fail loudly if anyone drops it ─


@pytest.mark.parametrize("fn", [submit_application, send_email, delete_resume])
def test_approve_tools_are_tagged_APPROVE(fn):
    """Each tool must carry __relay_permission__=APPROVE so the LangGraph
    tool registry / hook layer can detect it before scheduling."""
    assert permission_of(fn) == "APPROVE"


# ── approve path returns the wrapped function's result ─────────────────


async def test_submit_application_approve_returns_marked_submitted():
    """Approve → wrapped fn runs → returns marked_submitted envelope.

    `submit_application` is `async def` so the sync `@requires_approval`
    wrapper returns the inner coroutine — callers must await it. That
    matches how LangGraph's tool executor consumes async tools.
    """

    captured: list[dict] = []

    def fake_interrupt(payload):
        captured.append(payload)
        return {"type": "approve"}

    with patch("agents.harness.permissions.interrupt", side_effect=fake_interrupt):
        app_id = uuid4()
        result = await submit_application(app_id, {"first_name": "Alice"})

    assert result == {
        "status": "marked_submitted",
        "application_id": str(app_id),
        "field_count": 1,
    }
    # The interrupt payload carries enough context for the UI to render a
    # confirmation modal.
    assert captured[0]["action"] == "submit_application"
    assert "submit_application" in captured[0]["message"]


async def test_send_email_approve_can_mutate_args_at_resume_time():
    """User can amend kwargs (e.g. edit the subject) at the approval prompt
    and the wrapper applies them before running the wrapped fn. This is the
    crucial 'no fabrication, but YES editability' affordance."""

    def fake_interrupt(payload):
        # User clicked Approve AND edited the subject.
        return {"type": "approve", "kwargs": {"subject": "Edited Subject"}}

    with patch("agents.harness.permissions.interrupt", side_effect=fake_interrupt):
        result = await send_email(
            to="recruiter@stripe.com",
            subject="Original Subject",
            body="Hi there!",
        )

    assert result == {
        "status": "queued",
        "to": "recruiter@stripe.com",
        "subject_preview": "Edited Subject",
        "body_chars": len("Hi there!"),
    }


# ── reject path returns a structured cancellation, never runs the fn ───


def test_delete_resume_reject_does_not_execute():
    """Reject → wrapped fn must NOT run (no DB writes, no side effects)."""

    inner_calls = {"n": 0}

    def watch_inner(*args, **kwargs):
        inner_calls["n"] += 1
        return {"status": "should_not_happen"}

    def fake_interrupt(payload):
        return {"type": "reject", "reason": "user clicked No"}

    with patch("agents.harness.permissions.interrupt", side_effect=fake_interrupt):
        # Patch the unwrapped fn so we can observe whether it ran.
        with patch.object(delete_resume, "__wrapped__", watch_inner):
            result = delete_resume(uuid4())

    assert result == {"status": "rejected", "reason": "user clicked No"}
    assert inner_calls["n"] == 0  # wrapper short-circuited before fn


# ── timeout path is its own state (UI shows 'no decision received') ────


def test_submit_application_timeout_returns_timeout_status():
    """Decision dict missing or unrecognised → timeout. UI uses this to
    surface 'awaiting your decision' rather than treating the absence
    of input as approval (THE security-relevant default)."""

    def fake_interrupt(payload):
        return None  # no decision

    with patch("agents.harness.permissions.interrupt", side_effect=fake_interrupt):
        result = submit_application(uuid4(), {"first_name": "Alice"})

    assert result == {"status": "timeout", "reason": "no decision received"}


def test_submit_application_unknown_decision_treated_as_timeout():
    """A decision dict with an unrecognised type must NOT default to approve.
    This is the canon-critical safety property: HITL is approve-list, not
    deny-list."""

    def fake_interrupt(payload):
        return {"type": "maybe-later"}

    with patch("agents.harness.permissions.interrupt", side_effect=fake_interrupt):
        result = submit_application(uuid4(), {})

    assert result["status"] == "timeout"


# ── reject reason falls back to a sensible default ─────────────────────


def test_reject_without_reason_defaults_to_user_cancelled():
    def fake_interrupt(payload):
        return {"type": "reject"}

    with patch("agents.harness.permissions.interrupt", side_effect=fake_interrupt):
        result = submit_application(uuid4(), {})

    assert result == {"status": "rejected", "reason": "user cancelled"}
