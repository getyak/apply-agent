"""Tool handlers for the native Relay Career Graph MCP server.

Identity is server-side only. MCP callers never choose ``user_id`` and cannot
cross the owner boundary by changing tool arguments.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

from agents.career_graph import store as pg_store
from agents.career_graph.fake_store import InMemoryCareerGraphStore
from agents.career_graph.importer import json_resume_to_operations
from agents.career_graph.store import CareerGraphStateError

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
    """Resolve the trusted local identity without exposing it as a tool arg."""

    if fake_mode():
        return FAKE_USER_ID
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
    return {
        "ok": True,
        "server": "relay-career",
        "mode": "fake" if fake_mode() else "live",
        "identity_configured": True,
        "identity_source": "fake_fixture" if fake_mode() else "RELAY_USER_ID",
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
    max_achievements_per_role: int = 4,
) -> dict[str, Any]:
    if not jd_text.strip():
        raise CareerGraphStateError("jd_text is required")
    parsed_job_id = _uuid(job_id, "job_id") if job_id else None
    return await _store_call(
        "create_compilation",
        current_user_id(),
        _uuid(graph_id, "graph_id"),
        jd_text=jd_text,
        job_id=parsed_job_id,
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


async def prepare_application_handoff(
    *,
    compilation_id: str,
    job_url: str,
) -> dict[str, Any]:
    parsed = urlparse(job_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CareerGraphStateError("job_url must be an absolute http(s) URL")
    return await _store_call(
        "application_handoff",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        job_url=job_url,
    )
