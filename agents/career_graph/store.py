"""Owner-scoped PostgreSQL persistence for Career Graph review workflows."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from typing import Any
from uuid import UUID, uuid4

import psycopg

from agents.career_graph.feedback import aggregate_evidence_outcomes, evidence_scores
from agents.career_graph.importer import json_resume_to_operations
from agents.career_graph.model import apply_operations, compile_resume, empty_snapshot


class CareerGraphNotFoundError(LookupError):
    pass


class CareerGraphConflictError(RuntimeError):
    pass


class CareerGraphStateError(RuntimeError):
    pass


def _dsn() -> str:
    value = os.environ.get("RELAY_PG_DSN")
    if not value:
        raise RuntimeError("RELAY_PG_DSN is required for live Career Graph tools")
    return value


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _coerce_json(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value


def _row_graph(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": str(row[0]),
        "label": row[1],
        "source_resume_id": str(row[2]) if row[2] else None,
        "current_revision": (
            {
                "id": str(row[3]),
                "revision": int(row[4]),
                "snapshot": _coerce_json(row[5]),
                "change_summary": row[6],
                "created_by": row[7],
                "created_at": row[8].isoformat(),
            }
            if row[3]
            else None
        ),
        "created_at": row[9].isoformat(),
        "updated_at": row[10].isoformat(),
    }


async def get_or_create_graph(
    user_id: UUID,
    *,
    label: str = "Career Graph",
    source_resume_id: UUID | None = None,
) -> dict[str, Any]:
    """Return the named graph, creating its empty shell when absent."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO career_graphs (user_id, label, source_resume_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (user_id, label) DO UPDATE
                    SET source_resume_id = COALESCE(
                        career_graphs.source_resume_id,
                        EXCLUDED.source_resume_id
                    )
                RETURNING id
                """,
                (str(user_id), label, str(source_resume_id) if source_resume_id else None),
            )
            row = await cur.fetchone()
        await conn.commit()
    if not row:
        raise RuntimeError("failed to create Career Graph")
    graph = await get_graph(user_id, UUID(str(row[0])))
    if not graph:
        raise RuntimeError("created Career Graph could not be reloaded")
    return graph


async def get_graph(user_id: UUID, graph_id: UUID) -> dict[str, Any] | None:
    """Return one owner-scoped graph with its immutable current revision."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT g.id, g.label, g.source_resume_id,
                       r.id, r.revision, r.snapshot, r.change_summary,
                       r.created_by, r.created_at,
                       g.created_at, g.updated_at
                  FROM career_graphs g
                  LEFT JOIN career_graph_revisions r
                    ON r.id = g.current_revision_id
                 WHERE g.id = %s AND g.user_id = %s
                """,
                (str(graph_id), str(user_id)),
            )
            row = await cur.fetchone()
    return _row_graph(row) if row else None


async def list_graphs(user_id: UUID) -> list[dict[str, Any]]:
    """List graph summaries without returning full snapshots."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT g.id, g.label, g.source_resume_id, r.id, r.revision,
                       jsonb_array_length(COALESCE(r.snapshot->'nodes', '[]'::jsonb)),
                       g.created_at, g.updated_at
                  FROM career_graphs g
                  LEFT JOIN career_graph_revisions r
                    ON r.id = g.current_revision_id
                 WHERE g.user_id = %s
                 ORDER BY g.updated_at DESC
                """,
                (str(user_id),),
            )
            rows = await cur.fetchall()
    return [
        {
            "id": str(row[0]),
            "label": row[1],
            "source_resume_id": str(row[2]) if row[2] else None,
            "current_revision_id": str(row[3]) if row[3] else None,
            "revision": int(row[4]) if row[4] else 0,
            "node_count": int(row[5]) if row[5] is not None else 0,
            "created_at": row[6].isoformat(),
            "updated_at": row[7].isoformat(),
        }
        for row in rows
    ]


async def list_source_resumes(user_id: UUID) -> list[dict[str, Any]]:
    """List owner-scoped résumé artifacts that can seed the Career Graph."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, version, label, track, is_base, created_at
                  FROM resumes
                 WHERE user_id = %s
                 ORDER BY created_at DESC
                """,
                (str(user_id),),
            )
            rows = await cur.fetchall()
    return [
        {
            "id": str(row[0]),
            "version": int(row[1]),
            "label": row[2],
            "track": row[3],
            "is_base": bool(row[4]),
            "created_at": row[5].isoformat(),
        }
        for row in rows
    ]


def _unwrap_resume_content(content: Any) -> dict[str, Any]:
    value = _coerce_json(content)
    if not isinstance(value, dict):
        raise CareerGraphStateError("résumé content is not a JSON object")
    parsed = value.get("parsed")
    if isinstance(parsed, dict):
        return parsed
    return value


async def propose_resume_import(
    user_id: UUID,
    resume_id: UUID,
    *,
    graph_id: UUID | None = None,
    graph_label: str = "Career Graph",
) -> dict[str, Any]:
    """Map an existing résumé into an upsert-only pending graph change set."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT content, version, label
                  FROM resumes
                 WHERE id = %s AND user_id = %s
                """,
                (str(resume_id), str(user_id)),
            )
            row = await cur.fetchone()
    if not row:
        raise CareerGraphNotFoundError("source résumé not found")
    content, version, label = row
    mapped = json_resume_to_operations(
        _unwrap_resume_content(content),
        source_ref=f"resume:{resume_id}:v{version}",
    )

    if graph_id:
        graph = await get_graph(user_id, graph_id)
        if not graph:
            raise CareerGraphNotFoundError("Career Graph not found")
        target_graph_id = graph_id
    else:
        graph = await get_or_create_graph(
            user_id,
            label=graph_label,
            source_resume_id=resume_id,
        )
        target_graph_id = UUID(graph["id"])

    proposal = await propose_changes(
        user_id,
        target_graph_id,
        operations=mapped["operations"],
        summary=f"Import résumé v{version}: {label or resume_id}",
        proposed_by="import",
    )
    proposal["import_report"] = mapped["report"]
    proposal["source_resume_id"] = str(resume_id)
    return proposal


async def propose_changes(
    user_id: UUID,
    graph_id: UUID,
    *,
    operations: list[dict[str, Any]],
    summary: str,
    proposed_by: str = "codex",
) -> dict[str, Any]:
    """Stage a candidate snapshot. This never advances the current revision."""

    graph = await get_graph(user_id, graph_id)
    if not graph:
        raise CareerGraphNotFoundError("Career Graph not found")
    current = graph["current_revision"]
    base_snapshot = current["snapshot"] if current else empty_snapshot()
    proposed_snapshot = apply_operations(base_snapshot, operations)
    change_set_id = uuid4()
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO career_graph_change_sets (
                    id, graph_id, user_id, base_revision_id, operations,
                    proposed_snapshot, summary, proposed_by
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    str(change_set_id),
                    str(graph_id),
                    str(user_id),
                    current["id"] if current else None,
                    _json(operations),
                    _json(proposed_snapshot),
                    summary,
                    proposed_by,
                ),
            )
        await conn.commit()
    return {
        "id": str(change_set_id),
        "graph_id": str(graph_id),
        "base_revision_id": current["id"] if current else None,
        "summary": summary,
        "status": "pending",
        "operations": operations,
        "proposed_snapshot": proposed_snapshot,
        "requires_human_approval": True,
    }


async def get_change_set(user_id: UUID, change_set_id: UUID) -> dict[str, Any] | None:
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, graph_id, base_revision_id, operations,
                       proposed_snapshot, summary, status, proposed_by,
                       decided_via, created_at, decided_at
                  FROM career_graph_change_sets
                 WHERE id = %s AND user_id = %s
                """,
                (str(change_set_id), str(user_id)),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": str(row[0]),
        "graph_id": str(row[1]),
        "base_revision_id": str(row[2]) if row[2] else None,
        "operations": _coerce_json(row[3]),
        "proposed_snapshot": _coerce_json(row[4]),
        "summary": row[5],
        "status": row[6],
        "proposed_by": row[7],
        "decided_via": row[8],
        "created_at": row[9].isoformat(),
        "decided_at": row[10].isoformat() if row[10] else None,
    }


