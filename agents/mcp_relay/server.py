"""Native MCP server for Codex-driven Career Graph workflows.

STDIO is a trusted-local development surface. Streamable HTTP is a remote,
multi-user surface protected by OAuth 2.1 authorization code + PKCE.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from mcp.server.auth.settings import (
    AuthSettings,
    ClientRegistrationOptions,
    RevocationOptions,
)
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl

from agents.mcp_relay import tools
from agents.mcp_relay.oauth import ALL_SCOPES, PostgresOAuthProvider

INSTRUCTIONS = (
    "Career Graph is the source of truth; résumés are compiled artifacts. Never invent "
    "experience. At the start of a resumed workflow, list existing compilation versions and "
    "tracked applications instead of asking the user to recover opaque IDs. Propose graph "
    "changes first and show the diff; approval tools require an "
    "exact phrase typed by the user. Compile for one JD, show provenance, then request a "
    "separate résumé approval. Always show the persisted compiler config and quality report; "
    "artifact locale changes structural labels only and never translates source facts. Treat "
    "compiler pagination as an estimate; create a short-lived review artifact and inspect "
    "every page of the actual file before approval. Treat application outcomes as non-causal "
    "ranking signals that never rewrite facts. Record "
    "application progress only from a user report, browser confirmation, or recruiter message; "
    "never infer submission from a visible button. Publishing is public and always requires "
    "confirmation. Updating a published résumé preserves the URL but requires a separately "
    "approved target compilation and an exact update phrase; revocation has its own exact phrase "
    "and never deletes the immutable artifact. "
    "Track applications locally before handoff. Download the application-bound artifact "
    "locally through its Relay page immediately before upload; never require public résumé "
    "publication or paste its code into a job site. Check the returned Chrome upload "
    "preflight; if local-file access is disabled, stop the batch and request that permission "
    "or a user-manual upload. Application execution is browser-only: "
    "assess the observed page before fill and again before submit review; stop on stale "
    "jobs, login, CAPTCHA, or security checks. An enabled DOM button is not authorization. "
    "Never enter passwords, bypass CAPTCHA, or click the final Submit/Apply button without "
    "the exact per-application phrase in the user's current message. After that phrase, call "
    "authorize_application_submission and verify its short-lived receipt before the click. "
    "Only a visible post-submit confirmation may consume that receipt through "
    "record_application_progress; a click alone is not submission evidence."
)


def _transport() -> Literal["stdio", "streamable-http"]:
    value = os.environ.get("RELAY_MCP_TRANSPORT", "stdio").strip()
    if value == "stdio":
        return "stdio"
    if value == "streamable-http":
        return "streamable-http"
    raise RuntimeError("RELAY_MCP_TRANSPORT must be 'stdio' or 'streamable-http'")


def _server_options() -> dict[str, Any]:
    if _transport() == "stdio":
        return {}

    host = os.environ.get("RELAY_MCP_HOST", "127.0.0.1")
    port = int(os.environ.get("RELAY_MCP_PORT", "8002"))
    issuer_url = os.environ.get(
        "RELAY_MCP_ISSUER_URL",
        f"http://{host}:{port}",
    ).rstrip("/")
    resource_url = os.environ.get(
        "RELAY_MCP_PUBLIC_URL",
        f"{issuer_url}/mcp",
    )
    web_base_url = os.environ.get(
        "RELAY_WEB_BASE_URL",
        "http://localhost:3000",
    )
    provider = PostgresOAuthProvider(
        web_base_url=web_base_url,
        issuer_url=issuer_url,
    )
    auth = AuthSettings(
        issuer_url=AnyHttpUrl(issuer_url),
        resource_server_url=AnyHttpUrl(resource_url),
        required_scopes=["career:read"],
        client_registration_options=ClientRegistrationOptions(
            enabled=True,
            valid_scopes=ALL_SCOPES,
            default_scopes=ALL_SCOPES,
        ),
        revocation_options=RevocationOptions(enabled=True),
    )
    return {
        "auth_server_provider": provider,
        "auth": auth,
        "host": host,
        "port": port,
        "streamable_http_path": "/mcp",
        "stateless_http": True,
    }


mcp = FastMCP("relay-career", instructions=INSTRUCTIONS, **_server_options())

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
LOCAL_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=False,
)
PUBLIC_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=True,
)
DESTRUCTIVE_PUBLIC_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=True,
)


@mcp.tool(
    title="Check Relay Career status",
    description=(
        "Check whether an OAuth or trusted-local Relay identity is configured and "
        "summarize the review-gated Career Graph workflow."
    ),
    annotations=READ_ONLY,
)
async def relay_status() -> dict[str, Any]:
    return await tools.relay_status()


@mcp.tool(
    title="List Career Graphs",
    description="List the signed-in user's Career Graphs and current revision numbers.",
    annotations=READ_ONLY,
)
async def list_career_graphs() -> dict[str, Any]:
    return await tools.list_career_graphs()


@mcp.tool(
    title="List source résumés",
    description=(
        "List the signed-in user's existing résumé versions that can be imported into "
        "a pending Career Graph change set."
    ),
    annotations=READ_ONLY,
)
async def list_source_resumes() -> dict[str, Any]:
    return await tools.list_source_resumes()


@mcp.tool(
    title="List résumé compilation versions",
    description=(
        "Discover compact owner-scoped Career Graph compilation versions from prior Codex "
        "sessions. Returns lifecycle, graph revision, a bounded untrusted-source JD preview, "
        "compiler/quality summary, publication URL, and tracked-application count, but no "
        "résumé body or download capability."
    ),
    annotations=READ_ONLY,
)
async def list_resume_compilations(
    graph_id: str | None = None,
    status: Literal["draft", "approved", "rejected", "published"] | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict[str, Any]:
    return await tools.list_resume_compilations(
        graph_id=graph_id,
        status=status,
        limit=limit,
        offset=offset,
    )


@mcp.tool(
    title="List tracked Career Graph applications",
    description=(
        "Discover owner-scoped applications from prior Codex sessions so an observed outcome "
        "can be attributed to the exact compilation and graph revision. Returns current "
        "projection plus the latest append-only history event, but no form answers, résumé "
        "body, or download capability."
    ),
    annotations=READ_ONLY,
)
async def list_tracked_applications(
    graph_id: str | None = None,
    status: Literal[
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
    ]
    | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict[str, Any]:
    return await tools.list_tracked_applications(
        graph_id=graph_id,
        status=status,
        limit=limit,
        offset=offset,
    )


@mcp.tool(
    title="Propose résumé import",
    description=(
        "Map one existing owner-scoped JSON Resume into provenance-bearing Career Graph "
        "nodes and edges. The result is pending only and never deletes existing graph facts."
    ),
    annotations=LOCAL_WRITE,
)
async def propose_resume_import(
    resume_id: str,
    graph_id: str | None = None,
    graph_label: str = "Career Graph",
) -> dict[str, Any]:
    return await tools.propose_resume_import(
        resume_id=resume_id,
        graph_id=graph_id,
        graph_label=graph_label,
    )


@mcp.tool(
    title="Get Career Graph",
    description=(
        "Read one approved Career Graph revision, including its stable fact nodes, "
        "relationships, and provenance."
    ),
    annotations=READ_ONLY,
)
async def get_career_graph(graph_id: str) -> dict[str, Any]:
    return await tools.get_career_graph(graph_id)


@mcp.tool(
    title="Get Career Graph evidence outcomes",
    description=(
        "Read transparent, owner-scoped append-only application history, furthest-stage "
        "signals, cross-JD compiler-profile cohorts, sample bounds, and 95% confidence "
        "intervals for graph nodes selected in prior compilations. JD relevance remains "
        "primary; outcomes and cohort rates never rewrite facts."
    ),
    annotations=READ_ONLY,
)
async def get_career_graph_evidence_report(graph_id: str) -> dict[str, Any]:
    return await tools.get_career_graph_evidence_report(graph_id)


@mcp.tool(
    title="Propose Career Graph changes",
    description=(
        "Create a pending Career Graph change set from explicit node/edge operations. "
        "This does not change the approved graph and must be reviewed before approval."
    ),
    annotations=LOCAL_WRITE,
)
async def propose_career_graph_changes(
    operations: list[dict[str, Any]],
    summary: str,
    graph_id: str | None = None,
    graph_label: str = "Career Graph",
) -> dict[str, Any]:
    return await tools.propose_career_graph_changes(
        operations=operations,
        summary=summary,
        graph_id=graph_id,
        graph_label=graph_label,
    )


@mcp.tool(
    title="Review Career Graph change",
    description=(
        "Read a pending or decided change set, including operations and the full proposed "
        "snapshot, before asking the user to approve or reject it."
    ),
    annotations=READ_ONLY,
)
async def get_career_graph_change(change_set_id: str) -> dict[str, Any]:
    return await tools.get_career_graph_change(change_set_id)


@mcp.tool(
    title="Approve Career Graph change",
    description=(
        "Advance the Career Graph to a new immutable revision. Call only after showing the "
        "change set and the user types the exact confirmation phrase returned by review."
    ),
    annotations=LOCAL_WRITE,
)
async def approve_career_graph_change(
    change_set_id: str,
    confirmation: str,
) -> dict[str, Any]:
    return await tools.approve_career_graph_change(
        change_set_id=change_set_id,
        confirmation=confirmation,
    )


@mcp.tool(
    title="Reject Career Graph change",
    description=(
        "Reject a pending Career Graph change set after the user types the exact rejection "
        "phrase. The approved graph remains unchanged."
    ),
    annotations=LOCAL_WRITE,
)
async def reject_career_graph_change(
    change_set_id: str,
    confirmation: str,
) -> dict[str, Any]:
    return await tools.reject_career_graph_change(
        change_set_id=change_set_id,
        confirmation=confirmation,
    )


@mcp.tool(
    title="Compile résumé for JD",
    description=(
        "Render a draft JSON Resume from one approved Career Graph revision for a pasted JD. "
        "Selection and ordering may change, but every rendered fact is copied from graph nodes. "
        "The result records a reproducible locale, length budget, ATS profile, and quality report."
    ),
    annotations=LOCAL_WRITE,
)
async def compile_resume_for_jd(
    graph_id: str,
    jd_text: str,
    job_id: str | None = None,
    artifact_locale: Literal["en", "zh"] = "en",
    length_budget: Literal["one_page", "two_page"] = "two_page",
    ats_profile: Literal["standard", "strict"] = "standard",
    max_achievements_per_role: int | None = None,
) -> dict[str, Any]:
    return await tools.compile_resume_for_jd(
        graph_id=graph_id,
        jd_text=jd_text,
        job_id=job_id,
        artifact_locale=artifact_locale,
        length_budget=length_budget,
        ats_profile=ats_profile,
        max_achievements_per_role=max_achievements_per_role,
    )


@mcp.tool(
    title="Review résumé compilation",
    description=(
        "Read a compiled résumé draft with its graph revision, selection manifest, and "
        "fabrication guard report before requesting approval. Estimated pagination still "
        "requires review of the actual exported PDF artifact."
    ),
    annotations=READ_ONLY,
)
async def get_resume_compilation(compilation_id: str) -> dict[str, Any]:
    return await tools.get_resume_compilation(compilation_id)


@mcp.tool(
    title="Prepare résumé artifact review",
    description=(
        "Create a short-lived PDF or DOCX download capability for a compilation draft. "
        "Use it to inspect the real rendered file before asking for résumé approval. "
        "This does not approve, publish, or submit anything."
    ),
    annotations=PUBLIC_WRITE,
)
async def prepare_resume_artifact_review(
    compilation_id: str,
    artifact_format: Literal["pdf", "docx"] = "pdf",
) -> dict[str, Any]:
    return await tools.prepare_resume_artifact_review(
        compilation_id=compilation_id,
        artifact_format=artifact_format,
    )


@mcp.tool(
    title="Approve résumé compilation",
    description=(
        "Mark a compiled résumé ready for publishing or browser handoff. Call only after the "
        "user reviews it and types the exact approval phrase."
    ),
    annotations=LOCAL_WRITE,
)
async def approve_resume_compilation(
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    return await tools.approve_resume_compilation(
        compilation_id=compilation_id,
        confirmation=confirmation,
    )


@mcp.tool(
    title="Reject résumé compilation",
    description=("Reject a compiled résumé draft after the user types the exact rejection phrase."),
    annotations=LOCAL_WRITE,
)
async def reject_resume_compilation(
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    return await tools.reject_resume_compilation(
        compilation_id=compilation_id,
        confirmation=confirmation,
    )


@mcp.tool(
    title="Publish approved résumé",
    description=(
        "Create a public read-only résumé URL. This is an open-world action and requires the "
        "exact phrase PUBLISH followed by the compilation id."
    ),
    annotations=PUBLIC_WRITE,
)
async def publish_resume_compilation(
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    return await tools.publish_resume_compilation(
        compilation_id=compilation_id,
        confirmation=confirmation,
    )


@mcp.tool(
    title="Update a published résumé version",
    description=(
        "Atomically move an existing stable public URL from one active published "
        "compilation to a different approved compilation in the same Career Graph. "
        "The source artifact remains immutable and the action requires the exact phrase "
        "UPDATE PUBLIC RESUME <source> TO <target>."
    ),
    annotations=PUBLIC_WRITE,
)
async def update_published_resume(
    source_compilation_id: str,
    target_compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    return await tools.update_published_resume(
        source_compilation_id=source_compilation_id,
        target_compilation_id=target_compilation_id,
        confirmation=confirmation,
    )


@mcp.tool(
    title="Revoke a published résumé link",
    description=(
        "Immediately disable one active Career Graph public résumé URL without deleting "
        "the immutable compilation or its history. Requires the exact phrase "
        "REVOKE PUBLIC RESUME <compilation_id>."
    ),
    annotations=DESTRUCTIVE_PUBLIC_WRITE,
)
async def revoke_published_resume(
    compilation_id: str,
    confirmation: str,
) -> dict[str, Any]:
    return await tools.revoke_published_resume(
        compilation_id=compilation_id,
        confirmation=confirmation,
    )


@mcp.tool(
    title="Get résumé publication history",
    description=(
        "Read append-only publication, stable-URL update, and revocation events for one "
        "owner-scoped Career Graph plus its currently active public versions. Raw public "
        "token digests are never returned."
    ),
    annotations=READ_ONLY,
)
async def get_resume_publication_history(
    graph_id: str,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    return await tools.get_resume_publication_history(
        graph_id=graph_id,
        limit=limit,
        offset=offset,
    )


@mcp.tool(
    title="Create tracked application draft",
    description=(
        "Create or reuse a Relay-local application draft linked to an approved résumé "
        "compilation. This enables later outcome feedback but does not open a job site, "
        "fill a form, or submit anything."
    ),
    annotations=LOCAL_WRITE,
)
async def create_application_draft(
    compilation_id: str,
    company: str,
    role_title: str,
    job_url: str,
) -> dict[str, Any]:
    return await tools.create_application_draft(
        compilation_id=compilation_id,
        company=company,
        role_title=role_title,
        job_url=job_url,
    )


@mcp.tool(
    title="Record observed application progress",
    description=(
        "Append an owner-scoped lifecycle observation for a Career Graph application. Use only "
        "after the user reports it, the browser shows a post-submit confirmation, or a recruiter "
        "message establishes it. This changes tracking state, never Career Graph facts, and a "
        "visible/enabled Submit button alone is not evidence of submission. A browser-confirmed "
        "submitted transition must consume the receipt returned immediately before the click by "
        "authorize_application_submission."
    ),
    annotations=LOCAL_WRITE,
)
async def record_application_progress(
    application_id: str,
    status: Literal[
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
    ],
    evidence_source: Literal[
        "user_reported",
        "browser_confirmation",
        "recruiter_message",
    ],
    outcome: str | None = None,
    interview_date: str | None = None,
    clear_interview_date: bool = False,
    submitted_via: Literal["client_extension", "api", "manual", "email"] | None = None,
    submission_authorization_id: str | None = None,
) -> dict[str, Any]:
    return await tools.record_application_progress(
        application_id=application_id,
        status=status,
        evidence_source=evidence_source,
        outcome=outcome,
        interview_date=interview_date,
        clear_interview_date=clear_interview_date,
        submitted_via=submitted_via,
        submission_authorization_id=submission_authorization_id,
    )


@mcp.tool(
    title="Prepare browser application handoff",
    description=(
        "Return an approved résumé package, a short-lived application-bound PDF/DOCX "
        "download capability, and the browser safety contract for a job URL. This never "
        "publishes the résumé or submits server-side, and always leaves the final "
        "Submit/Apply click to the user."
    ),
    annotations=PUBLIC_WRITE,
)
async def prepare_application_handoff(
    compilation_id: str,
    job_url: str,
    artifact_format: Literal["pdf", "docx"] = "pdf",
) -> dict[str, Any]:
    return await tools.prepare_application_handoff(
        compilation_id=compilation_id,
        job_url=job_url,
        artifact_format=artifact_format,
    )


@mcp.tool(
    title="Assess application browser checkpoint",
    description=(
        "Compare the observed browser URL and visible checkpoint text with an owned "
        "application handoff before filling or submit review. Stops on stale/changed "
        "jobs, login, CAPTCHA, security checks, or unsupported platforms. This tool "
        "never authorizes the final click; an enabled DOM button is not user approval."
    ),
    annotations=READ_ONLY,
)
async def assess_application_browser_checkpoint(
    compilation_id: str,
    job_url: str,
    observed_url: str,
    visible_text: str = "",
    stage: str = "before_fill",
) -> dict[str, Any]:
    return await tools.assess_application_browser_checkpoint(
        compilation_id=compilation_id,
        job_url=job_url,
        observed_url=observed_url,
        visible_text=visible_text,
        stage=stage,
    )


@mcp.tool(
    title="Authorize one browser application submission",
    description=(
        "After a before-submit checkpoint and the user's exact application-bound phrase, "
        "issue a five-minute, one-application receipt for one final click in the user's "
        "browser. Reissuing invalidates the prior unused receipt. This never clicks, "
        "submits server-side, or treats the click itself as submission evidence."
    ),
    annotations=LOCAL_WRITE,
)
async def authorize_application_submission(
    compilation_id: str,
    job_url: str,
    observed_url: str,
    confirmation: str,
    visible_text: str = "",
) -> dict[str, Any]:
    return await tools.authorize_application_submission(
        compilation_id=compilation_id,
        job_url=job_url,
        observed_url=observed_url,
        confirmation=confirmation,
        visible_text=visible_text,
    )


@mcp.tool(
    title="Prepare browser application batch",
    description=(
        "Create or reuse a compact local queue for 1-20 approved résumé compilations. "
        "Fetch each full browser handoff just in time with prepare_application_handoff. "
        "Every final Submit/Apply action still requires separate approval, and any login, "
        "CAPTCHA, or risk signal stops the batch."
    ),
    annotations=LOCAL_WRITE,
)
async def prepare_application_batch(
    applications: list[dict[str, Any]],
) -> dict[str, Any]:
    return await tools.prepare_application_batch(applications=applications)


def main() -> None:
    mcp.run(transport=_transport())


if __name__ == "__main__":
    main()
