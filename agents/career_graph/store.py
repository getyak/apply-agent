"""Owner-scoped PostgreSQL persistence for Career Graph review workflows."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import psycopg

from agents.career_graph.feedback import aggregate_evidence_outcomes, evidence_scores
from agents.career_graph.importer import json_resume_to_operations
from agents.career_graph.model import (
    apply_operations,
    compile_resume,
    empty_snapshot,
    summarize_snapshot_changes,
)


class CareerGraphNotFoundError(LookupError):
    pass


class CareerGraphConflictError(RuntimeError):
    pass


class CareerGraphStateError(RuntimeError):
    pass


EVIDENCE_REPORT_APPLICATION_LIMIT = 1000
EVIDENCE_REPORT_HISTORY_APPLICATION_LIMIT = 100
EVIDENCE_REPORT_EVENT_LIMIT_PER_APPLICATION = 100
ARTIFACT_DELIVERY_TTL_MINUTES = 10
ARTIFACT_DELIVERY_MAX_DOWNLOADS = 5
SUBMISSION_AUTHORIZATION_TTL_MINUTES = 5


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


def _questionnaire_payload(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "questionnaire_id": str(row[0]),
        "schema_version": 1,
        "revision": int(row[1]),
        "status": row[2],
        "job_identity": _coerce_json(row[3]),
        "fields": _coerce_json(row[4]),
        "summary": _coerce_json(row[5]),
        "created_at": row[6].isoformat(),
        "reviewed_at": row[7].isoformat() if row[7] else None,
        "approval_source": row[8],
    }


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
                       jsonb_array_length(COALESCE(r.snapshot->'edges', '[]'::jsonb)),
                       (
                           SELECT COUNT(*)::int
                             FROM career_graph_change_sets c
                            WHERE c.graph_id = g.id AND c.status = 'pending'
                       ),
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
            "edge_count": int(row[6]) if row[6] is not None else 0,
            "pending_change_count": int(row[7]) if row[7] is not None else 0,
            "created_at": row[8].isoformat(),
            "updated_at": row[9].isoformat(),
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


def _compilation_quality_summary(value: Any) -> dict[str, Any]:
    report = _coerce_json(value)
    if not isinstance(report, dict):
        return {}
    ats = report.get("ats")
    length = report.get("length")
    coverage = report.get("jd_coverage")
    selection = report.get("selection")
    warnings = report.get("warnings")
    return {
        "quality_status": report.get("quality_status"),
        "warning_count": len(warnings) if isinstance(warnings, list) else 0,
        "ats_ready": ats.get("ready") if isinstance(ats, dict) else None,
        "length_budget": length.get("budget") if isinstance(length, dict) else None,
        "target_pages": length.get("target_pages") if isinstance(length, dict) else None,
        "estimated_pages": (length.get("estimated_pages") if isinstance(length, dict) else None),
        "within_estimated_budget": (
            length.get("within_budget") if isinstance(length, dict) else None
        ),
        "jd_coverage_ratio": (
            coverage.get("coverage_ratio") if isinstance(coverage, dict) else None
        ),
        "selected_node_count": (
            selection.get("selected_node_count") if isinstance(selection, dict) else None
        ),
        "omitted_node_count": (
            selection.get("omitted_node_count") if isinstance(selection, dict) else None
        ),
    }


def _text_preview(value: str, *, limit: int = 240) -> tuple[str, bool]:
    normalized = " ".join(value.split())
    return normalized[:limit], len(normalized) > limit


async def list_compilations(
    user_id: UUID,
    *,
    graph_id: UUID | None = None,
    status: str | None = None,
    limit: int = 21,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List compact owner-scoped compilation versions for session recovery."""

    graph_filter = str(graph_id) if graph_id else None
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.id, c.graph_id, c.graph_revision_id, revision.revision,
                       c.job_id, c.jd_fingerprint, c.jd_text, c.resume_id,
                       resume.version, c.status, c.compiler_config,
                       c.quality_report, resume.publish_token, c.created_at,
                       c.approved_at, c.published_at, job.company,
                       job.role_title, job.url,
                       (
                           SELECT count(*)::int
                             FROM application_drafts application
                            WHERE application.user_id = c.user_id
                              AND application.resume_version_id = c.resume_id
                       ) AS tracked_application_count
                  FROM career_graph_compilations c
                  JOIN career_graph_revisions revision
                    ON revision.id = c.graph_revision_id
                  JOIN resumes resume ON resume.id = c.resume_id
                  LEFT JOIN jobs job ON job.id = c.job_id
                 WHERE c.user_id = %s
                   AND (%s::uuid IS NULL OR c.graph_id = %s::uuid)
                   AND (%s::text IS NULL OR c.status = %s::text)
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT %s OFFSET %s
                """,
                (
                    str(user_id),
                    graph_filter,
                    graph_filter,
                    status,
                    status,
                    limit,
                    offset,
                ),
            )
            rows = await cur.fetchall()
    return [
        {
            "id": str(row[0]),
            "graph_id": str(row[1]),
            "graph_revision_id": str(row[2]),
            "graph_revision": int(row[3]),
            "job_id": str(row[4]) if row[4] else None,
            "jd_fingerprint": row[5],
            "jd_preview": _text_preview(row[6])[0],
            "jd_preview_truncated": _text_preview(row[6])[1],
            "resume_id": str(row[7]),
            "resume_version": int(row[8]),
            "status": row[9],
            "compiler_config": _coerce_json(row[10]),
            "quality_summary": _compilation_quality_summary(row[11]),
            "publish_token": row[12],
            "created_at": row[13].isoformat(),
            "approved_at": row[14].isoformat() if row[14] else None,
            "published_at": row[15].isoformat() if row[15] else None,
            "job": (
                {
                    "company": row[16],
                    "role_title": row[17],
                    "url": row[18],
                }
                if row[16] is not None or row[17] is not None or row[18] is not None
                else None
            ),
            "tracked_application_count": int(row[19]),
        }
        for row in rows
    ]


async def list_tracked_applications(
    user_id: UUID,
    *,
    graph_id: UUID | None = None,
    status: str | None = None,
    limit: int = 21,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List Career Graph applications without form answers or file capabilities."""

    graph_filter = str(graph_id) if graph_id else None
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT application.id, compilation.id, compilation.graph_id,
                       compilation.graph_revision_id, revision.revision,
                       compilation.jd_fingerprint, application.resume_version_id,
                       resume.version, application.status, application.outcome,
                       application.submitted_at, application.submitted_via,
                       application.interview_date, application.created_at,
                       application.updated_at, job.id, job.company, job.role_title,
                       job.url, COALESCE(history.event_count, 0),
                       latest.event_kind, latest.event_source, latest.changed_fields,
                       latest.to_status, latest.occurred_at
                  FROM application_drafts application
                  JOIN career_graph_compilations compilation
                    ON compilation.user_id = application.user_id
                   AND compilation.resume_id = application.resume_version_id
                  JOIN career_graph_revisions revision
                    ON revision.id = compilation.graph_revision_id
                  JOIN resumes resume ON resume.id = application.resume_version_id
                  JOIN jobs job ON job.id = application.job_id
                  LEFT JOIN LATERAL (
                      SELECT count(*)::int AS event_count
                        FROM application_outcome_events event
                       WHERE event.user_id = application.user_id
                         AND event.application_id = application.id
                  ) history ON true
                  LEFT JOIN LATERAL (
                      SELECT event_kind, event_source, changed_fields,
                             to_status, occurred_at
                        FROM application_outcome_events event
                       WHERE event.user_id = application.user_id
                         AND event.application_id = application.id
                       ORDER BY occurred_at DESC, id DESC
                       LIMIT 1
                  ) latest ON true
                 WHERE application.user_id = %s
                   AND (%s::uuid IS NULL OR compilation.graph_id = %s::uuid)
                   AND (%s::text IS NULL OR application.status = %s::text)
                 ORDER BY application.updated_at DESC, application.id DESC
                 LIMIT %s OFFSET %s
                """,
                (
                    str(user_id),
                    graph_filter,
                    graph_filter,
                    status,
                    status,
                    limit,
                    offset,
                ),
            )
            rows = await cur.fetchall()
    return [
        {
            "application_id": str(row[0]),
            "compilation_id": str(row[1]),
            "graph_id": str(row[2]),
            "graph_revision_id": str(row[3]),
            "graph_revision": int(row[4]),
            "jd_fingerprint": row[5],
            "resume_id": str(row[6]),
            "resume_version": int(row[7]),
            "status": row[8],
            "outcome": row[9],
            "submitted_at": row[10].isoformat() if row[10] else None,
            "submitted_via": row[11],
            "interview_date": row[12].isoformat() if row[12] else None,
            "created_at": row[13].isoformat(),
            "updated_at": row[14].isoformat(),
            "job": {
                "id": str(row[15]),
                "company": row[16],
                "role_title": row[17],
                "url": row[18],
            },
            "history_event_count": int(row[19]),
            "latest_history_event": (
                {
                    "event_kind": row[20],
                    "event_source": row[21],
                    "changed_fields": list(row[22] or []),
                    "to_status": row[23],
                    "occurred_at": row[24].isoformat(),
                }
                if row[20]
                else None
            ),
            "server_side_submission": False,
        }
        for row in rows
    ]


async def get_application_projection(user_id: UUID, application_id: UUID) -> dict[str, Any] | None:
    """Read the owner-scoped fields used to reconcile lifecycle writes."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, status, outcome, submitted_at, submitted_via,
                       interview_date, updated_at
                  FROM application_drafts
                 WHERE id = %s AND user_id = %s
                 LIMIT 1
                """,
                (str(application_id), str(user_id)),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "application_id": str(row[0]),
        "status": row[1],
        "outcome": row[2],
        "submitted_at": row[3].isoformat() if row[3] else None,
        "submitted_via": row[4],
        "interview_date": row[5].isoformat() if row[5] else None,
        "updated_at": row[6].isoformat(),
    }


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
    review_summary = summarize_snapshot_changes(base_snapshot, proposed_snapshot)
    if review_summary["total_changes"] == 0:
        raise CareerGraphStateError("proposal does not change the current Career Graph")
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
        "review_summary": review_summary,
        "confirmation": {
            "approve": f"APPROVE CAREER CHANGE {change_set_id}",
            "reject": f"REJECT CAREER CHANGE {change_set_id}",
        },
        "requires_human_approval": True,
    }


def _public_change_set(row: tuple[Any, ...]) -> dict[str, Any]:
    base_snapshot = _coerce_json(row[11]) if row[11] else empty_snapshot()
    proposed_snapshot = _coerce_json(row[4])
    return {
        "id": str(row[0]),
        "graph_id": str(row[1]),
        "base_revision_id": str(row[2]) if row[2] else None,
        "operations": _coerce_json(row[3]),
        "proposed_snapshot": proposed_snapshot,
        "summary": row[5],
        "status": row[6],
        "proposed_by": row[7],
        "decided_via": row[8],
        "created_at": row[9].isoformat(),
        "decided_at": row[10].isoformat() if row[10] else None,
        "review_summary": summarize_snapshot_changes(base_snapshot, proposed_snapshot),
        "confirmation": {
            "approve": f"APPROVE CAREER CHANGE {row[0]}",
            "reject": f"REJECT CAREER CHANGE {row[0]}",
        },
    }


async def get_change_set(user_id: UUID, change_set_id: UUID) -> dict[str, Any] | None:
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.id, c.graph_id, c.base_revision_id, c.operations,
                       c.proposed_snapshot, c.summary, c.status, c.proposed_by,
                       c.decided_via, c.created_at, c.decided_at, b.snapshot
                  FROM career_graph_change_sets c
                  LEFT JOIN career_graph_revisions b
                    ON b.id = c.base_revision_id
                 WHERE c.id = %s AND c.user_id = %s
                """,
                (str(change_set_id), str(user_id)),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return _public_change_set(row)


