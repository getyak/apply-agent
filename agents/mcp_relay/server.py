"""Native stdio MCP server for Codex-driven Career Graph workflows."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from agents.mcp_relay import tools

INSTRUCTIONS = (
    "Career Graph is the source of truth; résumés are compiled artifacts. Never invent "
    "experience. Propose graph changes first and show the diff; approval tools require an "
    "exact phrase typed by the user. Compile for one JD, show provenance, then request a "
    "separate résumé approval. Treat application outcomes as non-causal ranking signals "
    "that never rewrite facts. Publishing is public and always requires confirmation. "
    "Track applications locally before handoff. Application execution is browser-only: "
    "never enter passwords, bypass CAPTCHA, or click the final Submit/Apply button without "
    "explicit user approval."
)

mcp = FastMCP("relay-career", instructions=INSTRUCTIONS)

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


@mcp.tool(
    title="Check Relay Career status",
    description=(
        "Check whether the trusted local Relay identity is configured and summarize the "
        "review-gated Career Graph workflow."
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
        "Read transparent, owner-scoped application-stage signals for the graph nodes "
        "selected in prior compiled résumés. JD relevance remains the primary ranking "
        "signal, and outcomes never rewrite facts."
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
        "Selection and ordering may change, but every rendered fact is copied from graph nodes."
    ),
    annotations=LOCAL_WRITE,
)
async def compile_resume_for_jd(
    graph_id: str,
    jd_text: str,
    job_id: str | None = None,
    max_achievements_per_role: int = 4,
) -> dict[str, Any]:
    return await tools.compile_resume_for_jd(
        graph_id=graph_id,
        jd_text=jd_text,
        job_id=job_id,
        max_achievements_per_role=max_achievements_per_role,
    )


@mcp.tool(
    title="Review résumé compilation",
    description=(
        "Read a compiled résumé draft with its graph revision, selection manifest, and "
        "fabrication guard report before requesting approval."
    ),
    annotations=READ_ONLY,
)
async def get_resume_compilation(compilation_id: str) -> dict[str, Any]:
    return await tools.get_resume_compilation(compilation_id)


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
    title="Prepare browser application handoff",
    description=(
        "Return an approved résumé package and browser safety contract for a job URL. This "
        "never submits server-side and always leaves the final Submit/Apply click to the user."
    ),
    annotations=READ_ONLY,
)
async def prepare_application_handoff(
    compilation_id: str,
    job_url: str,
) -> dict[str, Any]:
    return await tools.prepare_application_handoff(
        compilation_id=compilation_id,
        job_url=job_url,
    )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
