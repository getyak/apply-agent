"""In-memory Career Graph store for protocol tests and first-run demos."""

from __future__ import annotations

import hashlib
import secrets
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from agents.career_graph.feedback import aggregate_evidence_outcomes
from agents.career_graph.model import (
    apply_operations,
    compile_resume,
    empty_snapshot,
    summarize_snapshot_changes,
)
from agents.career_graph.store import (
    EVIDENCE_REPORT_APPLICATION_LIMIT,
    EVIDENCE_REPORT_EVENT_LIMIT_PER_APPLICATION,
    EVIDENCE_REPORT_HISTORY_APPLICATION_LIMIT,
    SUBMISSION_AUTHORIZATION_TTL_MINUTES,
    CareerGraphConflictError,
    CareerGraphNotFoundError,
    CareerGraphStateError,
    _compilation_quality_summary,
    _text_preview,
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


class InMemoryCareerGraphStore:
    """Small stateful store with the same review semantics as PostgreSQL."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        # The fake Career Graph and fake operation ledger represent one local
        # database. Reset them together so semantic idempotency keys cannot
        # replay results from a previous protocol test/demo world.
        from agents.harness.recovery import set_operation_store_for_tests

        set_operation_store_for_tests(None)
        self.graphs: dict[str, dict[str, Any]] = {}
        self.change_sets: dict[str, dict[str, Any]] = {}
        self.compilations: dict[str, dict[str, Any]] = {}
        self.application_drafts: dict[str, dict[str, Any]] = {}
        self.submission_authorizations: dict[str, dict[str, Any]] = {}
        self.artifact_delivery_grants: dict[str, dict[str, Any]] = {}
        self.publication_events: list[dict[str, Any]] = []

    async def get_or_create_graph(
        self,
        user_id: UUID,
        *,
        label: str = "Career Graph",
        source_resume_id: UUID | None = None,
    ) -> dict[str, Any]:
        existing = next(
            (
                graph
                for graph in self.graphs.values()
                if graph["user_id"] == str(user_id) and graph["label"] == label
            ),
            None,
        )
        if existing:
            return self._public_graph(existing)
        graph_id = str(uuid4())
        graph = {
            "id": graph_id,
            "user_id": str(user_id),
            "label": label,
            "source_resume_id": str(source_resume_id) if source_resume_id else None,
            "current_revision": None,
            "created_at": _now(),
            "updated_at": _now(),
        }
        self.graphs[graph_id] = graph
        return self._public_graph(graph)

    async def get_graph(self, user_id: UUID, graph_id: UUID) -> dict[str, Any] | None:
        graph = self.graphs.get(str(graph_id))
        if not graph or graph["user_id"] != str(user_id):
            return None
        return self._public_graph(graph)

    async def list_graphs(self, user_id: UUID) -> list[dict[str, Any]]:
        return [
            {
                "id": graph["id"],
                "label": graph["label"],
                "source_resume_id": graph["source_resume_id"],
                "current_revision_id": (
                    graph["current_revision"]["id"] if graph["current_revision"] else None
                ),
                "revision": (
                    graph["current_revision"]["revision"] if graph["current_revision"] else 0
                ),
                "node_count": (
                    len(graph["current_revision"]["snapshot"]["nodes"])
                    if graph["current_revision"]
                    else 0
                ),
                "edge_count": (
                    len(graph["current_revision"]["snapshot"]["edges"])
                    if graph["current_revision"]
                    else 0
                ),
                "pending_change_count": sum(
                    change["graph_id"] == graph["id"] and change["status"] == "pending"
                    for change in self.change_sets.values()
                ),
                "created_at": graph["created_at"],
                "updated_at": graph["updated_at"],
            }
            for graph in self.graphs.values()
            if graph["user_id"] == str(user_id)
        ]

    async def list_compilations(
        self,
        user_id: UUID,
        *,
        graph_id: UUID | None = None,
        status: str | None = None,
        limit: int = 21,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for compilation in sorted(
            self.compilations.values(),
            key=lambda item: item["created_at"],
            reverse=True,
        ):
            if compilation["user_id"] != str(user_id):
                continue
            if graph_id is not None and compilation["graph_id"] != str(graph_id):
                continue
            if status is not None and compilation["status"] != status:
                continue
            applications = [
                item
                for item in self.application_drafts.values()
                if item["user_id"] == str(user_id) and item["compilation_id"] == compilation["id"]
            ]
            application = applications[0] if applications else None
            rows.append(
                {
                    "id": compilation["id"],
                    "graph_id": compilation["graph_id"],
                    "graph_revision_id": compilation["graph_revision_id"],
                    "graph_revision": compilation["graph_revision"],
                    "job_id": application["job_id"] if application else None,
                    "jd_fingerprint": compilation["jd_fingerprint"],
                    "jd_preview": _text_preview(compilation["_jd_text"])[0],
                    "jd_preview_truncated": _text_preview(compilation["_jd_text"])[1],
                    "resume_id": compilation["resume_id"],
                    "resume_version": compilation["resume_version"],
                    "status": compilation["status"],
                    "compiler_config": compilation["compiler_config"],
                    "quality_summary": _compilation_quality_summary(compilation["quality_report"]),
                    "publish_token": compilation["publish_token"],
                    "created_at": compilation["created_at"],
                    "approved_at": compilation["approved_at"],
                    "published_at": compilation["published_at"],
                    "job": (
                        {
                            "company": application["company"],
                            "role_title": application["role_title"],
                            "url": application["job_url"],
                        }
                        if application
                        else None
                    ),
                    "tracked_application_count": len(applications),
                }
            )
        return rows[offset : offset + limit]

    async def list_tracked_applications(
        self,
        user_id: UUID,
        *,
        graph_id: UUID | None = None,
        status: str | None = None,
        limit: int = 21,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for application in sorted(
            self.application_drafts.values(),
            key=lambda item: item["updated_at"],
            reverse=True,
        ):
            if application["user_id"] != str(user_id):
                continue
            compilation = self.compilations.get(application["compilation_id"])
            if not compilation:
                continue
            if graph_id is not None and compilation["graph_id"] != str(graph_id):
                continue
            if status is not None and application["status"] != status:
                continue
            latest = application["history"][-1] if application["history"] else None
            rows.append(
                {
                    "application_id": application["id"],
                    "compilation_id": compilation["id"],
                    "graph_id": compilation["graph_id"],
                    "graph_revision_id": compilation["graph_revision_id"],
                    "graph_revision": compilation["graph_revision"],
                    "jd_fingerprint": compilation["jd_fingerprint"],
                    "resume_id": compilation["resume_id"],
                    "resume_version": compilation["resume_version"],
                    "status": application["status"],
                    "outcome": application["outcome"],
                    "submitted_at": application["submitted_at"],
                    "submitted_via": application["submitted_via"],
                    "interview_date": application["interview_date"],
                    "created_at": application["created_at"],
                    "updated_at": application["updated_at"],
                    "job": {
                        "id": application["job_id"],
                        "company": application["company"],
                        "role_title": application["role_title"],
                        "url": application["job_url"],
                    },
                    "history_event_count": len(application["history"]),
                    "latest_history_event": (
                        {
                            "event_kind": latest["event_kind"],
                            "event_source": latest["event_source"],
                            "changed_fields": latest["changed_fields"],
                            "to_status": latest["to_status"],
                            "occurred_at": latest["occurred_at"],
                        }
                        if latest
                        else None
                    ),
                    "server_side_submission": False,
                }
            )
        return rows[offset : offset + limit]

    async def get_application_projection(
        self, user_id: UUID, application_id: UUID
    ) -> dict[str, Any] | None:
        application = self.application_drafts.get(str(application_id))
        if not application or application["user_id"] != str(user_id):
            return None
        return {
            "application_id": application["id"],
            "status": application["status"],
            "outcome": application["outcome"],
            "submitted_at": application["submitted_at"],
            "submitted_via": application["submitted_via"],
            "interview_date": application["interview_date"],
            "updated_at": application["updated_at"],
        }

    async def propose_changes(
        self,
        user_id: UUID,
        graph_id: UUID,
        *,
        operations: list[dict[str, Any]],
        summary: str,
        proposed_by: str = "codex",
    ) -> dict[str, Any]:
        graph = self._owned_graph(user_id, graph_id)
        current = graph["current_revision"]
        base = current["snapshot"] if current else empty_snapshot()
        proposed = apply_operations(base, operations)
        review_summary = summarize_snapshot_changes(base, proposed)
        if review_summary["total_changes"] == 0:
            raise CareerGraphStateError("proposal does not change the current Career Graph")
        change_id = str(uuid4())
        change = {
            "id": change_id,
            "graph_id": str(graph_id),
            "base_revision_id": current["id"] if current else None,
            "operations": operations,
            "proposed_snapshot": proposed,
            "summary": summary,
            "status": "pending",
            "proposed_by": proposed_by,
            "decided_via": None,
            "created_at": _now(),
            "decided_at": None,
            "review_summary": review_summary,
            "confirmation": {
                "approve": f"APPROVE CAREER CHANGE {change_id}",
                "reject": f"REJECT CAREER CHANGE {change_id}",
            },
        }
        self.change_sets[change_id] = {**change, "user_id": str(user_id)}
        return {**change, "requires_human_approval": True}

    async def get_change_set(self, user_id: UUID, change_set_id: UUID) -> dict[str, Any] | None:
        change = self.change_sets.get(str(change_set_id))
        if not change or change["user_id"] != str(user_id):
            return None
        return {key: value for key, value in change.items() if key != "user_id"}

    async def list_change_sets(
        self,
        user_id: UUID,
        *,
        status: str | None = "pending",
        graph_id: UUID | None = None,
    ) -> list[dict[str, Any]]:
        return [
            {key: value for key, value in change.items() if key != "user_id"}
            for change in sorted(
                self.change_sets.values(),
                key=lambda item: item["created_at"],
                reverse=True,
            )
            if change["user_id"] == str(user_id)
            and (status is None or change["status"] == status)
            and (graph_id is None or change["graph_id"] == str(graph_id))
        ]

    async def approve_change_set(
        self,
        user_id: UUID,
        change_set_id: UUID,
        *,
        decided_via: str = "codex_mcp",
    ) -> dict[str, Any]:
        change = self.change_sets.get(str(change_set_id))
        if not change or change["user_id"] != str(user_id):
            raise CareerGraphNotFoundError("Career Graph change set not found")
        if change["status"] != "pending":
            raise CareerGraphStateError(f"change set is already {change['status']}")
        graph = self._owned_graph(user_id, UUID(change["graph_id"]))
        current_id = graph["current_revision"]["id"] if graph["current_revision"] else None
        if change["base_revision_id"] != current_id:
            raise CareerGraphConflictError(
                "change set was based on an older graph revision; review a fresh proposal"
            )
        revision = (graph["current_revision"]["revision"] if graph["current_revision"] else 0) + 1
        revision_id = str(uuid4())
        graph["current_revision"] = {
            "id": revision_id,
            "revision": revision,
            "snapshot": change["proposed_snapshot"],
            "change_summary": change["summary"],
            "created_by": change["proposed_by"],
            "created_at": _now(),
        }
        graph["updated_at"] = _now()
        change["status"] = "approved"
        change["decided_via"] = decided_via
        change["decided_at"] = _now()
        return {
            "ok": True,
            "graph_id": graph["id"],
            "revision_id": revision_id,
            "revision": revision,
            "change_set_id": str(change_set_id),
            "status": "approved",
        }

    async def reject_change_set(
        self,
        user_id: UUID,
        change_set_id: UUID,
        *,
        decided_via: str = "codex_mcp",
    ) -> dict[str, Any]:
        change = self.change_sets.get(str(change_set_id))
        if not change or change["user_id"] != str(user_id) or change["status"] != "pending":
            raise CareerGraphStateError("pending Career Graph change set not found")
        change["status"] = "rejected"
        change["decided_via"] = decided_via
        change["decided_at"] = _now()
        return {
            "ok": True,
            "graph_id": change["graph_id"],
            "change_set_id": str(change_set_id),
            "status": "rejected",
        }

    async def create_compilation(
        self,
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
        graph = self._owned_graph(user_id, graph_id)
        revision = graph["current_revision"]
        if not revision:
            raise CareerGraphStateError(
                "approve at least one Career Graph revision before compiling"
            )
        compiled = compile_resume(
            revision["snapshot"],
            jd_text,
            artifact_locale=artifact_locale,
            length_budget=length_budget,
            ats_profile=ats_profile,
            max_achievements_per_role=max_achievements_per_role,
        )
        compilation_id = str(uuid4())
        resume_id = str(uuid4())
        fingerprint = hashlib.sha256(jd_text.encode("utf-8")).hexdigest()
        compilation = {
            "id": compilation_id,
            "user_id": str(user_id),
            "status": "draft",
            "graph_id": str(graph_id),
            "graph_revision_id": revision["id"],
            "graph_revision": revision["revision"],
            "job_id": str(job_id) if job_id else None,
            "job_identity": None,
            "resume_id": resume_id,
            "resume_version": len(self.compilations) + 1,
            "jd_fingerprint": fingerprint,
            "_jd_text": jd_text,
            **compiled,
            "publish_token": None,
            "created_at": _now(),
            "approved_at": None,
            "published_at": None,
        }
        self.compilations[compilation_id] = compilation
        return {
            key: value
            for key, value in compilation.items()
            if key != "user_id" and not key.startswith("_")
        } | {"requires_human_approval": True}

    async def get_evidence_outcome_report(
        self,
        user_id: UUID,
        graph_id: UUID,
    ) -> dict[str, Any]:
        graph = self._owned_graph(user_id, graph_id)
        records: list[dict[str, Any]] = []
        for application in self.application_drafts.values():
            if application["user_id"] != str(user_id):
                continue
            compilation = self.compilations.get(application["compilation_id"])
            if not compilation or compilation["graph_id"] != str(graph_id):
                continue
            records.append(
                {
                    "application_id": application["id"],
                    "status": application["status"],
                    "outcome": application.get("outcome"),
                    "submitted_at": application.get("submitted_at"),
                    "interview_date": application.get("interview_date"),
                    "selected_node_ids": compilation["guard_report"]["selected_node_ids"],
                    "jd_fingerprint": compilation["jd_fingerprint"],
                    "compiler_config": compilation["compiler_config"],
                    "history": application["history"],
                    "history_event_count": len(application["history"]),
                    "history_truncated": False,
                }
            )
        report = aggregate_evidence_outcomes(records)
        return {
            "graph_id": str(graph_id),
            "graph_revision": (
                graph["current_revision"]["revision"] if graph["current_revision"] else 0
            ),
            "report_scope": {
                "application_count_total": len(records),
                "application_count_included": len(records),
                "applications_truncated": False,
                "application_limit": EVIDENCE_REPORT_APPLICATION_LIMIT,
                "history_application_limit": EVIDENCE_REPORT_HISTORY_APPLICATION_LIMIT,
                "event_limit_per_application": EVIDENCE_REPORT_EVENT_LIMIT_PER_APPLICATION,
            },
            **report,
        }

    async def get_compilation(self, user_id: UUID, compilation_id: UUID) -> dict[str, Any] | None:
        compilation = self.compilations.get(str(compilation_id))
        if not compilation or compilation["user_id"] != str(user_id):
            return None
        return {
            key: value
            for key, value in compilation.items()
            if key != "user_id" and not key.startswith("_")
        }

    async def approve_compilation(self, user_id: UUID, compilation_id: UUID) -> dict[str, Any]:
        compilation = self._owned_compilation(user_id, compilation_id)
        if compilation["status"] != "draft":
            raise CareerGraphStateError("draft compilation not found")
        compilation["status"] = "approved"
        compilation["approved_at"] = _now()
        return {
            "ok": True,
            "compilation_id": str(compilation_id),
            "resume_id": compilation["resume_id"],
            "status": "approved",
        }

    async def issue_compilation_artifact_review(
        self,
        user_id: UUID,
        compilation_id: UUID,
        *,
        artifact_format: str,
    ) -> dict[str, Any]:
        if artifact_format not in {"pdf", "docx"}:
            raise CareerGraphStateError("artifact_format must be 'pdf' or 'docx'")
        compilation = self._owned_compilation(user_id, compilation_id)
        if compilation["status"] == "rejected":
            raise CareerGraphStateError("rejected compilations cannot create review artifacts")
        for grant in self.artifact_delivery_grants.values():
            if (
                grant["user_id"] == str(user_id)
                and grant["compilation_id"] == str(compilation_id)
                and grant["purpose"] == "compilation_review"
                and grant["artifact_format"] == artifact_format
                and not grant["revoked"]
            ):
                grant["revoked"] = True
        grant_id = str(uuid4())
        download_code = secrets.token_hex(32)
        grant = {
            "grant_id": grant_id,
            "purpose": "compilation_review",
            "user_id": str(user_id),
            "compilation_id": str(compilation_id),
            "compilation_status": compilation["status"],
            "application_id": None,
            "resume_id": compilation["resume_id"],
            "artifact_format": artifact_format,
            "download_code": download_code,
            "expires_at": (datetime.now(UTC) + timedelta(minutes=10)).isoformat(),
            "max_downloads": 5,
            "revoked": False,
        }
        self.artifact_delivery_grants[grant_id] = grant
        return {key: value for key, value in grant.items() if key not in {"user_id", "revoked"}}

    async def reject_compilation(self, user_id: UUID, compilation_id: UUID) -> dict[str, Any]:
        compilation = self._owned_compilation(user_id, compilation_id)
        if compilation["status"] != "draft":
            raise CareerGraphStateError("draft compilation not found")
        compilation["status"] = "rejected"
        return {
            "ok": True,
            "compilation_id": str(compilation_id),
            "resume_id": compilation["resume_id"],
            "status": "rejected",
        }

    async def publish_compilation(
        self,
        user_id: UUID,
        compilation_id: UUID,
        *,
        confirmation: str,
        public_base_url: str,
    ) -> dict[str, Any]:
        compilation = self._owned_compilation(user_id, compilation_id)
        expected = f"PUBLISH {compilation_id}"
        if confirmation != expected:
            raise CareerGraphStateError(f"explicit confirmation required: {expected}")
        if compilation["status"] != "approved":
            raise CareerGraphStateError("only an approved compilation can be published")
        if compilation["publish_token"]:
            raise CareerGraphStateError(
                "compilation already owns an active public résumé link; "
                "use the update or revoke workflow"
            )
        token = uuid4().hex
        compilation["status"] = "published"
        compilation["publish_token"] = token
        compilation["published_at"] = _now()
        event = self._append_publication_event(
            user_id=user_id,
            graph_id=compilation["graph_id"],
            event_kind="published",
            from_compilation_id=None,
            to_compilation_id=str(compilation_id),
            token=token,
        )
        return {
            "ok": True,
            "compilation_id": str(compilation_id),
            "resume_id": compilation["resume_id"],
            "status": "published",
            "public_url": f"{public_base_url.rstrip('/')}/r/{token}",
            "publication_active": True,
            "publication_event": {
                "id": event["id"],
                "event_kind": event["event_kind"],
                "occurred_at": event["occurred_at"],
            },
        }

    async def update_published_compilation(
        self,
        user_id: UUID,
        source_compilation_id: UUID,
        target_compilation_id: UUID,
        *,
        confirmation: str,
        public_base_url: str,
    ) -> dict[str, Any]:
        expected = f"UPDATE PUBLIC RESUME {source_compilation_id} TO {target_compilation_id}"
        if confirmation != expected:
            raise CareerGraphStateError(f"explicit confirmation required: {expected}")
        if source_compilation_id == target_compilation_id:
            raise CareerGraphStateError("source and target compilations must be different")
        source = self._owned_compilation(user_id, source_compilation_id)
        target = self._owned_compilation(user_id, target_compilation_id)
        if source["graph_id"] != target["graph_id"]:
            raise CareerGraphStateError(
                "public résumé updates must stay within the same Career Graph"
            )
        if source["resume_id"] == target["resume_id"]:
            raise CareerGraphStateError(
                "source and target must reference different immutable résumé artifacts"
            )
        if not source["publish_token"]:
            raise CareerGraphStateError(
                "source compilation does not own an active public résumé link"
            )
        if target["status"] != "approved" or target["publish_token"] is not None:
            raise CareerGraphStateError(
                "target compilation must be approved and not already published"
            )
        token = source["publish_token"]
        source["publish_token"] = None
        target["publish_token"] = token
        target["status"] = "published"
        target["published_at"] = _now()
        event = self._append_publication_event(
            user_id=user_id,
            graph_id=source["graph_id"],
            event_kind="updated",
            from_compilation_id=str(source_compilation_id),
            to_compilation_id=str(target_compilation_id),
            token=token,
        )
        return {
            "ok": True,
            "source_compilation_id": str(source_compilation_id),
            "target_compilation_id": str(target_compilation_id),
            "resume_id": target["resume_id"],
            "status": "published",
            "public_url": f"{public_base_url.rstrip('/')}/r/{token}",
            "link_preserved": True,
            "source_artifact_immutable": True,
            "source_publication_active": False,
            "target_publication_active": True,
            "publication_event": {
                "id": event["id"],
                "event_kind": event["event_kind"],
                "occurred_at": event["occurred_at"],
            },
        }

    async def revoke_published_compilation(
        self,
        user_id: UUID,
        compilation_id: UUID,
        *,
        confirmation: str,
    ) -> dict[str, Any]:
        expected = f"REVOKE PUBLIC RESUME {compilation_id}"
        if confirmation != expected:
            raise CareerGraphStateError(f"explicit confirmation required: {expected}")
        compilation = self._owned_compilation(user_id, compilation_id)
        token = compilation["publish_token"]
        if not token:
            raise CareerGraphStateError("compilation does not own an active public résumé link")
        compilation["publish_token"] = None
        event = self._append_publication_event(
            user_id=user_id,
            graph_id=compilation["graph_id"],
            event_kind="revoked",
            from_compilation_id=str(compilation_id),
            to_compilation_id=None,
            token=token,
        )
        return {
            "ok": True,
            "compilation_id": str(compilation_id),
            "resume_id": compilation["resume_id"],
            "status": compilation["status"],
            "publication_active": False,
            "public_url": None,
            "artifact_deleted": False,
            "publication_event": {
                "id": event["id"],
                "event_kind": event["event_kind"],
                "occurred_at": event["occurred_at"],
            },
        }

    async def get_publication_history(
        self,
        user_id: UUID,
        graph_id: UUID,
        *,
        limit: int = 51,
        offset: int = 0,
    ) -> dict[str, Any]:
        self._owned_graph(user_id, graph_id)
        events = [
            {
                key: value
                for key, value in event.items()
                if key not in {"user_id", "public_token_digest", "graph_id"}
            }
            for event in sorted(
                self.publication_events,
                key=lambda item: item["occurred_at"],
                reverse=True,
            )
            if event["user_id"] == str(user_id) and event["graph_id"] == str(graph_id)
        ]
        active = [
            compilation
            for compilation in sorted(
                self.compilations.values(),
                key=lambda item: item["published_at"] or "",
                reverse=True,
            )
            if compilation["user_id"] == str(user_id)
            and compilation["graph_id"] == str(graph_id)
            and compilation["publish_token"] is not None
        ]
        return {
            "graph_id": str(graph_id),
            "events": events[offset : offset + limit],
            "active_publications": [
                {
                    "compilation_id": compilation["id"],
                    "resume_id": compilation["resume_id"],
                    "graph_revision": compilation["graph_revision"],
                    "resume_version": compilation["resume_version"],
                    "publish_token": compilation["publish_token"],
                    "published_at": compilation["published_at"],
                }
                for compilation in active[:100]
            ],
            "active_publications_truncated": len(active) > 100,
        }

    async def application_handoff(
        self,
        user_id: UUID,
        compilation_id: UUID,
        *,
        job_url: str,
    ) -> dict[str, Any]:
        compilation = self._owned_compilation(user_id, compilation_id)
        if compilation["status"] not in {"approved", "published"}:
            raise CareerGraphStateError("approve the compilation before browser handoff")
        application = next(
            (
                item
                for item in self.application_drafts.values()
                if item["user_id"] == str(user_id)
                and item["resume_id"] == compilation["resume_id"]
                and item["job_url"] == job_url
            ),
            None,
        )
        if not application:
            raise CareerGraphStateError(
                "create an application draft for this exact job URL before browser handoff"
            )
        return {
            "compilation_id": str(compilation_id),
            "application_id": application["id"],
            "job_url": job_url,
            "job_identity": {
                "job_id": application["job_id"],
                "company": application["company"],
                "role_title": application["role_title"],
                "source": "manual",
                "external_id": f"career-graph:{compilation_id}",
            },
            "questionnaire": deepcopy(
                application.get("questionnaires", [])[-1]
                if application.get("questionnaires")
                else {}
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

    async def bind_compilation_job(
        self,
        user_id: UUID,
        compilation_id: UUID,
        *,
        company: str,
        role_title: str,
        job_url: str,
    ) -> dict[str, Any]:
        compilation = self._owned_compilation(user_id, compilation_id)
        if compilation["status"] == "rejected":
            raise CareerGraphStateError("rejected compilations cannot bind an application")
        expected = {
            "company": company,
            "role_title": role_title,
            "job_url": job_url,
            "source": "manual",
            "external_id": f"career-graph:{compilation_id}",
        }
        if compilation["job_identity"] and compilation["job_identity"] != expected:
            raise CareerGraphStateError("compilation is already bound to a different job identity")
        if not compilation["job_id"]:
            compilation["job_id"] = str(uuid4())
        compilation["job_identity"] = expected
        return {
            "compilation_id": str(compilation_id),
            "job_id": compilation["job_id"],
            "job_identity": expected,
            "compilation_status": compilation["status"],
            "server_side_submission": False,
        }

    async def create_application_draft(
        self,
        user_id: UUID,
        compilation_id: UUID,
        *,
        company: str,
        role_title: str,
        job_url: str,
    ) -> dict[str, Any]:
        compilation = self._owned_compilation(user_id, compilation_id)
        if compilation["status"] not in {"approved", "published"}:
            raise CareerGraphStateError(
                "approve the compilation before creating an application draft"
            )
        bound = compilation.get("job_identity")
        if bound and (
            bound["company"] != company
            or bound["role_title"] != role_title
            or bound["job_url"] != job_url
        ):
            raise CareerGraphStateError("compilation is already bound to a different job identity")
        existing = next(
            (
                item
                for item in self.application_drafts.values()
                if item["user_id"] == str(user_id) and item["compilation_id"] == str(compilation_id)
            ),
            None,
        )
        reused = existing is not None
        if existing and existing["job_url"] != job_url:
            raise CareerGraphStateError("compilation is already bound to a different job URL")
        if not existing:
            application_id = str(uuid4())
            existing = {
                "id": application_id,
                "user_id": str(user_id),
                "compilation_id": str(compilation_id),
                "resume_id": compilation["resume_id"],
                "job_id": compilation["job_id"] or str(uuid4()),
                "company": company,
                "role_title": role_title,
                "job_url": job_url,
                "status": "review",
                "outcome": None,
                "submitted_at": None,
                "submitted_via": None,
                "interview_date": None,
                "questionnaires": [],
                "created_at": _now(),
                "updated_at": _now(),
                "history": [
                    {
                        "event_kind": "created",
                        "event_source": "fake_store",
                        "changed_fields": ["created"],
                        "from_status": None,
                        "to_status": "review",
                        "from_outcome": None,
                        "to_outcome": None,
                        "submitted_at": None,
                        "submitted_via": None,
                        "interview_date": None,
                        "occurred_at": _now(),
                    }
                ],
            }
            self.application_drafts[application_id] = existing
        return {
            "ok": True,
            "application_id": existing["id"],
            "application_status": existing["status"],
            "compilation_id": str(compilation_id),
            "resume_id": existing["resume_id"],
            "job_id": existing["job_id"],
            "job_url": job_url,
            "reused": reused,
            "server_side_submission": False,
        }

    async def save_application_questionnaire(
        self,
        user_id: UUID,
        application_id: UUID,
        compilation_id: UUID,
        *,
        questionnaire: dict[str, Any],
    ) -> dict[str, Any]:
        application = self.application_drafts.get(str(application_id))
        compilation = self.compilations.get(str(compilation_id))
        if (
            not application
            or not compilation
            or application["user_id"] != str(user_id)
            or compilation["user_id"] != str(user_id)
            or application["compilation_id"] != str(compilation_id)
        ):
            raise CareerGraphNotFoundError(
                "application and compilation questionnaire scope not found"
            )
        if application["status"] != "review":
            raise CareerGraphStateError(
                "questionnaires can only change while the application awaits review"
            )
        questionnaires = application.setdefault("questionnaires", [])
        previous = questionnaires[-1] if questionnaires else {}
        if previous.get("status") == "draft":
            raise CareerGraphStateError(
                "a draft questionnaire already exists; approve or reject it before revising"
            )
        for authorization in self.submission_authorizations.values():
            if (
                authorization["user_id"] == str(user_id)
                and authorization["application_id"] == str(application_id)
                and authorization["consumed_at"] is None
                and authorization["invalidated_at"] is None
            ):
                authorization["invalidated_at"] = _now()
        stored = deepcopy(questionnaire)
        stored["questionnaire_id"] = str(uuid4())
        stored["revision"] = int(previous.get("revision", 0)) + 1
        questionnaires.append(stored)
        application["updated_at"] = _now()
        return {
            **deepcopy(stored),
            "application_id": str(application_id),
            "compilation_id": str(compilation_id),
            "updated_at": application["updated_at"],
        }

    async def get_application_questionnaire(
        self,
        user_id: UUID,
        application_id: UUID,
        compilation_id: UUID,
    ) -> dict[str, Any] | None:
        application = self.application_drafts.get(str(application_id))
        compilation = self.compilations.get(str(compilation_id))
        if (
            not application
            or not compilation
            or application["user_id"] != str(user_id)
            or compilation["user_id"] != str(user_id)
            or application["compilation_id"] != str(compilation_id)
        ):
            raise CareerGraphNotFoundError(
                "application and compilation questionnaire scope not found"
            )
        questionnaires = application.get("questionnaires", [])
        if not questionnaires:
            return None
        questionnaire = questionnaires[-1]
        return {
            **deepcopy(questionnaire),
            "application_id": str(application_id),
            "compilation_id": str(compilation_id),
            "updated_at": application["updated_at"],
        }

    async def decide_application_questionnaire(
        self,
        user_id: UUID,
        application_id: UUID,
        compilation_id: UUID,
        *,
        decision: str,
        confirmation: str,
    ) -> dict[str, Any]:
        if decision not in {"approved", "rejected"}:
            raise CareerGraphStateError("questionnaire decision must be approved or rejected")
        verb = "APPROVE" if decision == "approved" else "REJECT"
        expected = f"{verb} QUESTIONNAIRE {application_id}"
        if confirmation != expected:
            raise CareerGraphStateError(
                f"human confirmation required. Ask the user to type exactly: {expected}"
            )
        application = self.application_drafts.get(str(application_id))
        compilation = self.compilations.get(str(compilation_id))
        if (
            not application
            or not compilation
            or application["user_id"] != str(user_id)
            or compilation["user_id"] != str(user_id)
            or application["compilation_id"] != str(compilation_id)
        ):
            raise CareerGraphNotFoundError(
                "application and compilation questionnaire scope not found"
            )
        if application["status"] != "review":
            raise CareerGraphStateError(
                "questionnaires can only be reviewed while the application awaits review"
            )
        questionnaires = application.get("questionnaires", [])
        questionnaire = questionnaires[-1] if questionnaires else {}
        if questionnaire.get("status") != "draft":
            raise CareerGraphStateError("draft questionnaire not found")
        questionnaire.update(
            {
                "status": decision,
                "reviewed_at": _now(),
                "approval_source": "codex_mcp_exact_confirmation",
            }
        )
        application["updated_at"] = _now()
        return {
            **deepcopy(questionnaire),
            "application_id": str(application_id),
            "compilation_id": str(compilation_id),
            "updated_at": application["updated_at"],
        }

    async def issue_application_artifact_delivery(
        self,
        user_id: UUID,
        compilation_id: UUID,
        application_id: UUID,
        *,
        artifact_format: str,
    ) -> dict[str, Any]:
        if artifact_format not in {"pdf", "docx"}:
            raise CareerGraphStateError("artifact_format must be 'pdf' or 'docx'")
        compilation = self._owned_compilation(user_id, compilation_id)
        application = self.application_drafts.get(str(application_id))
        if (
            not application
            or application["user_id"] != str(user_id)
            or application["resume_id"] != compilation["resume_id"]
        ):
            raise CareerGraphStateError(
                "application handoff no longer matches this résumé compilation"
            )
        if compilation["status"] not in {"approved", "published"}:
            raise CareerGraphStateError(
                "approve the compilation before delivering an application artifact"
            )
        for grant in self.artifact_delivery_grants.values():
            if (
                grant["user_id"] == str(user_id)
                and grant["application_id"] == str(application_id)
                and grant["purpose"] == "application_upload"
                and grant["artifact_format"] == artifact_format
                and not grant["revoked"]
            ):
                grant["revoked"] = True
        grant_id = str(uuid4())
        download_code = secrets.token_hex(32)
        grant = {
            "grant_id": grant_id,
            "purpose": "application_upload",
            "user_id": str(user_id),
            "compilation_id": str(compilation_id),
            "application_id": str(application_id),
            "resume_id": compilation["resume_id"],
            "artifact_format": artifact_format,
            "download_code": download_code,
            "expires_at": (datetime.now(UTC) + timedelta(minutes=10)).isoformat(),
            "max_downloads": 5,
            "revoked": False,
        }
        self.artifact_delivery_grants[grant_id] = grant
        return {key: value for key, value in grant.items() if key not in {"user_id", "revoked"}}

    async def record_application_transition(
        self,
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
        application = self.application_drafts.get(str(application_id))
        if not application or application["user_id"] != str(user_id):
            raise CareerGraphNotFoundError("Career Graph application not found")
        old_status = application["status"]
        old_outcome = application.get("outcome")
        authorization = None
        if submission_authorization_id is not None:
            authorization = self.submission_authorizations.get(str(submission_authorization_id))
            if (
                not authorization
                or authorization["user_id"] != str(user_id)
                or authorization["application_id"] != str(application_id)
            ):
                raise CareerGraphStateError(
                    "browser-confirmed MCP submission authorization is unavailable or expired"
                )
            if old_status == "submitted":
                if authorization["consumed_at"] is None:
                    raise CareerGraphStateError(
                        "browser-confirmed MCP submission authorization is unavailable or expired"
                    )
            else:
                if (
                    authorization["consumed_at"] is not None
                    or authorization["invalidated_at"] is not None
                    or datetime.fromisoformat(authorization["expires_at"]) <= datetime.now(UTC)
                ):
                    raise CareerGraphStateError(
                        "browser-confirmed MCP submission authorization is unavailable or expired"
                    )
                authorization["consumed_at"] = _now()
        changed_fields: list[str] = []
        if old_status != status:
            application["status"] = status
            changed_fields.append("status")
        if outcome is not None and old_outcome != (outcome.strip() or None):
            application["outcome"] = outcome.strip() or None
            changed_fields.append("outcome")
        if interview_date is not None and application.get("interview_date") != interview_date:
            application["interview_date"] = interview_date
            changed_fields.append("interview_date")
        elif clear_interview_date and application.get("interview_date") is not None:
            application["interview_date"] = None
            changed_fields.append("interview_date")
        if status == "submitted" and not application.get("submitted_at"):
            application["submitted_at"] = _now()
            application["submitted_via"] = submitted_via or "client_extension"
            changed_fields.extend(["submitted_at", "submitted_via"])

        event = None
        if changed_fields:
            application["updated_at"] = _now()
            event = {
                "event_kind": "changed",
                "event_source": f"codex_mcp_{evidence_source}",
                "changed_fields": changed_fields,
                "from_status": old_status,
                "to_status": application["status"],
                "from_outcome": old_outcome,
                "to_outcome": application.get("outcome"),
                "submitted_at": application.get("submitted_at"),
                "submitted_via": application.get("submitted_via"),
                "interview_date": application.get("interview_date"),
                "occurred_at": application["updated_at"],
            }
            application["history"].append(event)
        return {
            "ok": True,
            "application_id": application["id"],
            "status": application["status"],
            "outcome": application.get("outcome"),
            "submitted_at": application.get("submitted_at"),
            "submitted_via": application.get("submitted_via"),
            "interview_date": application.get("interview_date"),
            "history_event": event,
            "changed": event is not None,
            "submission_authorization": (
                {
                    "id": authorization["id"],
                    "authorized_at": authorization["authorized_at"],
                    "expires_at": authorization["expires_at"],
                    "consumed_at": authorization["consumed_at"],
                    "invalidated_at": authorization["invalidated_at"],
                    "consumed": authorization["consumed_at"] is not None,
                }
                if authorization
                else None
            ),
            "facts_changed": False,
            "requires_human_review_for_future_compilation": True,
        }

    async def issue_application_submission_authorization(
        self,
        user_id: UUID,
        application_id: UUID,
        compilation_id: UUID,
        *,
        job_url: str,
        observed_url: str,
        confirmation: str,
        operation_id: UUID | None = None,
    ) -> dict[str, Any]:
        application = self.application_drafts.get(str(application_id))
        compilation = self.compilations.get(str(compilation_id))
        expected_confirmation = f"SUBMIT APPLICATION {application_id}"
        if confirmation != expected_confirmation:
            raise CareerGraphStateError(
                "application submission authorization requires the exact confirmation phrase"
            )
        if (
            not application
            or not compilation
            or application["user_id"] != str(user_id)
            or compilation["user_id"] != str(user_id)
            or application["compilation_id"] != str(compilation_id)
        ):
            raise CareerGraphNotFoundError(
                "application and compilation authorization scope not found"
            )
        if application["status"] != "review":
            raise CareerGraphStateError("only an application awaiting review can be authorized")
        if compilation["status"] not in {"approved", "published"}:
            raise CareerGraphStateError("approve the compilation before authorizing submission")
        if application["job_url"] != job_url:
            raise CareerGraphStateError("authorization must use the application's exact job URL")

        for authorization in self.submission_authorizations.values():
            if (
                authorization["user_id"] == str(user_id)
                and authorization["application_id"] == str(application_id)
                and authorization["consumed_at"] is None
                and authorization["invalidated_at"] is None
            ):
                authorization["invalidated_at"] = _now()

        now = datetime.now(UTC)
        authorization_id = str(uuid4())
        authorization = {
            "id": authorization_id,
            "user_id": str(user_id),
            "application_id": str(application_id),
            "compilation_id": str(compilation_id),
            "operation_id": str(operation_id) if operation_id else None,
            "expected_job_url_fingerprint": hashlib.sha256(job_url.encode("utf-8")).hexdigest(),
            "observed_url_fingerprint": hashlib.sha256(observed_url.encode("utf-8")).hexdigest(),
            "confirmation_digest": hashlib.sha256(confirmation.encode("utf-8")).hexdigest(),
            "authorized_at": now.isoformat(),
            "expires_at": (
                now + timedelta(minutes=SUBMISSION_AUTHORIZATION_TTL_MINUTES)
            ).isoformat(),
            "consumed_at": None,
            "invalidated_at": None,
        }
        self.submission_authorizations[authorization_id] = authorization
        return {
            "ok": True,
            "submission_authorization_id": authorization_id,
            "application_id": str(application_id),
            "compilation_id": str(compilation_id),
            "authorized_at": authorization["authorized_at"],
            "expires_at": authorization["expires_at"],
            "authorization_active": True,
            "authorization_scope": "one_application_one_final_click",
            "one_final_click_authorized": True,
            "server_side_submission": False,
            "post_click_requirement": (
                "Record submitted only after a visible post-submit confirmation."
            ),
        }

    async def get_application_submission_authorization_for_operation(
        self,
        user_id: UUID,
        operation_id: UUID,
    ) -> dict[str, Any] | None:
        authorization = next(
            (
                item
                for item in self.submission_authorizations.values()
                if item["user_id"] == str(user_id) and item.get("operation_id") == str(operation_id)
            ),
            None,
        )
        if authorization is None:
            return None
        active = (
            authorization["consumed_at"] is None
            and authorization["invalidated_at"] is None
            and datetime.fromisoformat(authorization["expires_at"]) > datetime.now(UTC)
        )
        return {
            "ok": True,
            "submission_authorization_id": authorization["id"],
            "application_id": authorization["application_id"],
            "compilation_id": authorization["compilation_id"],
            "authorized_at": authorization["authorized_at"],
            "expires_at": authorization["expires_at"],
            "consumed_at": authorization["consumed_at"],
            "invalidated_at": authorization["invalidated_at"],
            "authorization_active": active,
            "authorization_scope": "one_application_one_final_click",
            "one_final_click_authorized": active,
            "server_side_submission": False,
            "post_click_requirement": (
                "Record submitted only after a visible post-submit confirmation."
            ),
        }

    def _owned_graph(self, user_id: UUID, graph_id: UUID) -> dict[str, Any]:
        graph = self.graphs.get(str(graph_id))
        if not graph or graph["user_id"] != str(user_id):
            raise CareerGraphNotFoundError("Career Graph not found")
        return graph

    def _owned_compilation(self, user_id: UUID, compilation_id: UUID) -> dict[str, Any]:
        compilation = self.compilations.get(str(compilation_id))
        if not compilation or compilation["user_id"] != str(user_id):
            raise CareerGraphNotFoundError("compilation not found")
        return compilation

    def _append_publication_event(
        self,
        *,
        user_id: UUID,
        graph_id: str,
        event_kind: str,
        from_compilation_id: str | None,
        to_compilation_id: str | None,
        token: str,
    ) -> dict[str, Any]:
        event = {
            "id": str(uuid4()),
            "user_id": str(user_id),
            "graph_id": graph_id,
            "event_kind": event_kind,
            "event_source": "codex_mcp_explicit_confirmation",
            "from_compilation_id": from_compilation_id,
            "to_compilation_id": to_compilation_id,
            "public_token_digest": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "occurred_at": _now(),
        }
        self.publication_events.append(event)
        return event

    @staticmethod
    def _public_graph(graph: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in graph.items() if key != "user_id"}
