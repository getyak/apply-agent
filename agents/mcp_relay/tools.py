"""Tool handlers for the native Relay Career Graph MCP server.

Identity is server-side only. MCP callers never choose ``user_id`` and cannot
cross the owner boundary by changing tool arguments.
"""

from __future__ import annotations

import os
from datetime import date
from typing import Any, cast
from urllib.parse import urlparse
from uuid import UUID

from mcp.server.auth.middleware.auth_context import get_access_token

from agents.career_graph import store as pg_store
from agents.career_graph.fake_store import InMemoryCareerGraphStore
from agents.career_graph.importer import json_resume_to_operations
from agents.career_graph.model import normalize_compiler_config
from agents.career_graph.store import CareerGraphStateError
from agents.mcp_relay.delivery import (
    BrowserCheckpointStage,
    assess_browser_checkpoint,
    batch_safety_contract,
    classify_application_target,
)

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000999")
FAKE_SOURCE_RESUME_ID = UUID("00000000-0000-0000-0000-000000000101")
FAKE_SOURCE_RESUME = {
    "basics": {"name": "Alex Doe", "email": "alex@example.test"},
    "work": [
        {
            "name": "Acme Corp",
            "position": "Backend Engineer",
            "startDate": "2022-01",
            "endDate": "present",
            "highlights": [
                "Migrated billing workloads to PostgreSQL without downtime.",
            ],
        }
    ],
    "skills": [{"name": "PostgreSQL"}, {"name": "Python"}],
}
FAKE_STORE = InMemoryCareerGraphStore()


def fake_mode() -> bool:
    return os.environ.get("RELAY_MCP_FAKE") == "1"


def current_user_id() -> UUID:
    """Resolve OAuth subject or trusted-local identity without a tool arg."""

    if fake_mode():
        return FAKE_USER_ID
    access_token = get_access_token()
    if access_token is not None:
        if not access_token.subject:
            raise CareerGraphStateError("OAuth access token is missing its Relay subject")
        try:
            return UUID(access_token.subject)
        except ValueError as exc:
            raise CareerGraphStateError(
                "OAuth access token subject must be a Relay user UUID"
            ) from exc
    raw = os.environ.get("RELAY_USER_ID", "").strip()
    if not raw:
        raise CareerGraphStateError(
            "Relay identity is not configured. Set RELAY_USER_ID for this trusted local "
            "Codex session; never pass a user id in a tool call."
        )
    try:
        return UUID(raw)
    except ValueError as exc:
        raise CareerGraphStateError("RELAY_USER_ID must be a UUID") from exc


def _require_scope(scope: str) -> None:
    """Enforce fine-grained OAuth scopes while preserving trusted STDIO."""

    if fake_mode():
        return
    access_token = get_access_token()
    if access_token is not None and scope not in access_token.scopes:
        raise CareerGraphStateError(f"OAuth scope required: {scope}")


async def _store_call(name: str, *args: Any, **kwargs: Any) -> Any:
    if fake_mode():
        return await getattr(FAKE_STORE, name)(*args, **kwargs)
    return await getattr(pg_store, name)(*args, **kwargs)


def _uuid(value: str, field: str) -> UUID:
    try:
        return UUID(value)
    except ValueError as exc:
        raise CareerGraphStateError(f"{field} must be a UUID") from exc


def _require_confirmation(actual: str, expected: str) -> None:
    if actual != expected:
        raise CareerGraphStateError(
            f"human confirmation required. Ask the user to type exactly: {expected}"
        )


async def relay_status() -> dict[str, Any]:
    user_id = current_user_id()
    graphs = await _store_call("list_graphs", user_id)
    access_token = None if fake_mode() else get_access_token()
    return {
        "ok": True,
        "server": "relay-career",
        "mode": (
            "fake"
            if fake_mode()
            else "remote_oauth"
            if access_token is not None
            else "trusted_local"
        ),
        "identity_configured": True,
        "identity_source": (
            "fake_fixture"
            if fake_mode()
            else "oauth_subject"
            if access_token is not None
            else "RELAY_USER_ID"
        ),
        "career_graph_count": len(graphs),
        "fake_source_resume_id": str(FAKE_SOURCE_RESUME_ID) if fake_mode() else None,
        "workflow": [
            "propose graph changes",
            "human approves graph revision",
            "read non-causal evidence outcome signals",
            "compile draft for one JD",
            "human approves compiled résumé",
            "optionally publish or create a tracked browser handoff",
        ],
        "server_side_submission": False,
    }


async def list_career_graphs() -> dict[str, Any]:
    user_id = current_user_id()
    return {"graphs": await _store_call("list_graphs", user_id)}


