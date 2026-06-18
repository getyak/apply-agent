"""APPROVE-level tools — interrupt() the graph and wait for user decision.

These are the highest-risk operations (CLAUDE.md gotchas: HITL required for
submit_form, send_email, delete_*). NEVER tag a tool here AUTO.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from agents.harness.permissions import requires_approval


@requires_approval("submit_application")
async def submit_application(
    application_id: UUID, fields: dict[str, Any]
) -> dict[str, Any]:
    """Server-side submit is a NO-OP by design.

    Per docs/architecture/client-side-delivery.md, real submission happens in
    the user's browser extension. This tool only updates the DB to mark the
    application as 'submitted' AFTER the extension reports back success.
    """
    # In v1 this is called by the extension after the user clicked Submit
    # in their own browser. We do NOT do server-side form submission.
    return {
        "status": "marked_submitted",
        "application_id": str(application_id),
        "field_count": len(fields),
    }


@requires_approval("send_email")
async def send_email(to: str, subject: str, body: str) -> dict[str, Any]:
    """Send an email (e.g. follow-up to recruiter). Always HITL."""
    # Phase 2: integrate with transactional email provider (Resend / Postmark).
    return {
        "status": "queued",
        "to": to,
        "subject_preview": subject[:60],
        "body_chars": len(body),
    }


@requires_approval("delete_resume")
async def delete_resume(resume_id: UUID) -> dict[str, str]:
    """Hard delete (vs soft delete on user_files). Always HITL."""
    return {"status": "queued_delete", "resume_id": str(resume_id)}