async def list_change_sets(
    user_id: UUID,
    *,
    status: str | None = "pending",
    graph_id: UUID | None = None,
) -> list[dict[str, Any]]:
    """List owner-scoped review items with exact node/edge diffs."""

    clauses = ["c.user_id = %s"]
    params: list[str] = [str(user_id)]
    if status is not None:
        clauses.append("c.status = %s")
        params.append(status)
    if graph_id is not None:
        clauses.append("c.graph_id = %s")
        params.append(str(graph_id))

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT c.id, c.graph_id, c.base_revision_id, c.operations,
                       c.proposed_snapshot, c.summary, c.status, c.proposed_by,
                       c.decided_via, c.created_at, c.decided_at, b.snapshot
                  FROM career_graph_change_sets c
                  LEFT JOIN career_graph_revisions b
                    ON b.id = c.base_revision_id
                 WHERE {" AND ".join(clauses)}
                 ORDER BY c.created_at DESC
                """,
                tuple(params),
            )
            rows = await cur.fetchall()
    return [_public_change_set(row) for row in rows]


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
                       c.summary, c.status, c.proposed_by, g.current_revision_id,
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
                proposed_by,
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
                ) VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    str(revision_id),
                    str(graph_id),
                    next_revision,
                    _json(_coerce_json(proposed_snapshot)),
                    summary,
                    proposed_by,
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
    artifact_locale: str = "en",
    length_budget: str = "two_page",
    ats_profile: str = "standard",
    max_achievements_per_role: int | None = None,
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
        artifact_locale=artifact_locale,
        length_budget=length_budget,
        ats_profile=ats_profile,
        max_achievements_per_role=max_achievements_per_role,
        evidence_ranking=evidence_scores(feedback_report),
    )
    compilation_id = uuid4()
    resume_id = uuid4()
    fingerprint = hashlib.sha256(jd_text.encode("utf-8")).hexdigest()
    label = f"Career Graph r{revision['revision']} · JD {fingerprint[:8]}"
    persisted_resume = {
        "raw": "",
        "parsed": compiled["resume"],
        "warnings": compiled["quality_report"]["warnings"],
        "parsedAt": datetime.now(UTC).isoformat(),
        "artifactLocale": compiled["compiler_config"]["artifact_locale"],
        "compilerConfig": compiled["compiler_config"],
    }

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
                    _json(persisted_resume),
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
                    guard_report, compiler_config, quality_report
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                    _json(compiled["compiler_config"]),
                    _json(compiled["quality_report"]),
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
    """Map immutable application history back to selected graph evidence."""

    graph = await get_graph(user_id, graph_id)
    if not graph:
        raise CareerGraphNotFoundError("Career Graph not found")

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT a.id, a.status, a.submitted_at, a.interview_date,
                       a.outcome, c.guard_report, c.jd_fingerprint,
                       c.compiler_config, COALESCE(history.event_count, 0),
                       CASE
                           WHEN history.observed_offer THEN 'offer'
                           WHEN history.observed_interview THEN 'interview'
                           WHEN history.observed_submitted THEN 'submitted'
                           ELSE 'prepared'
                       END AS furthest_observed_stage,
                       count(*) OVER () AS total_application_count
                  FROM career_graph_compilations c
                  JOIN application_drafts a
                    ON a.resume_version_id = c.resume_id
                   AND a.user_id = c.user_id
                  LEFT JOIN LATERAL (
                      SELECT
                          count(*) AS event_count,
                          COALESCE(bool_or(
                              e.to_status IN ('offer', 'accepted')
                          ), false) AS observed_offer,
                          COALESCE(bool_or(
                              e.to_status = 'interview'
                              OR e.interview_date IS NOT NULL
                          ), false) AS observed_interview,
                          COALESCE(bool_or(
                              e.to_status IN (
                                  'submitted', 'rejected', 'withdrawn',
                                  'ghosted', 'closed'
                              )
                              OR e.submitted_at IS NOT NULL
                          ), false) AS observed_submitted
                        FROM application_outcome_events e
                       WHERE e.application_id = a.id
                         AND e.user_id = a.user_id
                  ) history ON true
                 WHERE c.graph_id = %s AND c.user_id = %s
                 ORDER BY a.created_at DESC, a.id
                 LIMIT %s
                """,
                (
                    str(graph_id),
                    str(user_id),
                    EVIDENCE_REPORT_APPLICATION_LIMIT,
                ),
            )
            application_rows = await cur.fetchall()
            await cur.execute(
                """
                WITH owned_applications AS (
                    SELECT a.id
                      FROM career_graph_compilations c
                     JOIN application_drafts a
                        ON a.resume_version_id = c.resume_id
                       AND a.user_id = c.user_id
                     WHERE c.graph_id = %s AND c.user_id = %s
                     ORDER BY a.created_at DESC, a.id
                     LIMIT %s
                ),
                ranked_events AS (
                    SELECT e.application_id, e.event_kind, e.event_source,
                           e.changed_fields, e.from_status, e.to_status,
                           e.from_outcome, e.to_outcome, e.submitted_at,
                           e.submitted_via, e.interview_date, e.occurred_at,
                           row_number() OVER (
                               PARTITION BY e.application_id
                               ORDER BY e.occurred_at DESC, e.id DESC
                           ) AS event_rank,
                           count(*) OVER (
                               PARTITION BY e.application_id
                           ) AS event_count
                      FROM application_outcome_events e
                      JOIN owned_applications owned
                        ON owned.id = e.application_id
                )
                SELECT application_id, event_kind, event_source, changed_fields,
                       from_status, to_status, from_outcome, to_outcome,
                       submitted_at, submitted_via, interview_date, occurred_at,
                       event_count
                  FROM ranked_events
                 WHERE event_rank <= %s
                 ORDER BY application_id, occurred_at, event_rank DESC
                """,
                (
                    str(graph_id),
                    str(user_id),
                    EVIDENCE_REPORT_HISTORY_APPLICATION_LIMIT,
                    EVIDENCE_REPORT_EVENT_LIMIT_PER_APPLICATION,
                ),
            )
            event_rows = await cur.fetchall()

    history_by_application: dict[str, list[dict[str, Any]]] = {}
    for row in event_rows:
        application_id = str(row[0])
        history_by_application.setdefault(application_id, []).append(
            {
                "event_kind": row[1],
                "event_source": row[2],
                "changed_fields": list(row[3] or []),
                "from_status": row[4],
                "to_status": row[5],
                "from_outcome": row[6],
                "to_outcome": row[7],
                "submitted_at": row[8].isoformat() if row[8] else None,
                "submitted_via": row[9],
                "interview_date": row[10].isoformat() if row[10] else None,
                "occurred_at": row[11].isoformat(),
            }
        )
    records: list[dict[str, Any]] = []
    for row in application_rows:
        application_id = str(row[0])
        guard_report = _coerce_json(row[5])
        selected_node_ids = (
            guard_report.get("selected_node_ids") if isinstance(guard_report, dict) else []
        )
        history = history_by_application.get(application_id, [])
        event_count = int(row[8])
        records.append(
            {
                "application_id": application_id,
                "status": row[1],
                "submitted_at": row[2],
                "interview_date": row[3],
                "outcome": row[4],
                "selected_node_ids": selected_node_ids,
                "jd_fingerprint": row[6],
                "compiler_config": _coerce_json(row[7]),
                "furthest_observed_stage": row[9],
                "history": history,
                "history_event_count": event_count,
                "history_truncated": event_count > len(history),
            }
        )
    report = aggregate_evidence_outcomes(records)
    total_application_count = int(application_rows[0][10]) if application_rows else 0
    return {
        "graph_id": str(graph_id),
        "graph_revision": (
            graph["current_revision"]["revision"] if graph["current_revision"] else 0
        ),
        "report_scope": {
            "application_count_total": total_application_count,
            "application_count_included": len(records),
            "applications_truncated": total_application_count > len(records),
            "application_limit": EVIDENCE_REPORT_APPLICATION_LIMIT,
            "history_application_limit": EVIDENCE_REPORT_HISTORY_APPLICATION_LIMIT,
            "event_limit_per_application": EVIDENCE_REPORT_EVENT_LIMIT_PER_APPLICATION,
        },
        **report,
    }


