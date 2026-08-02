"""Tool handlers for the native Relay Career Graph MCP server.

Identity is server-side only. MCP callers never choose ``user_id`` and cannot
cross the owner boundary by changing tool arguments.
"""

from __future__ import annotations

import os
import re
from datetime import UTC, date, datetime
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
    extract_ats_job_id,
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
COMPILATION_STATUSES = frozenset({"draft", "approved", "rejected", "published"})
APPLICATION_STATUSES = frozenset(
    {
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
)


def fake_mode() -> bool:
    return os.environ.get("RELAY_MCP_FAKE") == "1"


def optional_current_user_id() -> UUID | None:
    """Resolve server-side identity, returning None only when local setup is absent."""

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
        return None
    try:
        return UUID(raw)
    except ValueError as exc:
        raise CareerGraphStateError("RELAY_USER_ID must be a UUID") from exc


def current_user_id() -> UUID:
    """Resolve OAuth subject or trusted-local identity without a tool arg."""

    user_id = optional_current_user_id()
    if user_id is None:
        raise CareerGraphStateError(
            "Relay identity is not configured. Connect the remote Relay MCP with OAuth, "
            "or set RELAY_USER_ID for this trusted local Codex session; never pass a user "
            "id in a tool call."
        )
    return user_id


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


def _validate_page(*, limit: int, offset: int) -> None:
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise CareerGraphStateError("limit must be an integer from 1 to 100")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise CareerGraphStateError("offset must be a non-negative integer")


def _compilation_next_actions(
    status: str,
    *,
    publication_active: bool,
) -> list[str]:
    actions = {
        "draft": [
            "get_resume_compilation",
            "prepare_resume_artifact_review",
        ],
        "approved": [
            "get_resume_compilation",
            "publish_resume_compilation_or_create_application_draft",
        ],
        "rejected": ["compile_resume_for_jd"],
        "published": [
            "get_resume_compilation",
            "create_application_draft",
        ],
    }.get(status, [])
    if publication_active:
        actions = [
            "get_resume_compilation",
            "update_published_resume",
            "revoke_published_resume",
        ]
        if status in {"approved", "published"}:
            actions.append("create_application_draft")
    return actions


def _artifact_delivery_api_base_url() -> str:
    """Resolve a browser-reachable API origin without allowing remote HTTP."""

    raw = os.environ.get("RELAY_API_BASE_URL", "http://localhost:3001").strip().rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CareerGraphStateError("RELAY_API_BASE_URL must be an absolute http(s) API origin")
    if parsed.username is not None or parsed.password is not None:
        raise CareerGraphStateError("RELAY_API_BASE_URL must not contain credentials")
    try:
        _parsed_port = parsed.port
    except ValueError as exc:
        raise CareerGraphStateError("RELAY_API_BASE_URL contains an invalid port") from exc
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise CareerGraphStateError(
            "RELAY_API_BASE_URL must be an origin without a path, query, or fragment"
        )
    access_token = None if fake_mode() else get_access_token()
    if access_token is not None and parsed.scheme != "https":
        raise CareerGraphStateError(
            "remote OAuth artifact delivery requires an HTTPS RELAY_API_BASE_URL"
        )
    if parsed.scheme == "http" and (parsed.hostname or "").lower() not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        raise CareerGraphStateError(
            "plain-HTTP artifact delivery is allowed only on a loopback API origin"
        )
    return raw


def _artifact_delivery_payload(
    grant: dict[str, Any],
    *,
    api_base_url: str,
) -> dict[str, Any]:
    grant_id = grant["grant_id"]
    payload = {
        **grant,
        "download_page_url": f"{api_base_url}/api/public/artifacts/{grant_id}",
        "capability_secret_in_url": False,
        "public_resume_publication_required": False,
        "requires_local_download_before_upload": grant["purpose"] == "application_upload",
        "download_code_handling": (
            "Enter this code only on the Relay download page. Never paste it into "
            "the job platform or a public URL."
        ),
    }
    if grant["purpose"] == "application_upload":
        payload["upload_preflight"] = {
            "preferred_surface": "chrome_extension",
            "built_in_browser_file_upload_supported": False,
            "required_extension_permission": "Allow access to file URLs",
            "settings_path": ("chrome://extensions → ChatGPT browser extension → Details"),
            "official_setup_url": (
                "https://developers.openai.com/codex/app/chrome-extension#upload-files"
            ),
            "permission_state_detectable_by_relay": False,
            "failure_action": ("stop_batch_and_request_permission_or_user_manual_upload"),
        }
    return payload


async def relay_status() -> dict[str, Any]:
    user_id = optional_current_user_id()
    if user_id is None:
        return {
            "ok": False,
            "server": "relay-career",
            "mode": "disconnected",
            "identity_configured": False,
            "identity_source": None,
            "career_graph_count": None,
            "authentication": {
                "recommended": "remote_oauth",
                "next_action": "connect_relay_career_remote_then_resume_original_intent",
                "trusted_local_fallback": "set RELAY_USER_ID in the Codex environment",
                "user_id_must_never_be_passed_in_tool_arguments": True,
            },
            "workflow_resumable_after_authentication": True,
            "server_side_submission": False,
        }
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
            "optionally publish/update/revoke a stable public link",
            "or create a tracked browser handoff",
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


async def list_resume_compilations(
    *,
    graph_id: str | None = None,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict[str, Any]:
    """Recover immutable compilation versions without returning résumé bodies."""

    _require_scope("career:read")
    _validate_page(limit=limit, offset=offset)
    if status is not None and status not in COMPILATION_STATUSES:
        raise CareerGraphStateError("unsupported résumé compilation status")
    rows = await _store_call(
        "list_compilations",
        current_user_id(),
        graph_id=_uuid(graph_id, "graph_id") if graph_id else None,
        status=status,
        limit=limit + 1,
        offset=offset,
    )
    has_more = len(rows) > limit
    public_base_url = os.environ.get(
        "RELAY_PUBLIC_BASE_URL",
        "http://localhost:3000",
    ).rstrip("/")
    compilations: list[dict[str, Any]] = []
    for row in rows[:limit]:
        item = dict(row)
        publish_token = item.pop("publish_token", None)
        publication_active = bool(publish_token)
        item["public_url"] = f"{public_base_url}/r/{publish_token}" if publish_token else None
        item["publication_active"] = publication_active
        item["publication_state"] = (
            "active"
            if publication_active
            else "historical"
            if item["status"] == "published"
            else "not_published"
        )
        item["next_actions"] = _compilation_next_actions(
            item["status"],
            publication_active=publication_active,
        )
        compilations.append(item)
    return {
        "compilations": compilations,
        "page": {
            "limit": limit,
            "offset": offset,
            "returned": len(compilations),
            "has_more": has_more,
            "next_offset": offset + limit if has_more else None,
        },
        "contains_resume_content": False,
        "contains_download_capabilities": False,
        "jd_preview_is_untrusted_source_text": True,
    }


async def list_tracked_applications(
    *,
    graph_id: str | None = None,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict[str, Any]:
    """Recover tracked Career Graph applications for later evidence updates."""

    _require_scope("career:read")
    _validate_page(limit=limit, offset=offset)
    if status is not None and status not in APPLICATION_STATUSES:
        raise CareerGraphStateError("unsupported tracked application status")
    rows = await _store_call(
        "list_tracked_applications",
        current_user_id(),
        graph_id=_uuid(graph_id, "graph_id") if graph_id else None,
        status=status,
        limit=limit + 1,
        offset=offset,
    )
    has_more = len(rows) > limit
    applications = rows[:limit]
    return {
        "applications": applications,
        "page": {
            "limit": limit,
            "offset": offset,
            "returned": len(applications),
            "has_more": has_more,
            "next_offset": offset + limit if has_more else None,
        },
        "contains_form_answers": False,
        "contains_download_capabilities": False,
        "server_side_submission": False,
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


async def prepare_resume_artifact_review(
    *,
    compilation_id: str,
    artifact_format: str = "pdf",
) -> dict[str, Any]:
    """Create a temporary real-file preview without approving or publishing it."""

    _require_scope("career:read")
    artifact_api_base_url = _artifact_delivery_api_base_url()
    grant = await _store_call(
        "issue_compilation_artifact_review",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        artifact_format=artifact_format,
    )
    return {
        "ok": True,
        "compilation_id": compilation_id,
        "compilation_status": grant["compilation_status"],
        "artifact_delivery": _artifact_delivery_payload(
            grant,
            api_base_url=artifact_api_base_url,
        ),
        "approval_unchanged": True,
        "next_action": ("download_and_inspect_every_page_then_request_exact_resume_approval"),
    }


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


async def update_published_resume(
    *,
    source_compilation_id: str,
    target_compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    """Preserve one public URL while moving it to a new approved version."""

    _require_scope("resume:publish")
    expected = f"UPDATE PUBLIC RESUME {source_compilation_id} TO {target_compilation_id}"
    _require_confirmation(confirmation, expected)
    return await _store_call(
        "update_published_compilation",
        current_user_id(),
        _uuid(source_compilation_id, "source_compilation_id"),
        _uuid(target_compilation_id, "target_compilation_id"),
        confirmation=confirmation,
        public_base_url=os.environ.get(
            "RELAY_PUBLIC_BASE_URL",
            "http://localhost:3000",
        ),
    )


async def revoke_published_resume(
    *,
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    """Revoke a public link without deleting its immutable compilation."""

    _require_scope("resume:publish")
    expected = f"REVOKE PUBLIC RESUME {compilation_id}"
    _require_confirmation(confirmation, expected)
    return await _store_call(
        "revoke_published_compilation",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        confirmation=confirmation,
    )


async def get_resume_publication_history(
    *,
    graph_id: str,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Read stable-link history without exposing raw publication tokens."""

    _require_scope("career:read")
    _validate_page(limit=limit, offset=offset)
    history = await _store_call(
        "get_publication_history",
        current_user_id(),
        _uuid(graph_id, "graph_id"),
        limit=limit + 1,
        offset=offset,
    )
    events = history["events"]
    has_more = len(events) > limit
    public_base_url = os.environ.get(
        "RELAY_PUBLIC_BASE_URL",
        "http://localhost:3000",
    ).rstrip("/")
    active_publications: list[dict[str, Any]] = []
    for row in history["active_publications"]:
        item = dict(row)
        publish_token = item.pop("publish_token")
        item["public_url"] = f"{public_base_url}/r/{publish_token}"
        item["publication_active"] = True
        active_publications.append(item)
    return {
        "graph_id": graph_id,
        "events": events[:limit],
        "active_publications": active_publications,
        "active_publications_truncated": history["active_publications_truncated"],
        "page": {
            "limit": limit,
            "offset": offset,
            "returned": min(len(events), limit),
            "has_more": has_more,
            "next_offset": offset + limit if has_more else None,
        },
        "contains_public_token_digest": False,
        "publication_changes_require_exact_confirmation": True,
    }


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


async def start_application_workflow(
    *,
    graph_id: str,
    jd_text: str,
    company: str,
    role_title: str,
    job_url: str,
    artifact_locale: str = "en",
    length_budget: str = "two_page",
    ats_profile: str = "standard",
) -> dict[str, Any]:
    """Start one durable paid-value flow and persist its job intent before review."""

    _require_scope("career:write")
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

    compilation = await compile_resume_for_jd(
        graph_id=graph_id,
        jd_text=jd_text,
        artifact_locale=artifact_locale,
        length_budget=length_budget,
        ats_profile=ats_profile,
    )
    binding = await _store_call(
        "bind_compilation_job",
        current_user_id(),
        _uuid(compilation["id"], "compilation_id"),
        company=company,
        role_title=role_title,
        job_url=job_url,
    )
    return {
        "ok": True,
        "workflow_id": compilation["id"],
        "stage": "resume_review",
        "resumable": True,
        "job_identity": binding["job_identity"],
        "resume_compilation": compilation,
        "next_action": {
            "tool": "prepare_resume_artifact_review",
            "then": f"APPROVE RESUME {compilation['id']}",
            "resume_tool": "resume_application_workflow",
        },
        "approval_gates_remaining": [
            "resume",
            "questionnaire",
            "final_submission",
        ],
        "server_side_submission": False,
    }


async def resume_application_workflow(
    *,
    workflow_id: str,
) -> dict[str, Any]:
    """Recover the next deterministic action without replaying conversation history."""

    _require_scope("application:prepare")
    compilation_uuid = _uuid(workflow_id, "workflow_id")
    compilation = await _store_call(
        "get_compilation",
        current_user_id(),
        compilation_uuid,
    )
    if not compilation:
        raise CareerGraphStateError("application workflow not found")
    job = compilation.get("job_identity")
    if not job:
        raise CareerGraphStateError(
            "workflow has no persisted job identity; start a new application workflow"
        )
    base = {
        "ok": True,
        "workflow_id": workflow_id,
        "resumable": True,
        "compilation_id": workflow_id,
        "compilation_status": compilation["status"],
        "job_identity": job,
        "server_side_submission": False,
    }
    if compilation["status"] == "draft":
        return {
            **base,
            "stage": "resume_review",
            "next_action": {
                "tool": "prepare_resume_artifact_review",
                "then": f"APPROVE RESUME {workflow_id}",
            },
        }
    if compilation["status"] == "rejected":
        return {
            **base,
            "stage": "resume_rejected",
            "terminal": True,
            "next_action": {"tool": "start_application_workflow"},
        }

    draft = await create_application_draft(
        compilation_id=workflow_id,
        company=job["company"],
        role_title=job["role_title"],
        job_url=job["job_url"],
    )
    handoff = await _store_call(
        "application_handoff",
        current_user_id(),
        compilation_uuid,
        job_url=job["job_url"],
    )
    application_status = draft["application_status"]
    if application_status != "review":
        return {
            **base,
            "application_id": draft["application_id"],
            "application_status": application_status,
            "stage": f"application_{application_status}",
            "next_action": {"tool": "list_tracked_applications"},
        }
    questionnaire = handoff.get("questionnaire") or {}
    questionnaire_status = questionnaire.get("status", "missing")
    stages = {
        "missing": (
            "browser_inspection",
            "assess_application_browser_checkpoint",
        ),
        "draft": (
            "questionnaire_review",
            "get_application_questionnaire",
        ),
        "rejected": (
            "questionnaire_revision_required",
            "propose_application_questionnaire",
        ),
        "approved": (
            "ready_for_browser_fill",
            "prepare_application_handoff",
        ),
    }
    stage, next_tool = stages.get(
        questionnaire_status,
        ("questionnaire_revision_required", "propose_application_questionnaire"),
    )
    return {
        **base,
        "application_id": draft["application_id"],
        "application_status": application_status,
        "stage": stage,
        "questionnaire_status": questionnaire_status,
        "next_action": {
            "tool": next_tool,
            "job_url": job["job_url"],
        },
    }


QUESTIONNAIRE_ACTIONS = frozenset({"fill", "manual", "skip"})
QUESTIONNAIRE_FIELD_TYPES = frozenset(
    {"text", "textarea", "select", "multiselect", "checkbox", "radio", "file"}
)
QUESTIONNAIRE_EVIDENCE_TYPES = frozenset(
    {"career_graph", "approved_resume", "user_response"}
)
SENSITIVE_QUESTION_PATTERNS = {
    "age_or_birth": (
        "age",
        "date of birth",
        "birth date",
        "born",
        "18 years old",
        "over 18",
        "at least 18",
    ),
    "criminal_history": (
        "criminal",
        "conviction",
        "felony",
        "arrest",
    ),
    "demographic": (
        "race",
        "ethnicity",
        "gender",
        "sexual orientation",
        "religion",
        "marital status",
        "pronouns",
    ),
    "disability_or_veteran": (
        "disability",
        "disabled",
        "veteran",
        "military status",
    ),
    "immigration_or_work_authorization": (
        "citizenship",
        "visa",
        "sponsor",
        "sponsorship",
        "work authorization",
        "authorized to work",
        "legally authorized",
        "right to work",
        "eligible to work",
    ),
    "pay_expectation": (
        "salary",
        "compensation",
        "pay expectation",
        "desired pay",
        "current pay",
    ),
    "security_clearance": (
        "security clearance",
        "government clearance",
    ),
    "work_arrangement_or_availability": (
        "commute",
        "commutable",
        "relocate",
        "relocation",
        "in office",
        "in-office",
        "onsite",
        "on-site",
        "hybrid schedule",
        "available to start",
        "start date",
        "notice period",
        "willing to",
    ),
    "qualification_eligibility": (
        "degree or",
        "years of professional experience",
        "minimum qualification",
        "meet the qualification",
    ),
}


def _questionnaire_answer(value: Any, *, field: str) -> str | bool | list[str] | None:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        if len(value) > 4_000:
            raise CareerGraphStateError(f"{field}.answer must be at most 4000 characters")
        return value
    if isinstance(value, list) and len(value) <= 100:
        if all(isinstance(item, str) and len(item) <= 500 for item in value):
            return value
    raise CareerGraphStateError(
        f"{field}.answer must be null, a boolean, a string, or a list of strings"
    )


def _sensitivity_reasons(field_id: str, label: str) -> list[str]:
    searchable = " ".join((field_id, label)).casefold().replace("_", " ").replace("-", " ")
    return [
        category
        for category, patterns in SENSITIVE_QUESTION_PATTERNS.items()
        if any(
            re.search(rf"\b{re.escape(pattern)}\b", searchable) is not None
            for pattern in patterns
        )
    ]


def _normalize_questionnaire_fields(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not questions:
        raise CareerGraphStateError(
            "questions must include every currently observed application field"
        )
    if len(questions) > 200:
        raise CareerGraphStateError("questions must contain at most 200 fields")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, question in enumerate(questions):
        field = f"questions[{index}]"
        if not isinstance(question, dict):
            raise CareerGraphStateError(f"{field} must be an object")
        field_id = question.get("id")
        label = question.get("label")
        field_type = question.get("field_type", "text")
        action = question.get("action", "manual")
        if not isinstance(field_id, str) or not field_id.strip() or len(field_id) > 200:
            raise CareerGraphStateError(f"{field}.id must contain 1-200 characters")
        field_id = field_id.strip()
        if field_id in seen:
            raise CareerGraphStateError(f"{field}.id duplicates an earlier field")
        seen.add(field_id)
        if not isinstance(label, str) or not label.strip() or len(label) > 500:
            raise CareerGraphStateError(f"{field}.label must contain 1-500 characters")
        if field_type not in QUESTIONNAIRE_FIELD_TYPES:
            raise CareerGraphStateError(f"{field}.field_type is unsupported")
        if action not in QUESTIONNAIRE_ACTIONS:
            raise CareerGraphStateError(f"{field}.action is unsupported")
        required = question.get("required", False)
        caller_sensitive = question.get("sensitive", False)
        if not isinstance(required, bool) or not isinstance(caller_sensitive, bool):
            raise CareerGraphStateError(f"{field}.required and sensitive must be booleans")
        sensitivity_reasons = _sensitivity_reasons(field_id, label)
        if caller_sensitive and not sensitivity_reasons:
            sensitivity_reasons.append("caller_marked")
        sensitive = bool(sensitivity_reasons)
        answer = _questionnaire_answer(question.get("answer"), field=field)
        evidence = question.get("evidence", [])
        if not isinstance(evidence, list) or len(evidence) > 20:
            raise CareerGraphStateError(f"{field}.evidence must contain at most 20 entries")
        normalized_evidence: list[dict[str, Any]] = []
        for evidence_index, item in enumerate(evidence):
            if not isinstance(item, dict):
                raise CareerGraphStateError(
                    f"{field}.evidence[{evidence_index}] must be an object"
                )
            source_type = item.get("source_type")
            source_ref = item.get("source_ref")
            if source_type not in QUESTIONNAIRE_EVIDENCE_TYPES:
                raise CareerGraphStateError(
                    f"{field}.evidence[{evidence_index}].source_type is unsupported"
                )
            if not isinstance(source_ref, str) or not source_ref.strip() or len(source_ref) > 500:
                raise CareerGraphStateError(
                    f"{field}.evidence[{evidence_index}].source_ref is required"
                )
            normalized_evidence.append(
                {"source_type": source_type, "source_ref": source_ref.strip()}
            )
        if action == "fill":
            if answer is None or answer == "" or answer == []:
                raise CareerGraphStateError(f"{field}.answer is required when action is fill")
            if not normalized_evidence:
                raise CareerGraphStateError(
                    f"{field}.evidence is required when action is fill"
                )
            if sensitive and not any(
                item["source_type"] == "user_response" for item in normalized_evidence
            ):
                raise CareerGraphStateError(
                    f"{field} is sensitive and requires evidence from a current user response"
                )
        elif answer is not None and answer != "" and answer != []:
            raise CareerGraphStateError(
                f"{field}.answer must be empty when action is manual or skip"
            )
        confidence = question.get("confidence", 0.0 if action != "fill" else None)
        if (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not 0 <= float(confidence) <= 1
        ):
            raise CareerGraphStateError(f"{field}.confidence must be between 0 and 1")
        selector = question.get("selector")
        if selector is not None and (
            not isinstance(selector, str) or not selector.strip() or len(selector) > 500
        ):
            raise CareerGraphStateError(f"{field}.selector must contain 1-500 characters")
        options = question.get("options", [])
        if not isinstance(options, list) or len(options) > 200 or not all(
            isinstance(option, str) and len(option) <= 500 for option in options
        ):
            raise CareerGraphStateError(f"{field}.options must be a list of short strings")
        normalized.append(
            {
                "id": field_id,
                "label": label.strip(),
                "field_type": field_type,
                "required": required,
                "selector": selector.strip() if isinstance(selector, str) else None,
                "options": options,
                "answer": answer,
                "action": action,
                "confidence": float(confidence),
                "sensitive": sensitive,
                "sensitivity_reasons": sensitivity_reasons,
                "evidence": normalized_evidence,
            }
        )
    return normalized


def _validate_questionnaire_evidence_refs(
    fields: list[dict[str, Any]],
    *,
    approved_resume: dict[str, Any],
    graph_snapshot: dict[str, Any] | None,
) -> None:
    graph_nodes = {
        item["id"]: item
        for item in (graph_snapshot or {}).get("nodes", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for field_index, field in enumerate(fields):
        for evidence_index, evidence in enumerate(field["evidence"]):
            source_type = evidence["source_type"]
            source_ref = evidence["source_ref"]
            if source_type == "approved_resume":
                if source_ref == "compilation_artifact":
                    evidence["verified"] = True
                    continue
                sections = re.findall(r"\bresume\.([A-Za-z][A-Za-z0-9_]*)", source_ref)
                if not sections or any(section not in approved_resume for section in sections):
                    raise CareerGraphStateError(
                        f"questions[{field_index}].evidence[{evidence_index}].source_ref "
                        "does not reference the approved résumé"
                    )
            elif source_type == "career_graph":
                matching_ids = [
                    node_id
                    for node_id in graph_nodes
                    if source_ref == node_id or source_ref.startswith(f"{node_id}.")
                ]
                if not matching_ids:
                    raise CareerGraphStateError(
                        f"questions[{field_index}].evidence[{evidence_index}].source_ref "
                        "does not reference the approved Career Graph revision"
                    )
                node_id = max(matching_ids, key=len)
                value: Any = graph_nodes[node_id]
                suffix = source_ref[len(node_id) :].removeprefix(".")
                for segment in filter(None, suffix.split(".")):
                    if not isinstance(value, dict) or segment not in value:
                        raise CareerGraphStateError(
                            f"questions[{field_index}].evidence[{evidence_index}].source_ref "
                            "does not resolve inside the approved Career Graph revision"
                        )
                    value = value[segment]
            evidence["verified"] = True


def _questionnaire_review_markdown(questionnaire: dict[str, Any]) -> str:
    lines = [
        "# Application questionnaire review",
        "",
        f"Status: {questionnaire['status']}",
        "",
        "| Question | Proposed action | Answer | Evidence |",
        "|---|---|---|---|",
    ]
    for item in questionnaire["fields"]:
        answer = item["answer"]
        answer_text = ", ".join(answer) if isinstance(answer, list) else str(answer or "—")
        evidence = ", ".join(
            f"{source['source_type']}:{source['source_ref']}" for source in item["evidence"]
        )
        cells = [
            item["label"],
            item["action"],
            answer_text,
            evidence or "—",
        ]
        escaped = [str(cell).replace("|", "\\|").replace("\n", " ") for cell in cells]
        lines.append(f"| {' | '.join(escaped)} |")
    return "\n".join(lines)


def _browser_checkpoint_for_handoff(
    handoff: dict[str, Any],
    *,
    job_url: str,
    observed_url: str,
    observed_company: str | None,
    observed_role_title: str | None,
    observed_job_id: str | None,
    visible_text: str,
    stage: BrowserCheckpointStage,
) -> dict[str, Any]:
    identity = handoff["job_identity"]
    platform = classify_application_target(job_url)["platform"]
    return assess_browser_checkpoint(
        expected_job_url=job_url,
        observed_url=observed_url,
        visible_text=visible_text,
        stage=stage,
        expected_company=identity["company"],
        expected_role_title=identity["role_title"],
        expected_job_id=extract_ats_job_id(job_url, platform),
        observed_company=observed_company,
        observed_role_title=observed_role_title,
        observed_job_id=observed_job_id,
    )


def _validate_observed_questionnaire_fields(
    questionnaire: dict[str, Any],
    observed_field_ids: list[str],
    completed_field_ids: list[str],
) -> tuple[list[str], list[str]]:
    if not observed_field_ids or len(observed_field_ids) > 200:
        raise CareerGraphStateError(
            "observed_field_ids must include every currently observed application field"
        )
    normalized: list[str] = []
    for index, field_id in enumerate(observed_field_ids):
        if not isinstance(field_id, str) or not field_id.strip() or len(field_id) > 200:
            raise CareerGraphStateError(
                f"observed_field_ids[{index}] must contain 1-200 characters"
            )
        normalized.append(field_id.strip())
    if len(set(normalized)) != len(normalized):
        raise CareerGraphStateError("observed_field_ids must not contain duplicates")
    approved_ids = [field["id"] for field in questionnaire["fields"]]
    if set(normalized) != set(approved_ids):
        missing = sorted(set(approved_ids) - set(normalized))
        added = sorted(set(normalized) - set(approved_ids))
        raise CareerGraphStateError(
            "browser fields changed after questionnaire approval; "
            f"missing={missing}, added={added}. Reinspect and revise the questionnaire"
        )
    if len(completed_field_ids) > 200:
        raise CareerGraphStateError("completed_field_ids must contain at most 200 fields")
    completed: list[str] = []
    for index, field_id in enumerate(completed_field_ids):
        if not isinstance(field_id, str) or not field_id.strip() or len(field_id) > 200:
            raise CareerGraphStateError(
                f"completed_field_ids[{index}] must contain 1-200 characters"
            )
        completed.append(field_id.strip())
    if len(set(completed)) != len(completed):
        raise CareerGraphStateError("completed_field_ids must not contain duplicates")
    unknown_completed = sorted(set(completed) - set(approved_ids))
    if unknown_completed:
        raise CareerGraphStateError(
            f"completed_field_ids contains unapproved fields: {unknown_completed}"
        )
    required_completed = {
        field["id"]
        for field in questionnaire["fields"]
        if field["required"] or field["action"] == "fill"
    }
    incomplete = sorted(required_completed - set(completed))
    if incomplete:
        raise CareerGraphStateError(
            "required or planned-fill fields are incomplete: "
            f"{incomplete}. Finish them in the browser before authorization"
        )
    return normalized, completed


async def propose_application_questionnaire(
    *,
    compilation_id: str,
    job_url: str,
    observed_url: str,
    observed_company: str,
    observed_role_title: str,
    questions: list[dict[str, Any]],
    observed_job_id: str | None = None,
    visible_text: str = "",
) -> dict[str, Any]:
    """Create a provenance-bearing browser questionnaire draft for human review."""

    _require_scope("application:prepare")
    compilation_uuid = _uuid(compilation_id, "compilation_id")
    handoff = await _store_call(
        "application_handoff",
        current_user_id(),
        compilation_uuid,
        job_url=job_url,
    )
    checkpoint = _browser_checkpoint_for_handoff(
        handoff,
        job_url=job_url,
        observed_url=observed_url,
        observed_company=observed_company,
        observed_role_title=observed_role_title,
        observed_job_id=observed_job_id,
        visible_text=visible_text,
        stage="before_fill",
    )
    if checkpoint["status"] != "ready_for_fill":
        raise CareerGraphStateError(
            "browser job identity must be verified before creating a questionnaire"
        )
    fields = _normalize_questionnaire_fields(questions)
    graph_snapshot = None
    if any(
        evidence["source_type"] == "career_graph"
        for field in fields
        for evidence in field["evidence"]
    ):
        compilation = await _store_call(
            "get_compilation",
            current_user_id(),
            compilation_uuid,
        )
        if not compilation:
            raise CareerGraphStateError("approved résumé compilation not found")
        graph = await _store_call(
            "get_graph",
            current_user_id(),
            _uuid(compilation["graph_id"], "graph_id"),
        )
        current_revision = (graph or {}).get("current_revision") or {}
        graph_snapshot = current_revision.get("snapshot")
    _validate_questionnaire_evidence_refs(
        fields,
        approved_resume=handoff["resume"],
        graph_snapshot=graph_snapshot,
    )
    now = datetime.now(UTC).isoformat()
    questionnaire = {
        "schema_version": 1,
        "status": "draft",
        "created_at": now,
        "reviewed_at": None,
        "approval_source": None,
        "job_identity": checkpoint["job_identity"],
        "fields": fields,
        "summary": {
            "field_count": len(fields),
            "fillable_count": sum(item["action"] == "fill" for item in fields),
            "manual_count": sum(item["action"] == "manual" for item in fields),
            "skipped_count": sum(item["action"] == "skip" for item in fields),
            "sensitive_count": sum(item["sensitive"] for item in fields),
            "all_fill_answers_have_evidence": all(
                item["action"] != "fill" or bool(item["evidence"]) for item in fields
            ),
            "all_evidence_references_verified": all(
                evidence.get("verified") is True
                for item in fields
                for evidence in item["evidence"]
            ),
        },
    }
    saved = await _store_call(
        "save_application_questionnaire",
        current_user_id(),
        _uuid(handoff["application_id"], "application_id"),
        compilation_uuid,
        questionnaire=questionnaire,
    )
    saved["review_markdown"] = _questionnaire_review_markdown(saved)
    saved["confirmation"] = {
        "approve": f"APPROVE QUESTIONNAIRE {handoff['application_id']}",
        "reject": f"REJECT QUESTIONNAIRE {handoff['application_id']}",
    }
    saved["browser_fill_performed"] = False
    saved["server_side_submission"] = False
    return saved


async def get_application_questionnaire(
    *,
    compilation_id: str,
    job_url: str,
) -> dict[str, Any]:
    _require_scope("application:prepare")
    compilation_uuid = _uuid(compilation_id, "compilation_id")
    handoff = await _store_call(
        "application_handoff",
        current_user_id(),
        compilation_uuid,
        job_url=job_url,
    )
    questionnaire = await _store_call(
        "get_application_questionnaire",
        current_user_id(),
        _uuid(handoff["application_id"], "application_id"),
        compilation_uuid,
    )
    if questionnaire is None:
        return {
            "application_id": handoff["application_id"],
            "compilation_id": compilation_id,
            "status": "missing",
            "required_before_submit": True,
            "next_tool": "propose_application_questionnaire",
        }
    questionnaire["review_markdown"] = _questionnaire_review_markdown(questionnaire)
    questionnaire["required_before_submit"] = True
    return questionnaire


async def _decide_application_questionnaire(
    *,
    compilation_id: str,
    job_url: str,
    confirmation: str,
    decision: str,
) -> dict[str, Any]:
    _require_scope("application:prepare")
    compilation_uuid = _uuid(compilation_id, "compilation_id")
    handoff = await _store_call(
        "application_handoff",
        current_user_id(),
        compilation_uuid,
        job_url=job_url,
    )
    result = await _store_call(
        "decide_application_questionnaire",
        current_user_id(),
        _uuid(handoff["application_id"], "application_id"),
        compilation_uuid,
        decision=decision,
        confirmation=confirmation,
    )
    result["review_markdown"] = _questionnaire_review_markdown(result)
    result["browser_fill_performed"] = False
    result["server_side_submission"] = False
    return result


async def approve_application_questionnaire(
    *,
    compilation_id: str,
    job_url: str,
    confirmation: str,
) -> dict[str, Any]:
    return await _decide_application_questionnaire(
        compilation_id=compilation_id,
        job_url=job_url,
        confirmation=confirmation,
        decision="approved",
    )


async def reject_application_questionnaire(
    *,
    compilation_id: str,
    job_url: str,
    confirmation: str,
) -> dict[str, Any]:
    return await _decide_application_questionnaire(
        compilation_id=compilation_id,
        job_url=job_url,
        confirmation=confirmation,
        decision="rejected",
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
    submission_authorization_id: str | None = None,
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
    requires_submission_authorization = (
        status == "submitted" and evidence_source == "browser_confirmation"
    )
    if requires_submission_authorization and submission_authorization_id is None:
        raise CareerGraphStateError(
            "browser-confirmed submitted status requires a submission authorization receipt"
        )
    if not requires_submission_authorization and submission_authorization_id is not None:
        raise CareerGraphStateError(
            "submission_authorization_id is only valid for a browser-confirmed submitted status"
        )
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
        submission_authorization_id=(
            _uuid(submission_authorization_id, "submission_authorization_id")
            if submission_authorization_id is not None
            else None
        ),
    )


async def prepare_application_handoff(
    *,
    compilation_id: str,
    job_url: str,
    artifact_format: str = "pdf",
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
    artifact_api_base_url = _artifact_delivery_api_base_url()
    grant = await _store_call(
        "issue_application_artifact_delivery",
        current_user_id(),
        _uuid(compilation_id, "compilation_id"),
        _uuid(handoff["application_id"], "application_id"),
        artifact_format=artifact_format,
    )
    handoff["artifact_delivery"] = _artifact_delivery_payload(
        grant,
        api_base_url=artifact_api_base_url,
    )
    questionnaire = handoff.get("questionnaire") or {}
    if questionnaire:
        questionnaire["review_markdown"] = _questionnaire_review_markdown(questionnaire)
        questionnaire["required_before_submit"] = True
    else:
        questionnaire = {
            "status": "missing",
            "required_before_submit": True,
            "next_tool": "propose_application_questionnaire",
        }
    handoff["questionnaire"] = questionnaire
    return handoff


async def assess_application_browser_checkpoint(
    *,
    compilation_id: str,
    job_url: str,
    observed_url: str,
    observed_company: str | None = None,
    observed_role_title: str | None = None,
    observed_job_id: str | None = None,
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
    checkpoint = _browser_checkpoint_for_handoff(
        handoff,
        job_url=job_url,
        observed_url=observed_url,
        observed_company=observed_company,
        observed_role_title=observed_role_title,
        observed_job_id=observed_job_id,
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


async def authorize_application_submission(
    *,
    compilation_id: str,
    job_url: str,
    observed_url: str,
    confirmation: str,
    observed_field_ids: list[str],
    completed_field_ids: list[str],
    observed_company: str | None = None,
    observed_role_title: str | None = None,
    observed_job_id: str | None = None,
    visible_text: str = "",
) -> dict[str, Any]:
    """Issue a receipt for one final browser click after exact confirmation."""

    _require_scope("application:prepare")
    for field, value in (("job_url", job_url), ("observed_url", observed_url)):
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise CareerGraphStateError(f"{field} must be an absolute http(s) URL")
    if len(visible_text) > 20_000:
        raise CareerGraphStateError("visible_text must be at most 20000 characters")

    compilation_uuid = _uuid(compilation_id, "compilation_id")
    handoff = await _store_call(
        "application_handoff",
        current_user_id(),
        compilation_uuid,
        job_url=job_url,
    )
    checkpoint = _browser_checkpoint_for_handoff(
        handoff,
        job_url=job_url,
        observed_url=observed_url,
        observed_company=observed_company,
        observed_role_title=observed_role_title,
        observed_job_id=observed_job_id,
        visible_text=visible_text,
        stage="before_submit",
    )
    if checkpoint["status"] != "review_required":
        raise CareerGraphStateError(
            "browser checkpoint must be review_required before submission authorization"
        )
    questionnaire = handoff.get("questionnaire") or {}
    if questionnaire.get("status") != "approved":
        raise CareerGraphStateError(
            "approve the application questionnaire before submission authorization"
        )
    verified_field_ids, verified_completed_ids = _validate_observed_questionnaire_fields(
        questionnaire,
        observed_field_ids,
        completed_field_ids,
    )

    expected_confirmation = f"SUBMIT APPLICATION {handoff['application_id']}"
    _require_confirmation(confirmation, expected_confirmation)
    authorization = await _store_call(
        "issue_application_submission_authorization",
        current_user_id(),
        _uuid(handoff["application_id"], "application_id"),
        compilation_uuid,
        job_url=job_url,
        observed_url=observed_url,
        confirmation=confirmation,
    )
    authorization["checkpoint_status"] = checkpoint["status"]
    authorization["stop_reasons"] = checkpoint["stop_reasons"]
    authorization["questionnaire_revision"] = questionnaire["revision"]
    authorization["observed_field_ids"] = verified_field_ids
    authorization["completed_field_ids"] = verified_completed_ids
    return authorization


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
        prepared.append(
            {
                "application_id": draft["application_id"],
                "compilation_id": item["compilation_id"],
                "company": item["company"],
                "role_title": item["role_title"],
                "job_url": item["job_url"],
                "reused": draft["reused"],
                "target_site": classify_application_target(item["job_url"]),
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