async def list_source_resumes() -> dict[str, Any]:
    if fake_mode():
        return {
            "resumes": [
                {
                    "id": str(FAKE_SOURCE_RESUME_ID),
                    "version": 1,
                    "label": "Fake source résumé",
                    "track": "original",
                    "is_base": True,
                    "created_at": "2026-01-01T00:00:00+00:00",
                }
            ]
        }
    return {
        "resumes": await pg_store.list_source_resumes(current_user_id()),
    }


async def propose_resume_import(
    *,
    resume_id: str,
    graph_id: str | None = None,
    graph_label: str = "Career Graph",
) -> dict[str, Any]:
    _require_scope("career:write")
    parsed_resume_id = _uuid(resume_id, "resume_id")
    user_id = current_user_id()
    if not fake_mode():
        return await pg_store.propose_resume_import(
            user_id,
            parsed_resume_id,
            graph_id=_uuid(graph_id, "graph_id") if graph_id else None,
            graph_label=graph_label,
        )
    if parsed_resume_id != FAKE_SOURCE_RESUME_ID:
        raise pg_store.CareerGraphNotFoundError("source résumé not found")
    if graph_id:
        target_graph_id = _uuid(graph_id, "graph_id")
        if not await FAKE_STORE.get_graph(user_id, target_graph_id):
            raise pg_store.CareerGraphNotFoundError("Career Graph not found")
    else:
        graph = await FAKE_STORE.get_or_create_graph(
            user_id,
            label=graph_label,
            source_resume_id=FAKE_SOURCE_RESUME_ID,
        )
        target_graph_id = UUID(graph["id"])
    mapped = json_resume_to_operations(
        FAKE_SOURCE_RESUME,
        source_ref=f"resume:{FAKE_SOURCE_RESUME_ID}:v1",
    )
    proposal = await FAKE_STORE.propose_changes(
        user_id,
        target_graph_id,
        operations=mapped["operations"],
        summary="Import résumé v1: Fake source résumé",
        proposed_by="import",
    )
    proposal["import_report"] = mapped["report"]
    proposal["source_resume_id"] = str(FAKE_SOURCE_RESUME_ID)
    return proposal


async def get_career_graph(graph_id: str) -> dict[str, Any]:
    user_id = current_user_id()
    graph = await _store_call("get_graph", user_id, _uuid(graph_id, "graph_id"))
    if not graph:
        raise pg_store.CareerGraphNotFoundError("Career Graph not found")
    return graph


async def get_career_graph_evidence_report(graph_id: str) -> dict[str, Any]:
    return await _store_call(
        "get_evidence_outcome_report",
        current_user_id(),
        _uuid(graph_id, "graph_id"),
    )


async def propose_career_graph_changes(
    *,
    operations: list[dict[str, Any]],
    summary: str,
    graph_id: str | None = None,
    graph_label: str = "Career Graph",
) -> dict[str, Any]:
    """Stage changes only; never mutate the approved graph revision."""

    _require_scope("career:write")
    user_id = current_user_id()
    if not summary.strip():
        raise CareerGraphStateError("summary is required")
    if graph_id:
        target_id = _uuid(graph_id, "graph_id")
    else:
        graph = await _store_call(
            "get_or_create_graph",
            user_id,
            label=graph_label,
        )
        target_id = UUID(graph["id"])
    return await _store_call(
        "propose_changes",
        user_id,
        target_id,
        operations=operations,
        summary=summary.strip(),
        proposed_by="codex",
    )


async def get_career_graph_change(change_set_id: str) -> dict[str, Any]:
    user_id = current_user_id()
    change = await _store_call(
        "get_change_set",
        user_id,
        _uuid(change_set_id, "change_set_id"),
    )
    if not change:
        raise pg_store.CareerGraphNotFoundError("Career Graph change set not found")
    return change


async def approve_career_graph_change(
    *,
    change_set_id: str,
    confirmation: str,
) -> dict[str, Any]:
    _require_scope("career:write")
    expected = f"APPROVE CAREER CHANGE {change_set_id}"
    _require_confirmation(confirmation, expected)
    return await _store_call(
        "approve_change_set",
        current_user_id(),
        _uuid(change_set_id, "change_set_id"),
        decided_via="codex_mcp_explicit_confirmation",
    )


async def reject_career_graph_change(
    *,
    change_set_id: str,
    confirmation: str,
) -> dict[str, Any]:
    _require_scope("career:write")
    expected = f"REJECT CAREER CHANGE {change_set_id}"
    _require_confirmation(confirmation, expected)
    return await _store_call(
        "reject_change_set",
        current_user_id(),
        _uuid(change_set_id, "change_set_id"),
        decided_via="codex_mcp_explicit_confirmation",
    )


