"""Outcome signals that rank evidence without changing Career Graph facts."""

from __future__ import annotations

import math
from typing import Any

MIN_DIRECTIONAL_SAMPLE_SIZE = 20
CONFIDENCE_Z_95 = 1.96
STAGE_ORDER = {
    "prepared": 0,
    "submitted": 1,
    "interview": 2,
    "offer": 3,
}


def _observed_stage(
    *,
    status: Any,
    submitted_at: Any = None,
    interview_date: Any = None,
) -> str:
    normalized_status = str(status or "").casefold()
    if normalized_status in {"offer", "accepted"}:
        return "offer"
    if normalized_status == "interview" or interview_date:
        return "interview"
    if (
        normalized_status
        in {
            "submitted",
            "rejected",
            "withdrawn",
            "ghosted",
            "closed",
        }
        or submitted_at
    ):
        return "submitted"
    return "prepared"


def _stage(record: dict[str, Any]) -> str:
    """Return the furthest observable application stage.

    Free-text outcomes are deliberately not classified. A user-entered note is
    useful context, but silently interpreting it as an offer or rejection would
    make the ranking opaque and language-dependent.
    """

    observed = [
        _observed_stage(
            status=record.get("status"),
            submitted_at=record.get("submitted_at"),
            interview_date=record.get("interview_date"),
        )
    ]
    persisted_stage = record.get("furthest_observed_stage")
    if isinstance(persisted_stage, str) and persisted_stage in STAGE_ORDER:
        observed.append(persisted_stage)
    history = record.get("history")
    if isinstance(history, list):
        for event in history:
            if not isinstance(event, dict):
                continue
            observed.append(
                _observed_stage(
                    status=event.get("to_status"),
                    submitted_at=event.get("submitted_at"),
                    interview_date=event.get("interview_date"),
                )
            )
    return max(observed, key=lambda stage: STAGE_ORDER[stage])


def _wilson_interval(successes: int, total: int) -> list[float] | None:
    """Return a bounded 95% Wilson score interval for a binomial rate."""

    if total <= 0:
        return None
    proportion = successes / total
    z_squared = CONFIDENCE_Z_95**2
    denominator = 1 + z_squared / total
    center = (proportion + z_squared / (2 * total)) / denominator
    margin = (
        CONFIDENCE_Z_95
        * math.sqrt((proportion * (1 - proportion) + z_squared / (4 * total)) / total)
        / denominator
    )
    return [round(max(0.0, center - margin), 4), round(min(1.0, center + margin), 4)]


def _compiler_profile_key(record: dict[str, Any]) -> tuple[str, str, str, str]:
    value = record.get("compiler_config")
    config = value if isinstance(value, dict) else {}
    return (
        str(config.get("profile_version", "legacy")),
        str(config.get("artifact_locale", "legacy")),
        str(config.get("length_budget", "legacy")),
        str(config.get("ats_profile", "legacy")),
    )


def _cohort_row(
    records: list[dict[str, Any]],
    *,
    cohort_key: str,
    cohort_kind: str,
) -> dict[str, Any]:
    stages = [_stage(record) for record in records]
    submitted_count = sum(STAGE_ORDER[stage] >= STAGE_ORDER["submitted"] for stage in stages)
    interview_count = sum(STAGE_ORDER[stage] >= STAGE_ORDER["interview"] for stage in stages)
    offer_count = sum(stage == "offer" for stage in stages)
    jd_fingerprints = {
        str(record["jd_fingerprint"])
        for record in records
        if isinstance(record.get("jd_fingerprint"), str) and record["jd_fingerprint"]
    }
    has_directional_sample = submitted_count >= MIN_DIRECTIONAL_SAMPLE_SIZE
    if cohort_kind == "compiler_profile":
        has_directional_sample = has_directional_sample and len(jd_fingerprints) >= 2
    return {
        "cohort_key": cohort_key,
        "application_count": len(records),
        "distinct_jd_count": len(jd_fingerprints),
        "prepared_count": len(records),
        "submitted_count": submitted_count,
        "interview_count": interview_count,
        "offer_count": offer_count,
        "rates": {
            "interview_per_submitted": (
                round(interview_count / submitted_count, 4) if submitted_count else None
            ),
            "offer_per_submitted": (
                round(offer_count / submitted_count, 4) if submitted_count else None
            ),
        },
        "confidence_95": {
            "method": "wilson_score",
            "sample_size": submitted_count,
            "interview_per_submitted": _wilson_interval(interview_count, submitted_count),
            "offer_per_submitted": _wilson_interval(offer_count, submitted_count),
        },
        "directional_use": has_directional_sample,
        "interpretation": ("directional_only" if has_directional_sample else "insufficient_sample"),
    }