async def record_application_transition(
    user_id: UUID,
    application_id: UUID,
    *,
    status: str,
    evidence_source: str,
    outcome: str | None = None,
    interview_date: str | None = None,
    clear_interview_date: bool = False,
    submitted_via: str | None = None,
    submission_authorization_id: UUID | None = None,
) -> dict[str, Any]:
    """Record one user/browser-observed transition on a graph-linked application."""

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
    if submitted_via is not None and submitted_via not in allowed_submit_channels:
        raise CareerGraphStateError("unsupported submission channel")
    if interview_date is not None and clear_interview_date:
        raise CareerGraphStateError(
            "interview_date and clear_interview_date cannot be used together"
        )

    assignments = ["status = %s"]
    params: list[Any] = [status]
    if outcome is not None:
        assignments.append("outcome = %s")
        params.append(outcome.strip() or None)
    if interview_date is not None:
        assignments.append("interview_date = %s")
        params.append(interview_date)
    elif clear_interview_date:
        assignments.append("interview_date = NULL")
    if status == "submitted":
        assignments.extend(
            [
                "submitted_at = COALESCE(submitted_at, now())",
                "submitted_via = COALESCE(submitted_via, %s)",
            ]
        )
        params.append(submitted_via or "client_extension")

    event_source = f"codex_mcp_{evidence_source}"
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT set_config('relay.application_event_source', %s, true)",
                (event_source,),
            )
            if submission_authorization_id is not None:
                await cur.execute(
                    """
                    SELECT
                        set_config(
                            'relay.application_submission_authorization_id',
                            %s,
                            true
                        ),
                        set_config(
                            'relay.application_submission_authorization_writer',
                            'codex_mcp_browser_confirmation',
                            true
                        )
                    """,
                    (str(submission_authorization_id),),
                )
            try:
                await cur.execute(
                    f"""
                    UPDATE application_drafts a
                       SET {", ".join(assignments)}
                     WHERE a.id = %s
                       AND a.user_id = %s
                       AND EXISTS (
                           SELECT 1
                             FROM career_graph_compilations c
                            WHERE c.resume_id = a.resume_version_id
                              AND c.user_id = a.user_id
                       )
                    RETURNING a.id, a.status, a.outcome, a.submitted_at,
                              a.submitted_via, a.interview_date
                    """,
                    (*params, str(application_id), str(user_id)),
                )
            except psycopg.errors.CheckViolation as exc:
                if submission_authorization_id is not None:
                    raise CareerGraphStateError(
                        "browser-confirmed MCP submission authorization is unavailable or expired"
                    ) from exc
                raise
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError("Career Graph application not found")
            await cur.execute(
                """
                SELECT id, event_kind, event_source, changed_fields, occurred_at
                  FROM application_outcome_events
                 WHERE application_id = %s AND user_id = %s
                   AND event_source = %s
                   AND occurred_at >= transaction_timestamp()
                 ORDER BY occurred_at DESC, id DESC
                 LIMIT 1
                """,
                (str(application_id), str(user_id), event_source),
            )
            event = await cur.fetchone()
            authorization = None
            if submission_authorization_id is not None:
                await cur.execute(
                    """
                    SELECT id, authorized_at, expires_at, consumed_at, invalidated_at
                      FROM application_submission_authorizations
                     WHERE id = %s
                       AND user_id = %s
                       AND application_id = %s
                    """,
                    (
                        str(submission_authorization_id),
                        str(user_id),
                        str(application_id),
                    ),
                )
                authorization = await cur.fetchone()
                if not authorization or authorization[3] is None:
                    raise CareerGraphStateError(
                        "browser-confirmed MCP submission authorization is unavailable or expired"
                    )
        await conn.commit()

    event_is_new = event is not None
    return {
        "ok": True,
        "application_id": str(row[0]),
        "status": row[1],
        "outcome": row[2],
        "submitted_at": row[3].isoformat() if row[3] else None,
        "submitted_via": row[4],
        "interview_date": row[5].isoformat() if row[5] else None,
        "history_event": (
            {
                "id": str(event[0]),
                "event_kind": event[1],
                "event_source": event[2],
                "changed_fields": list(event[3] or []),
                "occurred_at": event[4].isoformat(),
            }
            if event
            else None
        ),
        "changed": event_is_new,
        "submission_authorization": (
            {
                "id": str(authorization[0]),
                "authorized_at": authorization[1].isoformat(),
                "expires_at": authorization[2].isoformat(),
                "consumed_at": (authorization[3].isoformat() if authorization[3] else None),
                "invalidated_at": (authorization[4].isoformat() if authorization[4] else None),
                "consumed": authorization[3] is not None,
            }
            if authorization
            else None
        ),
        "facts_changed": False,
        "requires_human_review_for_future_compilation": True,
    }