async def approve_change_set(
    user_id: UUID,
    change_set_id: UUID,
    *,
    decided_via: str = "codex_mcp",
) -> dict[str, Any]:
    """Atomically advance the graph if the reviewed proposal is still current."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.graph_id, c.base_revision_id, c.proposed_snapshot,
                       c.summary, c.status, g.current_revision_id,
                       COALESCE(r.revision, 0)
                  FROM career_graph_change_sets c
                  JOIN career_graphs g
                    ON g.id = c.graph_id AND g.user_id = c.user_id
                  LEFT JOIN career_graph_revisions r
                    ON r.id = g.current_revision_id
                 WHERE c.id = %s AND c.user_id = %s
                 FOR UPDATE OF c, g
                """,
                (str(change_set_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError("Career Graph change set not found")
            (
                graph_id,
                base_revision_id,
                proposed_snapshot,
                summary,
                status,
                current_revision_id,
                current_revision,
            ) = row
            if status != "pending":
                raise CareerGraphStateError(f"change set is already {status}")
            if base_revision_id != current_revision_id:
                raise CareerGraphConflictError(
                    "change set was based on an older graph revision; review a fresh proposal"
                )

            revision_id = uuid4()
            next_revision = int(current_revision) + 1
            await cur.execute(
                """
                INSERT INTO career_graph_revisions (
                    id, graph_id, revision, snapshot, change_summary, created_by
                ) VALUES (%s, %s, %s, %s, %s, 'codex')
                """,
                (
                    str(revision_id),
                    str(graph_id),
                    next_revision,
                    _json(_coerce_json(proposed_snapshot)),
                    summary,
                ),
            )
            await cur.execute(
                """
                UPDATE career_graphs
                   SET current_revision_id = %s
                 WHERE id = %s AND user_id = %s
                """,
                (str(revision_id), str(graph_id), str(user_id)),
            )
            await cur.execute(
                """
                UPDATE career_graph_change_sets
                   SET status = 'approved', decided_via = %s, decided_at = now()
                 WHERE id = %s
                """,
                (decided_via, str(change_set_id)),
            )
        await conn.commit()
    return {
        "ok": True,
        "graph_id": str(graph_id),
        "revision_id": str(revision_id),
        "revision": next_revision,
        "change_set_id": str(change_set_id),
        "status": "approved",
    }


async def reject_change_set(
    user_id: UUID,
    change_set_id: UUID,
    *,
    decided_via: str = "codex_mcp",
) -> dict[str, Any]:
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE career_graph_change_sets
                   SET status = 'rejected', decided_via = %s, decided_at = now()
                 WHERE id = %s AND user_id = %s AND status = 'pending'
                RETURNING graph_id
                """,
                (decided_via, str(change_set_id), str(user_id)),
            )
            row = await cur.fetchone()
        await conn.commit()
    if not row:
        raise CareerGraphStateError("pending Career Graph change set not found")
    return {
        "ok": True,
        "graph_id": str(row[0]),
        "change_set_id": str(change_set_id),
        "status": "rejected",
    }


async def create_compilation(
    user_id: UUID,
    graph_id: UUID,
    *,
    jd_text: str,
    job_id: UUID | None = None,
    max_achievements_per_role: int = 4,
) -> dict[str, Any]:
    """Render one draft résumé from the current immutable graph revision."""

    graph = await get_graph(user_id, graph_id)
    if not graph:
        raise CareerGraphNotFoundError("Career Graph not found")
    revision = graph["current_revision"]
    if not revision:
        raise CareerGraphStateError("approve at least one Career Graph revision before compiling")

    feedback_report = await get_evidence_outcome_report(user_id, graph_id)
    compiled = compile_resume(
        revision["snapshot"],
        jd_text,
        max_achievements_per_role=max_achievements_per_role,
        evidence_ranking=evidence_scores(feedback_report),
    )
    compilation_id = uuid4()
    resume_id = uuid4()
    fingerprint = hashlib.sha256(jd_text.encode("utf-8")).hexdigest()
    label = f"Career Graph r{revision['revision']} · JD {fingerprint[:8]}"

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO resumes (
                    id, user_id, version, content, is_base, label,
                    tailored_for_job, track
                ) VALUES (%s, %s, 0, %s, false, %s, %s, 'tailored')
                RETURNING version
                """,
                (
                    str(resume_id),
                    str(user_id),
                    _json(compiled["resume"]),
                    label,
                    str(job_id) if job_id else None,
                ),
            )
            version_row = await cur.fetchone()
            await cur.execute(
                """
                INSERT INTO career_graph_compilations (
                    id, user_id, graph_id, graph_revision_id, job_id,
                    jd_text, jd_fingerprint, resume_id, selection_manifest,
                    guard_report
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    str(compilation_id),
                    str(user_id),
                    str(graph_id),
                    revision["id"],
                    str(job_id) if job_id else None,
                    jd_text,
                    fingerprint,
                    str(resume_id),
                    _json(compiled["selection_manifest"]),
                    _json(compiled["guard_report"]),
                ),
            )
        await conn.commit()

    return {
        "id": str(compilation_id),
        "status": "draft",
        "graph_id": str(graph_id),
        "graph_revision_id": revision["id"],
        "graph_revision": revision["revision"],
        "resume_id": str(resume_id),
        "resume_version": int(version_row[0]) if version_row else 0,
        "jd_fingerprint": fingerprint,
        **compiled,
        "requires_human_approval": True,
    }


async def get_evidence_outcome_report(
    user_id: UUID,
    graph_id: UUID,
) -> dict[str, Any]:
    """Map application stages back to the graph nodes selected for each résumé."""

    graph = await get_graph(user_id, graph_id)
    if not graph:
        raise CareerGraphNotFoundError("Career Graph not found")

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT a.id, a.status, a.submitted_at, a.interview_date,
                       c.guard_report
                  FROM career_graph_compilations c
                  JOIN application_drafts a
                    ON a.resume_version_id = c.resume_id
                   AND a.user_id = c.user_id
                 WHERE c.graph_id = %s AND c.user_id = %s
                """,
                (str(graph_id), str(user_id)),
            )
            rows = await cur.fetchall()

    records: list[dict[str, Any]] = []
    for row in rows:
        guard_report = _coerce_json(row[4])
        selected_node_ids = (
            guard_report.get("selected_node_ids") if isinstance(guard_report, dict) else []
        )
        records.append(
            {
                "application_id": str(row[0]),
                "status": row[1],
                "submitted_at": row[2],
                "interview_date": row[3],
                "selected_node_ids": selected_node_ids,
            }
        )
    report = aggregate_evidence_outcomes(records)
    return {
        "graph_id": str(graph_id),
        "graph_revision": (
            graph["current_revision"]["revision"] if graph["current_revision"] else 0
        ),
        **report,
    }


async def get_compilation(user_id: UUID, compilation_id: UUID) -> dict[str, Any] | None:
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.id, c.graph_id, c.graph_revision_id, r.revision,
                       c.job_id, c.jd_fingerprint, c.resume_id, rv.version,
                       rv.content, c.status, c.selection_manifest,
                       c.guard_report, rv.publish_token, c.created_at,
                       c.approved_at, c.published_at
                  FROM career_graph_compilations c
                  JOIN career_graph_revisions r ON r.id = c.graph_revision_id
                  JOIN resumes rv ON rv.id = c.resume_id
                 WHERE c.id = %s AND c.user_id = %s
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": str(row[0]),
        "graph_id": str(row[1]),
        "graph_revision_id": str(row[2]),
        "graph_revision": int(row[3]),
        "job_id": str(row[4]) if row[4] else None,
        "jd_fingerprint": row[5],
        "resume_id": str(row[6]),
        "resume_version": int(row[7]),
        "resume": _coerce_json(row[8]),
        "status": row[9],
        "selection_manifest": _coerce_json(row[10]),
        "guard_report": _coerce_json(row[11]),
        "publish_token": row[12],
        "created_at": row[13].isoformat(),
        "approved_at": row[14].isoformat() if row[14] else None,
        "published_at": row[15].isoformat() if row[15] else None,
    }


