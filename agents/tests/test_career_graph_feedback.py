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


def test_history_preserves_furthest_stage_after_current_status_changes() -> None:
    report = aggregate_evidence_outcomes(
        [
            {
                "application_id": "history",
                "status": "rejected",
                "selected_node_ids": ["achievement:history"],
                "history": [
                    {
                        "to_status": "submitted",
                        "submitted_at": "2026-01-01T00:00:00Z",
                    },
                    {
                        "to_status": "interview",
                        "interview_date": "2026-01-10",
                    },
                    {
                        "to_status": "rejected",
                        "interview_date": None,
                    },
                ],
            }
        ]
    )

    evidence = report["evidence"][0]
    assert evidence["submitted_count"] == 1
    assert evidence["interview_count"] == 1
    assert evidence["ranking_score"] == 2
    assert report["application_history"][0]["current_status"] == "rejected"
    assert report["application_history"][0]["furthest_observed_stage"] == "interview"
    assert report["ranking_policy"]["history_uses_furthest_observed_stage"] is True


def test_cross_jd_cohort_requires_real_sample_and_reports_confidence() -> None:
    records = []
    for index in range(20):
        records.append(
            {
                "application_id": f"application-{index}",
                "status": "interview" if index < 8 else "submitted",
                "selected_node_ids": ["achievement:shared"],
                "jd_fingerprint": "jd-a" if index % 2 == 0 else "jd-b",
                "compiler_config": {
                    "profile_version": 1,
                    "artifact_locale": "en",
                    "length_budget": "two_page",
                    "ats_profile": "standard",
                },
            }
        )

    report = aggregate_evidence_outcomes(records)
    cohort = report["cohorts"]["cross_jd_by_compiler_profile"][0]

    assert cohort["application_count"] == 20
    assert cohort["distinct_jd_count"] == 2
    assert cohort["rates"]["interview_per_submitted"] == 0.4
    assert cohort["confidence_95"]["sample_size"] == 20
    low, high = cohort["confidence_95"]["interview_per_submitted"]
    assert 0 < low < 0.4 < high < 1
    assert cohort["directional_use"] is True
    assert cohort["interpretation"] == "directional_only"
    assert report["cohorts"]["methodology"]["causal_claim"] is False


def test_small_cohort_is_explicitly_insufficient() -> None:
    report = aggregate_evidence_outcomes(
        [
            {
                "application_id": "one",
                "status": "offer",
                "selected_node_ids": ["achievement:a"],
                "jd_fingerprint": "jd-one",
            }
        ]
    )

    assert report["cohorts"]["overall"]["directional_use"] is False
    assert report["cohorts"]["overall"]["interpretation"] == "insufficient_sample"
    assert report["cohorts"]["overall"]["confidence_95"]["sample_size"] == 1


def test_persisted_furthest_stage_survives_truncated_timeline_details() -> None:
    report = aggregate_evidence_outcomes(
        [
            {
                "application_id": "truncated",
                "status": "closed",
                "furthest_observed_stage": "offer",
                "history": [],
                "history_event_count": 150,
                "history_truncated": True,
                "selected_node_ids": ["achievement:offer"],
            }
        ]
    )

    assert report["evidence"][0]["offer_count"] == 1
    assert report["evidence"][0]["ranking_score"] == 5
    assert report["application_history"][0]["events_truncated"] is True