async def issue_application_submission_authorization(
    user_id: UUID,
    application_id: UUID,
    compilation_id: UUID,
    *,
    job_url: str,
    observed_url: str,
    confirmation: str,
    operation_id: UUID | None = None,
) -> dict[str, Any]:
    """Record one short-lived exact confirmation without submitting anything."""

    expected_confirmation = f"SUBMIT APPLICATION {application_id}"
    if confirmation != expected_confirmation:
        raise CareerGraphStateError(
            "application submission authorization requires the exact confirmation phrase"
        )

    fingerprints = {
        "expected_job_url": hashlib.sha256(job_url.encode("utf-8")).hexdigest(),
        "observed_url": hashlib.sha256(observed_url.encode("utf-8")).hexdigest(),
        "confirmation": hashlib.sha256(confirmation.encode("utf-8")).hexdigest(),
    }

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                    set_config(
                        'relay.application_submission_authorization_writer',
                        'codex_mcp_authorize',
                        true
                    ),
                    pg_advisory_xact_lock(hashtext(%s))
                """,
                (str(application_id),),
            )
            await cur.execute(
                """
                SELECT application.status,
                       application.resume_version_id,
                       job.url,
                       compilation.resume_id,
                       compilation.status
                  FROM application_drafts AS application
                  JOIN jobs AS job ON job.id = application.job_id
                  JOIN career_graph_compilations AS compilation
                    ON compilation.id = %s
                   AND compilation.user_id = application.user_id
                   AND compilation.job_id = application.job_id
                 WHERE application.id = %s
                   AND application.user_id = %s
                 FOR UPDATE OF application, compilation
                """,
                (str(compilation_id), str(application_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError(
                    "application and compilation authorization scope not found"
                )
            (
                application_status,
                application_resume_id,
                expected_job_url,
                compilation_resume_id,
                compilation_status,
            ) = row
            if application_resume_id != compilation_resume_id:
                raise CareerGraphStateError("application no longer matches this résumé compilation")
            if application_status != "review":
                raise CareerGraphStateError("only an application awaiting review can be authorized")
            if compilation_status not in {"approved", "published"}:
                raise CareerGraphStateError("approve the compilation before authorizing submission")
            if expected_job_url != job_url:
                raise CareerGraphStateError(
                    "authorization must use the application's exact job URL"
                )

            await cur.execute(
                """
                UPDATE application_submission_authorizations
                   SET invalidated_at = transaction_timestamp()
                 WHERE user_id = %s
                   AND application_id = %s
                   AND consumed_at IS NULL
                   AND invalidated_at IS NULL
                """,
                (str(user_id), str(application_id)),
            )
            await cur.execute(
                """
                INSERT INTO application_submission_authorizations (
                    user_id,
                    application_id,
                    compilation_id,
                    operation_id,
                    expected_job_url_fingerprint,
                    observed_url_fingerprint,
                    confirmation_digest,
                    expires_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s,
                    transaction_timestamp() + (%s * interval '1 minute')
                )
                RETURNING id, authorized_at, expires_at
                """,
                (
                    str(user_id),
                    str(application_id),
                    str(compilation_id),
                    str(operation_id) if operation_id else None,
                    fingerprints["expected_job_url"],
                    fingerprints["observed_url"],
                    fingerprints["confirmation"],
                    SUBMISSION_AUTHORIZATION_TTL_MINUTES,
                ),
            )
            authorization = await cur.fetchone()
            if not authorization:
                raise RuntimeError("failed to issue application submission authorization")
        await conn.commit()

    return {
        "ok": True,
        "submission_authorization_id": str(authorization[0]),
        "application_id": str(application_id),
        "compilation_id": str(compilation_id),
        "authorized_at": authorization[1].isoformat(),
        "expires_at": authorization[2].isoformat(),
        "authorization_active": True,
        "authorization_scope": "one_application_one_final_click",
        "one_final_click_authorized": True,
        "server_side_submission": False,
        "post_click_requirement": (
            "Record submitted only after a visible post-submit confirmation."
        ),
    }


async def get_application_submission_authorization_for_operation(
    user_id: UUID,
    operation_id: UUID,
) -> dict[str, Any] | None:
    """Read the exact browser authorization minted by one durable operation."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, application_id, compilation_id, authorized_at,
                       expires_at, consumed_at, invalidated_at,
                       consumed_at IS NULL
                           AND invalidated_at IS NULL
                           AND expires_at > clock_timestamp() AS authorization_active
                  FROM application_submission_authorizations
                 WHERE user_id = %s
                   AND operation_id = %s
                """,
                (str(user_id), str(operation_id)),
            )
            row = await cur.fetchone()
    if not row:
        return None
    active = bool(row[7])
    return {
        "ok": True,
        "submission_authorization_id": str(row[0]),
        "application_id": str(row[1]),
        "compilation_id": str(row[2]),
        "authorized_at": row[3].isoformat(),
        "expires_at": row[4].isoformat(),
        "consumed_at": row[5].isoformat() if row[5] else None,
        "invalidated_at": row[6].isoformat() if row[6] else None,
        "authorization_active": active,
        "authorization_scope": "one_application_one_final_click",
        "one_final_click_authorized": active,
        "server_side_submission": False,
        "post_click_requirement": (
            "Record submitted only after a visible post-submit confirmation."
        ),
    }


async def get_compilation(user_id: UUID, compilation_id: UUID) -> dict[str, Any] | None:
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.id, c.graph_id, c.graph_revision_id, r.revision,
                       c.job_id, c.jd_fingerprint, c.resume_id, rv.version,
                       rv.content, c.status, c.selection_manifest,
                       c.guard_report, c.compiler_config, c.quality_report,
                       rv.publish_token, c.created_at, c.approved_at,
                       c.published_at, job.company, job.role_title, job.url,
                       job.source, job.external_id
                  FROM career_graph_compilations c
                  JOIN career_graph_revisions r ON r.id = c.graph_revision_id
                  JOIN resumes rv ON rv.id = c.resume_id
                  LEFT JOIN jobs job ON job.id = c.job_id
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
        "resume": _unwrap_resume_content(row[8]),
        "status": row[9],
        "selection_manifest": _coerce_json(row[10]),
        "guard_report": _coerce_json(row[11]),
        "compiler_config": _coerce_json(row[12]),
        "quality_report": _coerce_json(row[13]),
        "publish_token": row[14],
        "created_at": row[15].isoformat(),
        "approved_at": row[16].isoformat() if row[16] else None,
        "published_at": row[17].isoformat() if row[17] else None,
        "job_identity": (
            {
                "company": row[18],
                "role_title": row[19],
                "job_url": row[20],
                "source": row[21],
                "external_id": row[22],
            }
            if row[18] is not None or row[19] is not None or row[20] is not None
            else None
        ),
    }


async def issue_compilation_artifact_review(
    user_id: UUID,
    compilation_id: UUID,
    *,
    artifact_format: str,
) -> dict[str, Any]:
    """Issue a short-lived artifact for reviewing a compilation draft."""

    if artifact_format not in {"pdf", "docx"}:
        raise CareerGraphStateError("artifact_format must be 'pdf' or 'docx'")

    download_code = secrets.token_hex(32)
    token_digest = hashlib.sha256(download_code.encode("utf-8")).hexdigest()
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
            if row[1] == "rejected":
                raise CareerGraphStateError("rejected compilations cannot create review artifacts")
            await cur.execute(
                """
                UPDATE resume_artifact_delivery_grants
                   SET revoked_at = now()
                 WHERE user_id = %s
                   AND compilation_id = %s
                   AND purpose = 'compilation_review'
                   AND artifact_format = %s
                   AND revoked_at IS NULL
                """,
                (str(user_id), str(compilation_id), artifact_format),
            )
            await cur.execute(
                """
                INSERT INTO resume_artifact_delivery_grants (
                    user_id, compilation_id, application_id, purpose,
                    artifact_format, token_digest, expires_at, max_downloads
                ) VALUES (
                    %s, %s, NULL, 'compilation_review', %s, %s,
                    now() + make_interval(mins => %s),
                    %s
                )
                RETURNING id, expires_at, max_downloads
                """,
                (
                    str(user_id),
                    str(compilation_id),
                    artifact_format,
                    token_digest,
                    ARTIFACT_DELIVERY_TTL_MINUTES,
                    ARTIFACT_DELIVERY_MAX_DOWNLOADS,
                ),
            )
            grant = await cur.fetchone()
        await conn.commit()
    if not grant:
        raise RuntimeError("failed to create résumé artifact review grant")
    return {
        "grant_id": str(grant[0]),
        "purpose": "compilation_review",
        "compilation_id": str(compilation_id),
        "compilation_status": row[1],
        "application_id": None,
        "resume_id": str(row[0]),
        "artifact_format": artifact_format,
        "download_code": download_code,
        "expires_at": grant[1].isoformat(),
        "max_downloads": int(grant[2]),
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
    token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT compilation.resume_id, compilation.status,
                       compilation.graph_id, resume.publish_token
                  FROM career_graph_compilations compilation
                  JOIN resumes resume ON resume.id = compilation.resume_id
                 WHERE compilation.id = %s
                   AND compilation.user_id = %s
                 FOR UPDATE OF compilation, resume
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError("compilation not found")
            resume_id, status, graph_id, active_token = row
            if status != "approved":
                raise CareerGraphStateError("only an approved compilation can be published")
            if active_token:
                raise CareerGraphStateError(
                    "compilation already owns an active public résumé link; "
                    "use the update or revoke workflow"
                )
            await cur.execute(
                """
                SELECT set_config(
                    'relay.career_graph_publication_writer',
                    'codex_mcp_publish',
                    true
                )
                """
            )
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
            await cur.execute(
                """
                INSERT INTO career_graph_publication_events (
                    user_id, graph_id, event_kind, event_source,
                    from_compilation_id, to_compilation_id,
                    public_token_digest
                ) VALUES (
                    %s, %s, 'published', 'codex_mcp_explicit_confirmation',
                    NULL, %s, %s
                )
                RETURNING id, occurred_at
                """,
                (
                    str(user_id),
                    str(graph_id),
                    str(compilation_id),
                    token_digest,
                ),
            )
            event = await cur.fetchone()
        await conn.commit()
    if not event:
        raise RuntimeError("failed to record Career Graph publication")
    return {
        "ok": True,
        "compilation_id": str(compilation_id),
        "resume_id": str(resume_id),
        "status": "published",
        "public_url": f"{public_base_url.rstrip('/')}/r/{token}",
        "publication_active": True,
        "publication_event": {
            "id": str(event[0]),
            "event_kind": "published",
            "occurred_at": event[1].isoformat(),
        },
    }


async def update_published_compilation(
    user_id: UUID,
    source_compilation_id: UUID,
    target_compilation_id: UUID,
    *,
    confirmation: str,
    public_base_url: str,
) -> dict[str, Any]:
    """Move one stable public URL to a new approved immutable compilation."""

    expected = f"UPDATE PUBLIC RESUME {source_compilation_id} TO {target_compilation_id}"
    if confirmation != expected:
        raise CareerGraphStateError(f"explicit confirmation required: {expected}")
    if source_compilation_id == target_compilation_id:
        raise CareerGraphStateError("source and target compilations must be different")

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT compilation.id, compilation.graph_id,
                       compilation.resume_id, compilation.status,
                       resume.publish_token
                  FROM career_graph_compilations compilation
                  JOIN resumes resume ON resume.id = compilation.resume_id
                 WHERE compilation.user_id = %s
                   AND compilation.id IN (%s, %s)
                 ORDER BY compilation.id
                 FOR UPDATE OF compilation, resume
                """,
                (
                    str(user_id),
                    str(source_compilation_id),
                    str(target_compilation_id),
                ),
            )
            rows = await cur.fetchall()
            by_id = {str(row[0]): row for row in rows}
            source = by_id.get(str(source_compilation_id))
            target = by_id.get(str(target_compilation_id))
            if not source or not target:
                raise CareerGraphNotFoundError("publication compilation not found")
            if source[1] != target[1]:
                raise CareerGraphStateError(
                    "public résumé updates must stay within the same Career Graph"
                )
            if source[2] == target[2]:
                raise CareerGraphStateError(
                    "source and target must reference different immutable résumé artifacts"
                )
            if not source[4]:
                raise CareerGraphStateError(
                    "source compilation does not own an active public résumé link"
                )
            if target[3] != "approved" or target[4] is not None:
                raise CareerGraphStateError(
                    "target compilation must be approved and not already published"
                )

            token = source[4]
            token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
            await cur.execute(
                """
                SELECT set_config(
                    'relay.career_graph_publication_writer',
                    'codex_mcp_update',
                    true
                )
                """
            )
            await cur.execute(
                """
                UPDATE resumes
                   SET publish_token = NULL
                 WHERE id = %s AND user_id = %s
                """,
                (str(source[2]), str(user_id)),
            )
            await cur.execute(
                """
                UPDATE resumes
                   SET publish_token = %s, published_at = now()
                 WHERE id = %s AND user_id = %s
                """,
                (token, str(target[2]), str(user_id)),
            )
            await cur.execute(
                """
                UPDATE career_graph_compilations
                   SET status = 'published', published_at = now()
                 WHERE id = %s AND user_id = %s
                """,
                (str(target_compilation_id), str(user_id)),
            )
            await cur.execute(
                """
                INSERT INTO career_graph_publication_events (
                    user_id, graph_id, event_kind, event_source,
                    from_compilation_id, to_compilation_id,
                    public_token_digest
                ) VALUES (
                    %s, %s, 'updated', 'codex_mcp_explicit_confirmation',
                    %s, %s, %s
                )
                RETURNING id, occurred_at
                """,
                (
                    str(user_id),
                    str(source[1]),
                    str(source_compilation_id),
                    str(target_compilation_id),
                    token_digest,
                ),
            )
            event = await cur.fetchone()
        await conn.commit()
    if not event:
        raise RuntimeError("failed to record Career Graph publication update")
    return {
        "ok": True,
        "source_compilation_id": str(source_compilation_id),
        "target_compilation_id": str(target_compilation_id),
        "resume_id": str(target[2]),
        "status": "published",
        "public_url": f"{public_base_url.rstrip('/')}/r/{token}",
        "link_preserved": True,
        "source_artifact_immutable": True,
        "source_publication_active": False,
        "target_publication_active": True,
        "publication_event": {
            "id": str(event[0]),
            "event_kind": "updated",
            "occurred_at": event[1].isoformat(),
        },
    }