async def approve_compilation(user_id: UUID, compilation_id: UUID) -> dict[str, Any]:
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE career_graph_compilations
                   SET status = 'approved', approved_at = now()
                 WHERE id = %s AND user_id = %s AND status = 'draft'
                RETURNING resume_id
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
        await conn.commit()
    if not row:
        raise CareerGraphStateError("draft compilation not found")
    return {
        "ok": True,
        "compilation_id": str(compilation_id),
        "resume_id": str(row[0]),
        "status": "approved",
    }


async def reject_compilation(user_id: UUID, compilation_id: UUID) -> dict[str, Any]:
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE career_graph_compilations
                   SET status = 'rejected'
                 WHERE id = %s AND user_id = %s AND status = 'draft'
                RETURNING resume_id
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
        await conn.commit()
    if not row:
        raise CareerGraphStateError("draft compilation not found")
    return {
        "ok": True,
        "compilation_id": str(compilation_id),
        "resume_id": str(row[0]),
        "status": "rejected",
    }


async def publish_compilation(
    user_id: UUID,
    compilation_id: UUID,
    *,
    confirmation: str,
    public_base_url: str,
) -> dict[str, Any]:
    """Publish an approved compilation after an exact, explicit confirmation."""

    expected = f"PUBLISH {compilation_id}"
    if confirmation != expected:
        raise CareerGraphStateError(f"explicit confirmation required: {expected}")

    token = secrets.token_hex(16)
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT resume_id, status
                  FROM career_graph_compilations
                 WHERE id = %s AND user_id = %s
                 FOR UPDATE
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError("compilation not found")
            resume_id, status = row
            if status != "approved":
                raise CareerGraphStateError("only an approved compilation can be published")
            await cur.execute(
                """
                UPDATE resumes
                   SET publish_token = %s, published_at = now()
                 WHERE id = %s AND user_id = %s
                """,
                (token, str(resume_id), str(user_id)),
            )
            await cur.execute(
                """
                UPDATE career_graph_compilations
                   SET status = 'published', published_at = now()
                 WHERE id = %s
                """,
                (str(compilation_id),),
            )
        await conn.commit()
    return {
        "ok": True,
        "compilation_id": str(compilation_id),
        "resume_id": str(resume_id),
        "status": "published",
        "public_url": f"{public_base_url.rstrip('/')}/r/{token}",
    }


