"""In-memory Career Graph store for protocol tests and first-run demos."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
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
        report = aggregate_evidence_outcomes([])
        return {
            "graph_id": str(graph_id),
            "graph_revision": (
                graph["current_revision"]["revision"] if graph["current_revision"] else 0
            ),
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