async def revoke_published_compilation(
    user_id: UUID,
    compilation_id: UUID,
    *,
    confirmation: str,
) -> dict[str, Any]:
    """Revoke one active public link without deleting its immutable artifact."""

    expected = f"REVOKE PUBLIC RESUME {compilation_id}"
    if confirmation != expected:
        raise CareerGraphStateError(f"explicit confirmation required: {expected}")

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT compilation.graph_id, compilation.resume_id,
                       compilation.status, resume.publish_token
                  FROM career_graph_compilations compilation
                  JOIN resumes resume ON resume.id = compilation.resume_id
                 WHERE compilation.id = %s
                   AND compilation.user_id = %s
                 FOR UPDATE OF compilation, resume
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError("publication compilation not found")
            graph_id, resume_id, status, token = row
            if not token:
                raise CareerGraphStateError("compilation does not own an active public résumé link")
            token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
            await cur.execute(
                """
                SELECT set_config(
                    'relay.career_graph_publication_writer',
                    'codex_mcp_revoke',
                    true
                )
                """
            )
            await cur.execute(
                """
                UPDATE resumes
                   SET publish_token = NULL
                 WHERE id = %s AND user_id = %s
                """,
                (str(resume_id), str(user_id)),
            )
            await cur.execute(
                """
                INSERT INTO career_graph_publication_events (
                    user_id, graph_id, event_kind, event_source,
                    from_compilation_id, to_compilation_id,
                    public_token_digest
                ) VALUES (
                    %s, %s, 'revoked', 'codex_mcp_explicit_confirmation',
                    %s, NULL, %s
                )
                RETURNING id, occurred_at
                """,
                (
                    str(user_id),
                    str(graph_id),
                    str(compilation_id),
                    token_digest,
                ),
            )
            event = await cur.fetchone()
        await conn.commit()
    if not event:
        raise RuntimeError("failed to record Career Graph publication revocation")
    return {
        "ok": True,
        "compilation_id": str(compilation_id),
        "resume_id": str(resume_id),
        "status": status,
        "publication_active": False,
        "public_url": None,
        "artifact_deleted": False,
        "publication_event": {
            "id": str(event[0]),
            "event_kind": "revoked",
            "occurred_at": event[1].isoformat(),
        },
    }