async def create_application_draft(
    user_id: UUID,
    compilation_id: UUID,
    *,
    company: str,
    role_title: str,
    job_url: str,
) -> dict[str, Any]:
    """Create or reuse a local application row linked to an approved résumé."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                (str(compilation_id),),
            )
            await cur.execute(
                """
                SELECT resume_id, status, job_id, jd_text
                  FROM career_graph_compilations
                 WHERE id = %s AND user_id = %s
                 FOR UPDATE
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError("compilation not found")
            resume_id, status, job_id, jd_text = row
            if status not in {"approved", "published"}:
                raise CareerGraphStateError(
                    "approve the compilation before creating an application draft"
                )

            if not job_id:
                external_id = f"career-graph:{compilation_id}"
                await cur.execute(
                    """
                    INSERT INTO jobs (
                        source, external_id, company, role_title, jd_text, url
                    ) VALUES ('manual', %s, %s, %s, %s, %s)
                    ON CONFLICT (source, external_id) DO UPDATE
                        SET company = EXCLUDED.company,
                            role_title = EXCLUDED.role_title,
                            jd_text = EXCLUDED.jd_text,
                            url = EXCLUDED.url
                    RETURNING id
                    """,
                    (external_id, company, role_title, jd_text, job_url),
                )
                job_row = await cur.fetchone()
                if not job_row:
                    raise RuntimeError("failed to create application job")
                job_id = job_row[0]
                await cur.execute(
                    """
                    UPDATE career_graph_compilations
                       SET job_id = %s
                     WHERE id = %s AND user_id = %s
                    """,
                    (str(job_id), str(compilation_id), str(user_id)),
                )

            await cur.execute(
                """
                SELECT id, status
                  FROM application_drafts
                 WHERE user_id = %s
                   AND job_id = %s
                   AND resume_version_id = %s
                 ORDER BY created_at DESC
                 LIMIT 1
                """,
                (str(user_id), str(job_id), str(resume_id)),
            )
            application_row = await cur.fetchone()
            reused = application_row is not None
            if not application_row:
                await cur.execute(
                    """
                    INSERT INTO application_drafts (
                        user_id, job_id, status, resume_version_id
                    ) VALUES (%s, %s, 'review', %s)
                    RETURNING id, status
                    """,
                    (str(user_id), str(job_id), str(resume_id)),
                )
                application_row = await cur.fetchone()
            if not application_row:
                raise RuntimeError("failed to create application draft")
        await conn.commit()

    return {
        "ok": True,
        "application_id": str(application_row[0]),
        "application_status": application_row[1],
        "compilation_id": str(compilation_id),
        "resume_id": str(resume_id),
        "job_id": str(job_id),
        "job_url": job_url,
        "reused": reused,
        "server_side_submission": False,
    }


