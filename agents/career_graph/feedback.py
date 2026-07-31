"""Outcome signals that rank evidence without changing Career Graph facts."""

from __future__ import annotations

from typing import Any


def _stage(record: dict[str, Any]) -> str:
    """Return the furthest observable application stage.

    Free-text outcomes are deliberately not classified. A user-entered note is
    useful context, but silently interpreting it as an offer or rejection would
    make the ranking opaque and language-dependent.
    """

    status = str(record.get("status") or "").casefold()
    if status == "offer":
        return "offer"
    if status == "interview" or record.get("interview_date"):
        return "interview"
    if status in {"submitted", "rejected", "withdrawn"} or record.get("submitted_at"):
        return "submitted"
    return "prepared"


def aggregate_evidence_outcomes(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate owner-scoped application stages by selected graph node.

    The score is intentionally positive-only: interview evidence contributes
    two points and offer evidence five. Rejections are not negative evidence
    because a résumé fact is not necessarily what caused the decision.
    """

    stats: dict[str, dict[str, Any]] = {}
    linked_applications: set[str] = set()

    for record in records:
        application_id = str(record.get("application_id") or "")
        if application_id:
            linked_applications.add(application_id)
        stage = _stage(record)
        selected_node_ids = record.get("selected_node_ids")
        if not isinstance(selected_node_ids, list):
            continue
        for node_id in dict.fromkeys(selected_node_ids):
            if not isinstance(node_id, str) or not node_id:
                continue
            item = stats.setdefault(
                node_id,
                {
                    "node_id": node_id,
                    "application_count": 0,
                    "submitted_count": 0,
                    "interview_count": 0,
                    "offer_count": 0,
                    "ranking_score": 0,
                },
            )
            item["application_count"] += 1
            if stage in {"submitted", "interview", "offer"}:
                item["submitted_count"] += 1
            if stage in {"interview", "offer"}:
                item["interview_count"] += 1
            if stage == "offer":
                item["offer_count"] += 1
            item["ranking_score"] += {"prepared": 0, "submitted": 0, "interview": 2, "offer": 5}[
                stage
            ]

    evidence = sorted(
        stats.values(),
        key=lambda item: (
            -int(item["ranking_score"]),
            -int(item["offer_count"]),
            -int(item["interview_count"]),
            str(item["node_id"]),
        ),
    )
    return {
        "linked_application_count": len(linked_applications),
        "evidence": evidence,
        "ranking_policy": {
            "jd_relevance_precedes_outcome_signal": True,
            "interview_points": 2,
            "offer_points": 5,
            "rejection_penalty": 0,
            "free_text_outcome_classified": False,
        },
        "causality_warning": (
            "Application outcomes are correlation signals, not proof that a selected "
            "résumé fact caused the result."
        ),
    }


def evidence_scores(report: dict[str, Any]) -> dict[str, int]:
    """Return the compiler's node-id → transparent ranking-score mapping."""

    rows = report.get("evidence")
    if not isinstance(rows, list):
        return {}
    return {
        row["node_id"]: int(row["ranking_score"])
        for row in rows
        if isinstance(row, dict)
        and isinstance(row.get("node_id"), str)
        and isinstance(row.get("ranking_score"), int)
    }