async def get_publication_history(
    user_id: UUID,
    graph_id: UUID,
    *,
    limit: int = 51,
    offset: int = 0,
) -> dict[str, Any]:
    """Read append-only public-link history and current active versions."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM career_graphs WHERE id = %s AND user_id = %s",
                (str(graph_id), str(user_id)),
            )
            if not await cur.fetchone():
                raise CareerGraphNotFoundError("Career Graph not found")
            await cur.execute(
                """
                SELECT id, event_kind, event_source,
                       from_compilation_id, to_compilation_id, occurred_at
                  FROM career_graph_publication_events
                 WHERE graph_id = %s AND user_id = %s
                 ORDER BY occurred_at DESC, id DESC
                 LIMIT %s OFFSET %s
                """,
                (str(graph_id), str(user_id), limit, offset),
            )
            event_rows = await cur.fetchall()
            await cur.execute(
                """
                SELECT compilation.id, compilation.resume_id,
                       revision.revision, resume.version,
                       resume.publish_token, resume.published_at
                  FROM career_graph_compilations compilation
                  JOIN career_graph_revisions revision
                    ON revision.id = compilation.graph_revision_id
                  JOIN resumes resume ON resume.id = compilation.resume_id
                 WHERE compilation.graph_id = %s
                   AND compilation.user_id = %s
                   AND resume.publish_token IS NOT NULL
                 ORDER BY resume.published_at DESC, compilation.id DESC
                 LIMIT 101
                """,
                (str(graph_id), str(user_id)),
            )
            active_rows = await cur.fetchall()
    return {
        "graph_id": str(graph_id),
        "events": [
            {
                "id": str(row[0]),
                "event_kind": row[1],
                "event_source": row[2],
                "from_compilation_id": str(row[3]) if row[3] else None,
                "to_compilation_id": str(row[4]) if row[4] else None,
                "occurred_at": row[5].isoformat(),
            }
            for row in event_rows
        ],
        "active_publications": [
            {
                "compilation_id": str(row[0]),
                "resume_id": str(row[1]),
                "graph_revision": int(row[2]),
                "resume_version": int(row[3]),
                "publish_token": row[4],
                "published_at": row[5].isoformat() if row[5] else None,
            }
            for row in active_rows[:100]
        ],
        "active_publications_truncated": len(active_rows) > 100,
    }


async def bind_compilation_job(
    user_id: UUID,
    compilation_id: UUID,
    *,
    company: str,
    role_title: str,
    job_url: str,
) -> dict[str, Any]:
    """Persist the intended job before résumé approval so Codex can resume later."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                (str(compilation_id),),
            )
            await cur.execute(
                """
                SELECT job_id, status, jd_text
                  FROM career_graph_compilations
                 WHERE id = %s AND user_id = %s
                 FOR UPDATE
                """,
                (str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError("compilation not found")
            job_id, status, jd_text = row
            if status == "rejected":
                raise CareerGraphStateError("rejected compilations cannot bind an application")
            if job_id:
                await cur.execute(
                    """
                    SELECT company, role_title, url
                      FROM jobs
                     WHERE id = %s
                    """,
                    (str(job_id),),
                )
                existing = await cur.fetchone()
                if not existing:
                    raise CareerGraphNotFoundError("compilation job not found")
                if existing != (company, role_title, job_url):
                    raise CareerGraphStateError(
                        "compilation is already bound to a different job identity"
                    )
            else:
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
                    raise RuntimeError("failed to bind application job")
                job_id = job_row[0]
                await cur.execute(
                    """
                    UPDATE career_graph_compilations
                       SET job_id = %s
                     WHERE id = %s AND user_id = %s
                    """,
                    (str(job_id), str(compilation_id), str(user_id)),
                )
        await conn.commit()
    return {
        "compilation_id": str(compilation_id),
        "job_id": str(job_id),
        "job_identity": {
            "company": company,
            "role_title": role_title,
            "job_url": job_url,
            "source": "manual",
            "external_id": f"career-graph:{compilation_id}",
        },
        "compilation_status": status,
        "server_side_submission": False,
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
                "SELECT set_config('relay.application_event_source', 'codex_mcp_prepare', true)"
            )
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
            else:
                await cur.execute(
                    """
                    SELECT url, company, role_title
                      FROM jobs
                     WHERE id = %s
                    """,
                    (str(job_id),),
                )
                existing_job = await cur.fetchone()
                if not existing_job:
                    raise CareerGraphNotFoundError("compilation job not found")
                if existing_job != (job_url, company, role_title):
                    raise CareerGraphStateError(
                        "compilation is already bound to a different job identity"
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
                SELECT a.id, j.id, j.company, j.role_title, j.source,
                       j.external_id, questionnaire.id, questionnaire.revision,
                       questionnaire.status, questionnaire.job_identity,
                       questionnaire.fields, questionnaire.summary,
                       questionnaire.created_at, questionnaire.reviewed_at,
                       questionnaire.approval_source
                  FROM application_drafts a
                  JOIN jobs j ON j.id = a.job_id
                  LEFT JOIN LATERAL (
                      SELECT q.id, q.revision, q.status, q.job_identity,
                             q.fields, q.summary, q.created_at, q.reviewed_at,
                             q.approval_source
                        FROM application_questionnaires q
                       WHERE q.user_id = a.user_id
                         AND q.application_id = a.id
                       ORDER BY q.revision DESC
                       LIMIT 1
                  ) questionnaire ON true
                 WHERE a.user_id = %s
                   AND a.resume_version_id = %s
                   AND j.url = %s
                 ORDER BY a.created_at DESC
                 LIMIT 1
                """,
                (str(user_id), compilation["resume_id"], job_url),
            )
            application_row = await cur.fetchone()
    if not application_row:
        raise CareerGraphStateError(
            "create an application draft for this exact job URL before browser handoff"
        )
    return {
        "compilation_id": str(compilation_id),
        "application_id": str(application_row[0]),
        "job_url": job_url,
        "job_identity": {
            "job_id": str(application_row[1]),
            "company": application_row[2],
            "role_title": application_row[3],
            "source": application_row[4],
            "external_id": application_row[5],
        },
        "questionnaire": (
            _questionnaire_payload(tuple(application_row[6:15])) if application_row[6] else {}
        ),
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


async def save_application_questionnaire(
    user_id: UUID,
    application_id: UUID,
    compilation_id: UUID,
    *,
    questionnaire: dict[str, Any],
) -> dict[str, Any]:
    """Persist a reviewable questionnaire bound to one application package."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                    set_config(
                        'relay.application_submission_authorization_writer',
                        'codex_mcp_authorize',
                        true
                    ),
                    pg_advisory_xact_lock(hashtext(%s))
                """,
                (str(application_id),),
            )
            await cur.execute(
                """
                SELECT application.status
                  FROM application_drafts AS application
                  JOIN career_graph_compilations AS compilation
                    ON compilation.id = %s
                   AND compilation.user_id = application.user_id
                   AND compilation.resume_id = application.resume_version_id
                   AND compilation.job_id = application.job_id
                 WHERE application.id = %s
                   AND application.user_id = %s
                 FOR UPDATE OF application
                """,
                (str(compilation_id), str(application_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError(
                    "application and compilation questionnaire scope not found"
                )
            if row[0] != "review":
                raise CareerGraphStateError(
                    "questionnaires can only change while the application awaits review"
                )
            await cur.execute(
                """
                UPDATE application_submission_authorizations
                   SET invalidated_at = transaction_timestamp()
                 WHERE user_id = %s
                   AND application_id = %s
                   AND consumed_at IS NULL
                   AND invalidated_at IS NULL
                """,
                (str(user_id), str(application_id)),
            )
            await cur.execute(
                """
                SELECT revision, status
                  FROM application_questionnaires
                 WHERE user_id = %s AND application_id = %s
                 ORDER BY revision DESC
                 LIMIT 1
                """,
                (str(user_id), str(application_id)),
            )
            latest_row = await cur.fetchone()
            if latest_row and latest_row[1] == "draft":
                raise CareerGraphStateError(
                    "a draft questionnaire already exists; approve or reject it before revising"
                )
            revision = int(latest_row[0]) + 1 if latest_row else 1
            await cur.execute(
                """
                INSERT INTO application_questionnaires (
                    user_id, application_id, compilation_id, revision, status,
                    job_identity, fields, summary
                ) VALUES (
                    %s, %s, %s, %s, 'draft', %s::jsonb, %s::jsonb, %s::jsonb
                )
                RETURNING id, revision, status, job_identity, fields, summary,
                          created_at, reviewed_at, approval_source
                """,
                (
                    str(user_id),
                    str(application_id),
                    str(compilation_id),
                    revision,
                    _json(questionnaire["job_identity"]),
                    _json(questionnaire["fields"]),
                    _json(questionnaire["summary"]),
                ),
            )
            stored = await cur.fetchone()
            if not stored:
                raise RuntimeError("failed to save application questionnaire")
        await conn.commit()
    return {
        **_questionnaire_payload(tuple(stored)),
        "application_id": str(application_id),
        "compilation_id": str(compilation_id),
    }


async def get_application_questionnaire(
    user_id: UUID,
    application_id: UUID,
    compilation_id: UUID,
) -> dict[str, Any] | None:
    """Read the full questionnaire only for its exact owner-scoped package."""

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT questionnaire.id, questionnaire.revision,
                       questionnaire.status, questionnaire.job_identity,
                       questionnaire.fields, questionnaire.summary,
                       questionnaire.created_at, questionnaire.reviewed_at,
                       questionnaire.approval_source
                  FROM application_drafts AS application
                  JOIN career_graph_compilations AS compilation
                    ON compilation.id = %s
                   AND compilation.user_id = application.user_id
                   AND compilation.resume_id = application.resume_version_id
                   AND compilation.job_id = application.job_id
                  LEFT JOIN LATERAL (
                      SELECT q.id, q.revision, q.status, q.job_identity,
                             q.fields, q.summary, q.created_at, q.reviewed_at,
                             q.approval_source
                        FROM application_questionnaires q
                       WHERE q.user_id = application.user_id
                         AND q.application_id = application.id
                         AND q.compilation_id = compilation.id
                       ORDER BY q.revision DESC
                       LIMIT 1
                  ) questionnaire ON true
                 WHERE application.id = %s
                   AND application.user_id = %s
                """,
                (str(compilation_id), str(application_id), str(user_id)),
            )
            row = await cur.fetchone()
    if not row:
        raise CareerGraphNotFoundError("application and compilation questionnaire scope not found")
    if not row[0]:
        return None
    return {
        **_questionnaire_payload(tuple(row)),
        "application_id": str(application_id),
        "compilation_id": str(compilation_id),
    }


async def decide_application_questionnaire(
    user_id: UUID,
    application_id: UUID,
    compilation_id: UUID,
    *,
    decision: str,
    confirmation: str,
) -> dict[str, Any]:
    """Approve or reject the latest questionnaire revision with an exact phrase."""

    if decision not in {"approved", "rejected"}:
        raise CareerGraphStateError("questionnaire decision must be approved or rejected")
    verb = "APPROVE" if decision == "approved" else "REJECT"
    expected = f"{verb} QUESTIONNAIRE {application_id}"
    if confirmation != expected:
        raise CareerGraphStateError(
            f"human confirmation required. Ask the user to type exactly: {expected}"
        )

    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT application.status
                  FROM application_drafts AS application
                  JOIN career_graph_compilations AS compilation
                    ON compilation.id = %s
                   AND compilation.user_id = application.user_id
                   AND compilation.resume_id = application.resume_version_id
                   AND compilation.job_id = application.job_id
                 WHERE application.id = %s
                   AND application.user_id = %s
                 FOR UPDATE OF application
                """,
                (str(compilation_id), str(application_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphNotFoundError(
                    "application and compilation questionnaire scope not found"
                )
            if row[0] != "review":
                raise CareerGraphStateError(
                    "questionnaires can only be reviewed while the application awaits review"
                )
            await cur.execute(
                """
                SELECT id, revision, status, job_identity, fields, summary,
                       created_at, reviewed_at, approval_source
                  FROM application_questionnaires
                 WHERE user_id = %s
                   AND application_id = %s
                   AND compilation_id = %s
                 ORDER BY revision DESC
                 LIMIT 1
                 FOR UPDATE
                """,
                (str(user_id), str(application_id), str(compilation_id)),
            )
            questionnaire_row = await cur.fetchone()
            if not questionnaire_row or questionnaire_row[2] != "draft":
                raise CareerGraphStateError("draft questionnaire not found")
            await cur.execute(
                """
                UPDATE application_questionnaires
                   SET status = %s,
                       reviewed_at = transaction_timestamp(),
                       approval_source = 'codex_mcp_exact_confirmation'
                 WHERE id = %s
                RETURNING id, revision, status, job_identity, fields, summary,
                          created_at, reviewed_at, approval_source
                """,
                (decision, str(questionnaire_row[0])),
            )
            reviewed = await cur.fetchone()
            if not reviewed:
                raise RuntimeError("failed to review application questionnaire")
        await conn.commit()
    return {
        **_questionnaire_payload(tuple(reviewed)),
        "application_id": str(application_id),
        "compilation_id": str(compilation_id),
    }


async def issue_application_artifact_delivery(
    user_id: UUID,
    compilation_id: UUID,
    application_id: UUID,
    *,
    artifact_format: str,
) -> dict[str, Any]:
    """Issue a short-lived file capability for one approved application.

    The raw code is returned once to the owner-scoped MCP caller. PostgreSQL
    stores only its SHA-256 digest, so a database read cannot reconstruct a
    browser-download capability.
    """

    if artifact_format not in {"pdf", "docx"}:
        raise CareerGraphStateError("artifact_format must be 'pdf' or 'docx'")

    download_code = secrets.token_hex(32)
    token_digest = hashlib.sha256(download_code.encode("utf-8")).hexdigest()
    async with await psycopg.AsyncConnection.connect(_dsn()) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.resume_id, c.status
                  FROM career_graph_compilations c
                  JOIN application_drafts a
                    ON a.id = %s
                   AND a.user_id = c.user_id
                   AND a.resume_version_id = c.resume_id
                 WHERE c.id = %s
                   AND c.user_id = %s
                 FOR UPDATE OF c
                """,
                (str(application_id), str(compilation_id), str(user_id)),
            )
            row = await cur.fetchone()
            if not row:
                raise CareerGraphStateError(
                    "application handoff no longer matches this résumé compilation"
                )
            if row[1] not in {"approved", "published"}:
                raise CareerGraphStateError(
                    "approve the compilation before delivering an application artifact"
                )
            await cur.execute(
                """
                UPDATE resume_artifact_delivery_grants
                   SET revoked_at = now()
                 WHERE user_id = %s
                   AND application_id = %s
                   AND purpose = 'application_upload'
                   AND artifact_format = %s
                   AND revoked_at IS NULL
                """,
                (str(user_id), str(application_id), artifact_format),
            )
            await cur.execute(
                """
                INSERT INTO resume_artifact_delivery_grants (
                    user_id, compilation_id, application_id, purpose,
                    artifact_format, token_digest, expires_at, max_downloads
                ) VALUES (
                    %s, %s, %s, 'application_upload', %s, %s,
                    now() + make_interval(mins => %s),
                    %s
                )
                RETURNING id, expires_at, max_downloads
                """,
                (
                    str(user_id),
                    str(compilation_id),
                    str(application_id),
                    artifact_format,
                    token_digest,
                    ARTIFACT_DELIVERY_TTL_MINUTES,
                    ARTIFACT_DELIVERY_MAX_DOWNLOADS,
                ),
            )
            grant = await cur.fetchone()
        await conn.commit()
    if not grant:
        raise RuntimeError("failed to create résumé artifact delivery grant")
    return {
        "grant_id": str(grant[0]),
        "purpose": "application_upload",
        "compilation_id": str(compilation_id),
        "application_id": str(application_id),
        "resume_id": str(row[0]),
        "artifact_format": artifact_format,
        "download_code": download_code,
        "expires_at": grant[1].isoformat(),
        "max_downloads": int(grant[2]),
    }