async def application_handoff(
    user_id: UUID,
    compilation_id: UUID,
    *,
    job_url: str,
) -> dict[str, Any]:
    """Return an approved package for Codex Chrome; never submit server-side."""

    compilation = await get_compilation(user_id, compilation_id)
    if not compilation:
        raise CareerGraphNotFoundError("compilation not found")
    if compilation["status"] not in {"approved", "published"}:
        raise CareerGraphStateError("approve the compilation before browser handoff")
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id
                  FROM application_drafts
                 WHERE user_id = %s AND resume_version_id = %s
                 ORDER BY created_at DESC
                 LIMIT 1
                """,
                (str(user_id), compilation["resume_id"]),
            )
            application_row = await cur.fetchone()
    return {
        "compilation_id": str(compilation_id),
        "application_id": str(application_row[0]) if application_row else None,
        "job_url": job_url,
        "resume_id": compilation["resume_id"],
        "resume": compilation["resume"],
        "selection_manifest": compilation["selection_manifest"],
        "guard_report": compilation["guard_report"],
        "execution": "user_browser_only",
        "requires_submit_confirmation": True,
        "forbidden_automation": [
            "password entry",
            "CAPTCHA solving or bypass",
            "clicking the final Submit/Apply button without explicit user approval",
        ],
    }