async def compile_resume_for_jd(
    *,
    graph_id: str,
    jd_text: str,
    job_id: str | None = None,
    artifact_locale: str = "en",
    length_budget: str = "two_page",
    ats_profile: str = "standard",
    max_achievements_per_role: int | None = None,
) -> dict[str, Any]:
    _require_scope("career:write")
    if not jd_text.strip():
        raise CareerGraphStateError("jd_text is required")
    if len(jd_text) > 50_000:
        raise CareerGraphStateError("jd_text must be at most 50000 characters")
    parsed_job_id = _uuid(job_id, "job_id") if job_id else None
    try:
        normalize_compiler_config(
            artifact_locale=artifact_locale,
            length_budget=length_budget,
            ats_profile=ats_profile,
            max_achievements_per_role=max_achievements_per_role,
        )
    except ValueError as exc:
        raise CareerGraphStateError(str(exc)) from exc
    return await _store_call(
        "create_compilation",
        current_user_id(),
        _uuid(graph_id, "graph_id"),
        jd_text=jd_text,
        job_id=parsed_job_id,
        artifact_locale=artifact_locale,
        length_budget=length_budget,
        ats_profile=ats_profile,
        max_achievements_per_role=max_achievements_per_role,
    )


async def get_resume_compilation(compilation_id: str) -> dict[str, Any]:
    compilation = await _store_call(
        "get_compilation",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
    )
    if not compilation:
        raise pg_store.CareerGraphNotFoundError("résumé compilation not found")
    return compilation