def _cohort_report(records: list[dict[str, Any]]) -> dict[str, Any]:
    by_jd: dict[str, list[dict[str, Any]]] = {}
    by_profile: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    for record in records:
        fingerprint = str(record.get("jd_fingerprint") or "unknown")
        by_jd.setdefault(fingerprint, []).append(record)
        by_profile.setdefault(_compiler_profile_key(record), []).append(record)

    profile_rows = []
    for key, cohort_records in sorted(by_profile.items()):
        profile_version, artifact_locale, length_budget, ats_profile = key
        row = _cohort_row(
            cohort_records,
            cohort_key="|".join(key),
            cohort_kind="compiler_profile",
        )
        row["compiler_profile"] = {
            "profile_version": profile_version,
            "artifact_locale": artifact_locale,
            "length_budget": length_budget,
            "ats_profile": ats_profile,
        }
        profile_rows.append(row)

    return {
        "overall": _cohort_row(records, cohort_key="all", cohort_kind="overall"),
        "by_jd_fingerprint": [
            _cohort_row(
                cohort_records,
                cohort_key=fingerprint,
                cohort_kind="jd_fingerprint",
            )
            for fingerprint, cohort_records in sorted(by_jd.items())
        ],
        "cross_jd_by_compiler_profile": profile_rows,
        "minimum_directional_sample_size": MIN_DIRECTIONAL_SAMPLE_SIZE,
        "methodology": {
            "furthest_observed_stage": True,
            "free_text_outcome_classified": False,
            "confidence_interval": "95% Wilson score over submitted applications",
            "cross_jd_requires_distinct_jd_count": 2,
            "causal_claim": False,
        },
    }


def _application_history(record: dict[str, Any], stage: str) -> dict[str, Any]:
    value = record.get("history")
    history = value if isinstance(value, list) else []
    return {
        "application_id": str(record.get("application_id") or ""),
        "jd_fingerprint": record.get("jd_fingerprint"),
        "current_status": record.get("status"),
        "furthest_observed_stage": stage,
        "event_count": int(record.get("history_event_count") or len(history)),
        "events_truncated": bool(record.get("history_truncated")),
        "events": history,
    }


def aggregate_evidence_outcomes(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate owner-scoped application stages by selected graph node.

    The score is intentionally positive-only: interview evidence contributes
    two points and offer evidence five. Rejections are not negative evidence
    because a résumé fact is not necessarily what caused the decision.
    """

    stats: dict[str, dict[str, Any]] = {}
    linked_applications: set[str] = set()
    application_history: list[dict[str, Any]] = []

    for record in records:
        application_id = str(record.get("application_id") or "")
        if application_id:
            linked_applications.add(application_id)
        stage = _stage(record)
        application_history.append(_application_history(record, stage))
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
        "application_history": application_history,
        "cohorts": _cohort_report(records),
        "ranking_policy": {
            "jd_relevance_precedes_outcome_signal": True,
            "interview_points": 2,
            "offer_points": 5,
            "rejection_penalty": 0,
            "free_text_outcome_classified": False,
            "history_uses_furthest_observed_stage": True,
            "cohort_rates_change_facts_or_scores": False,
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
