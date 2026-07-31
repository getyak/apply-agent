from __future__ import annotations

from agents.career_graph.feedback import aggregate_evidence_outcomes, evidence_scores


def test_outcome_report_is_positive_only_and_does_not_classify_free_text() -> None:
    report = aggregate_evidence_outcomes(
        [
            {
                "application_id": "submitted",
                "status": "rejected",
                "submitted_at": "2026-01-01",
                "selected_node_ids": ["achievement:a"],
            },
            {
                "application_id": "interview",
                "status": "rejected",
                "submitted_at": "2026-01-01",
                "interview_date": "2026-01-10",
                "selected_node_ids": ["achievement:a"],
            },
            {
                "application_id": "ambiguous-note",
                "status": "submitted",
                "submitted_at": "2026-01-01",
                "outcome": "offer",
                "selected_node_ids": ["achievement:b"],
            },
        ]
    )
    by_id = {row["node_id"]: row for row in report["evidence"]}
    assert by_id["achievement:a"]["ranking_score"] == 2
    assert by_id["achievement:a"]["interview_count"] == 1
    assert by_id["achievement:b"]["ranking_score"] == 0
    assert report["ranking_policy"]["rejection_penalty"] == 0
    assert report["ranking_policy"]["free_text_outcome_classified"] is False
    assert evidence_scores(report) == {"achievement:a": 2, "achievement:b": 0}


def test_offer_is_the_strongest_transparent_signal() -> None:
    report = aggregate_evidence_outcomes(
        [
            {
                "application_id": "offer",
                "status": "offer",
                "selected_node_ids": ["achievement:offer"],
            },
            {
                "application_id": "interview",
                "status": "interview",
                "selected_node_ids": ["achievement:interview"],
            },
        ]
    )
    assert [row["node_id"] for row in report["evidence"]] == [
        "achievement:offer",
        "achievement:interview",
    ]
    assert evidence_scores(report) == {
        "achievement:offer": 5,
        "achievement:interview": 2,
    }