async def approve_resume_compilation(
    *,
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    _require_scope("career:write")
    expected = f"APPROVE RESUME {compilation_id}"
    _require_confirmation(confirmation, expected)
    return await _store_call(
        "approve_compilation",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
    )


async def reject_resume_compilation(
    *,
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    _require_scope("career:write")
    expected = f"REJECT RESUME {compilation_id}"
    _require_confirmation(confirmation, expected)
    return await _store_call(
        "reject_compilation",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
    )


async def publish_resume_compilation(
    *,
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    _require_scope("resume:publish")
    return await _store_call(
        "publish_compilation",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        confirmation=confirmation,
        public_base_url=os.environ.get("RELAY_PUBLIC_BASE_URL", "http://localhost:3000"),
    )


async def create_application_draft(
    *,
    compilation_id: str,
    company: str,
    role_title: str,
    job_url: str,
) -> dict[str, Any]:
    _require_scope("application:prepare")
    parsed = urlparse(job_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CareerGraphStateError("job_url must be an absolute http(s) URL")
    company = company.strip()
    role_title = role_title.strip()
    if not company or len(company) > 200:
        raise CareerGraphStateError("company must contain 1-200 characters")
    if not role_title or len(role_title) > 200:
        raise CareerGraphStateError("role_title must contain 1-200 characters")
    return await _store_call(
        "create_application_draft",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        company=company,
        role_title=role_title,
        job_url=job_url,
    )


async def record_application_progress(
    *,
    application_id: str,
    status: str,
    evidence_source: str,
    outcome: str | None = None,
    interview_date: str | None = None,
    clear_interview_date: bool = False,
    submitted_via: str | None = None,
) -> dict[str, Any]:
    """Persist a user/browser-observed lifecycle transition, never an inference."""

    _require_scope("application:prepare")
    allowed_statuses = {
        "draft",
        "review",
        "submitted",
        "interview",
        "rejected",
        "offer",
        "withdrawn",
        "ghosted",
        "accepted",
        "closed",
    }
    allowed_evidence_sources = {
        "user_reported",
        "browser_confirmation",
        "recruiter_message",
    }
    allowed_submit_channels = {"client_extension", "api", "manual", "email"}
    if status not in allowed_statuses:
        raise CareerGraphStateError("unsupported application status")
    if evidence_source not in allowed_evidence_sources:
        raise CareerGraphStateError("unsupported application evidence source")
    if outcome is not None and len(outcome.strip()) > 200:
        raise CareerGraphStateError("outcome must be at most 200 characters")
    if interview_date is not None:
        try:
            date.fromisoformat(interview_date)
        except ValueError as exc:
            raise CareerGraphStateError("interview_date must be YYYY-MM-DD") from exc
    if interview_date is not None and clear_interview_date:
        raise CareerGraphStateError(
            "interview_date and clear_interview_date cannot be used together"
        )
    if submitted_via is not None and submitted_via not in allowed_submit_channels:
        raise CareerGraphStateError("unsupported submission channel")
    if status != "submitted" and submitted_via is not None:
        raise CareerGraphStateError("submitted_via is only valid for submitted status")
    return await _store_call(
        "record_application_transition",
        current_user_id(),
        _uuid(application_id, "application_id"),
        status=status,
        evidence_source=evidence_source,
        outcome=outcome,
        interview_date=interview_date,
        clear_interview_date=clear_interview_date,
        submitted_via=submitted_via,
    )


async def prepare_application_handoff(
    *,
    compilation_id: str,
    job_url: str,
) -> dict[str, Any]:
    _require_scope("application:prepare")
    parsed = urlparse(job_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CareerGraphStateError("job_url must be an absolute http(s) URL")
    handoff = await _store_call(
        "application_handoff",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        job_url=job_url,
    )
    handoff["target_site"] = classify_application_target(job_url)
    handoff["submission_gate"] = {
        **handoff["target_site"]["submission_gate"],
        "confirmation_phrase": (f"SUBMIT APPLICATION {handoff['application_id']}"),
    }
    return handoff


async def assess_application_browser_checkpoint(
    *,
    compilation_id: str,
    job_url: str,
    observed_url: str,
    visible_text: str = "",
    stage: str = "before_fill",
) -> dict[str, Any]:
    """Validate browser state against an owned, approved application handoff."""

    _require_scope("application:prepare")
    if stage not in {"before_fill", "before_submit"}:
        raise CareerGraphStateError("stage must be 'before_fill' or 'before_submit'")
    for field, value in (("job_url", job_url), ("observed_url", observed_url)):
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise CareerGraphStateError(f"{field} must be an absolute http(s) URL")
    if len(visible_text) > 20_000:
        raise CareerGraphStateError("visible_text must be at most 20000 characters")

    handoff = await _store_call(
        "application_handoff",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        job_url=job_url,
    )
    checkpoint = assess_browser_checkpoint(
        expected_job_url=job_url,
        observed_url=observed_url,
        visible_text=visible_text,
        stage=cast(BrowserCheckpointStage, stage),
    )
    confirmation_phrase = f"SUBMIT APPLICATION {handoff['application_id']}"
    checkpoint["application_id"] = handoff["application_id"]
    checkpoint["compilation_id"] = compilation_id
    checkpoint["submission_gate"]["confirmation_phrase"] = confirmation_phrase
    checkpoint["next_action"] = (
        "stop_and_return_control_to_user"
        if checkpoint["status"] == "stop"
        else "ask_user_for_exact_confirmation_phrase"
        if stage == "before_submit"
        else "fill_supported_fields_then_reassess_before_submit"
    )
    return checkpoint


async def prepare_application_batch(
    *,
    applications: list[dict[str, Any]],
) -> dict[str, Any]:
    """Prepare multiple local drafts/handoffs without submitting any of them."""

    _require_scope("application:prepare")
    if not applications or len(applications) > 20:
        raise CareerGraphStateError("applications must contain 1-20 items")

    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for index, item in enumerate(applications):
        if not isinstance(item, dict):
            raise CareerGraphStateError(f"applications[{index}] must be an object")
        required = ("compilation_id", "company", "role_title", "job_url")
        values: dict[str, str] = {}
        for field in required:
            value = item.get(field)
            if not isinstance(value, str) or not value.strip():
                raise CareerGraphStateError(f"applications[{index}].{field} is required")
            values[field] = value.strip()
        _uuid(values["compilation_id"], f"applications[{index}].compilation_id")
        parsed = urlparse(values["job_url"])
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise CareerGraphStateError(
                f"applications[{index}].job_url must be an absolute http(s) URL"
            )
        if len(values["company"]) > 200 or len(values["role_title"]) > 200:
            raise CareerGraphStateError(
                f"applications[{index}] company and role_title must be at most 200 characters"
            )
        key = (values["compilation_id"], values["job_url"])
        if key in seen:
            raise CareerGraphStateError(
                f"applications[{index}] duplicates an earlier compilation/job URL"
            )
        seen.add(key)
        normalized.append(values)

    prepared: list[dict[str, Any]] = []
    for item in normalized:
        draft = await create_application_draft(**item)
        handoff = await prepare_application_handoff(
            compilation_id=item["compilation_id"],
            job_url=item["job_url"],
        )
        if handoff["application_id"] != draft["application_id"]:
            raise RuntimeError("application draft and browser handoff identity diverged")
        prepared.append(
            {
                "application_id": draft["application_id"],
                "compilation_id": item["compilation_id"],
                "company": item["company"],
                "role_title": item["role_title"],
                "job_url": item["job_url"],
                "reused": draft["reused"],
                "target_site": handoff["target_site"],
                "handoff_ready": True,
                "next_tool": "prepare_application_handoff",
                "status": "prepared_not_submitted",
            }
        )

    return {
        "ok": True,
        "applications": prepared,
        "batch": batch_safety_contract(len(prepared)),
        "server_side_submission": False,
    }
