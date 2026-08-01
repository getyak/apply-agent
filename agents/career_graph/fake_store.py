"""In-memory Career Graph store for protocol tests and first-run demos."""

from __future__ import annotations

import hashlib
import secrets
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
    CareerGraphConflictError,
    CareerGraphNotFoundError,
    CareerGraphStateError,
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


class InMemoryCareerGraphStore:
    """Small stateful store with the same review semantics as PostgreSQL."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.graphs: dict[str, dict[str, Any]] = {}
        self.change_sets: dict[str, dict[str, Any]] = {}
        self.compilations: dict[str, dict[str, Any]] = {}
        self.application_drafts: dict[str, dict[str, Any]] = {}
        self.artifact_delivery_grants: dict[str, dict[str, Any]] = {}

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
            "resume_id": resume_id,
            "resume_version": len(self.compilations) + 1,
            "jd_fingerprint": fingerprint,
            **compiled,
            "publish_token": None,
            "created_at": _now(),
            "approved_at": None,
            "published_at": None,
        }
        self.compilations[compilation_id] = compilation
        return {key: value for key, value in compilation.items() if key != "user_id"} | {
            "requires_human_approval": True
        }

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
        return {key: value for key, value in compilation.items() if key != "user_id"}

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
        token = uuid4().hex
        compilation["status"] = "published"
        compilation["publish_token"] = token
        compilation["published_at"] = _now()
        return {
            "ok": True,
            "compilation_id": str(compilation_id),
            "resume_id": compilation["resume_id"],
            "status": "published",
            "public_url": f"{public_base_url.rstrip('/')}/r/{token}",
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
                "job_id": str(uuid4()),
                "company": company,
                "role_title": role_title,
                "job_url": job_url,
                "status": "review",
                "outcome": None,
                "submitted_at": None,
                "submitted_via": None,
                "interview_date": None,
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
    ) -> dict[str, Any]:
        application = self.application_drafts.get(str(application_id))
        if not application or application["user_id"] != str(user_id):
            raise CareerGraphNotFoundError("Career Graph application not found")
        old_status = application["status"]
        old_outcome = application.get("outcome")
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
                "occurred_at": _now(),
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
            "facts_changed": False,
            "requires_human_review_for_future_compilation": True,
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

    @staticmethod
    def _public_graph(graph: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in graph.items() if key != "user_id"}
