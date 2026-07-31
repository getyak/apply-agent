from __future__ import annotations

import copy

import pytest

from agents.career_graph.model import (
    GraphValidationError,
    apply_operations,
    compile_resume,
    empty_snapshot,
    normalize_compiler_config,
    summarize_snapshot_changes,
    validate_snapshot,
)


def _node(node_id: str, node_type: str, data: dict) -> dict:
    return {
        "id": node_id,
        "type": node_type,
        "data": data,
        "provenance": {"source_type": "user_asserted", "source_ref": "test"},
    }


def _snapshot() -> dict:
    return {
        "schema_version": 1,
        "nodes": [
            _node(
                "person:alex",
                "person",
                {"name": "Alex Doe", "email": "alex@example.test"},
            ),
            _node(
                "role:acme",
                "role",
                {
                    "organization": "Acme Corp",
                    "position": "Senior Backend Engineer",
                    "start_date": "2021-01",
                    "end_date": "2024-06",
                },
            ),
            _node(
                "achievement:frontend",
                "achievement",
                {"text": "Shipped an accessible React account settings page."},
            ),
            _node(
                "achievement:database",
                "achievement",
                {"text": "Migrated billing from MySQL to PostgreSQL without downtime."},
            ),
            _node("skill:react", "skill", {"name": "React"}),
            _node("skill:postgres", "skill", {"name": "PostgreSQL"}),
        ],
        "edges": [
            {
                "id": "edge:person-role",
                "from": "person:alex",
                "to": "role:acme",
                "type": "held_role",
            },
            {
                "id": "edge:role-frontend",
                "from": "role:acme",
                "to": "achievement:frontend",
                "type": "includes",
            },
            {
                "id": "edge:role-database",
                "from": "role:acme",
                "to": "achievement:database",
                "type": "includes",
            },
            {
                "id": "edge:frontend-react",
                "from": "achievement:frontend",
                "to": "skill:react",
                "type": "demonstrates",
            },
            {
                "id": "edge:database-postgres",
                "from": "achievement:database",
                "to": "skill:postgres",
                "type": "demonstrates",
            },
        ],
    }


def test_empty_snapshot_is_valid() -> None:
    assert validate_snapshot(empty_snapshot()) == []


def test_every_node_requires_provenance() -> None:
    snapshot = _snapshot()
    del snapshot["nodes"][0]["provenance"]
    assert any("provenance" in error for error in validate_snapshot(snapshot))


def test_every_node_requires_traceable_source_reference() -> None:
    snapshot = _snapshot()
    snapshot["nodes"][0]["provenance"]["source_ref"] = " "
    assert any("source_ref" in error for error in validate_snapshot(snapshot))


def test_apply_operations_is_immutable_and_removes_incident_edges() -> None:
    snapshot = _snapshot()
    before = copy.deepcopy(snapshot)
    result = apply_operations(
        snapshot,
        [{"op": "remove_node", "node_id": "skill:react"}],
    )
    assert snapshot == before
    assert "skill:react" not in {node["id"] for node in result["nodes"]}
    assert "edge:frontend-react" not in {edge["id"] for edge in result["edges"]}


def test_apply_operations_rejects_dangling_edge() -> None:
    with pytest.raises(GraphValidationError, match="missing node"):
        apply_operations(
            empty_snapshot(),
            [
                {
                    "op": "upsert_edge",
                    "edge": {
                        "id": "edge:bad",
                        "from": "missing:a",
                        "to": "missing:b",
                        "type": "includes",
                    },
                }
            ],
        )


def test_change_summary_reports_exact_review_diff_without_unchanged_entities() -> None:
    before = _snapshot()
    after = apply_operations(
        before,
        [
            {
                "op": "upsert_node",
                "node": _node("skill:python", "skill", {"name": "Python"}),
            },
            {
                "op": "upsert_node",
                "node": _node(
                    "role:acme",
                    "role",
                    {
                        "organization": "Acme Corp",
                        "position": "Staff Backend Engineer",
                        "start_date": "2021-01",
                        "end_date": "2024-06",
                    },
                ),
            },
            {"op": "remove_node", "node_id": "skill:react"},
        ],
    )

    summary = summarize_snapshot_changes(before, after)

    assert summary["total_changes"] == 4
    assert summary["destructive"] is True
    assert summary["counts"] == {
        "added_nodes": 1,
        "updated_nodes": 1,
        "removed_nodes": 1,
        "added_edges": 0,
        "updated_edges": 0,
        "removed_edges": 1,
    }
    assert [item["id"] for item in summary["nodes"]] == [
        "role:acme",
        "skill:python",
        "skill:react",
    ]
    assert summary["nodes"][0]["before"]["data"]["position"] == "Senior Backend Engineer"
    assert summary["nodes"][0]["after"]["data"]["position"] == "Staff Backend Engineer"


def test_change_summary_is_empty_for_identical_snapshots() -> None:
    summary = summarize_snapshot_changes(_snapshot(), _snapshot())
    assert summary["total_changes"] == 0
    assert summary["destructive"] is False
    assert summary["nodes"] == []
    assert summary["edges"] == []


def test_compile_selects_jd_relevant_fact_without_rewriting_it() -> None:
    compiled = compile_resume(
        _snapshot(),
        "We need PostgreSQL database migration experience.",
        max_achievements_per_role=1,
    )
    highlights = compiled["resume"]["work"][0]["highlights"]
    assert highlights == ["Migrated billing from MySQL to PostgreSQL without downtime."]
    assert compiled["selection_manifest"]["work.0.highlights"] == ["achievement:database"]
    assert compiled["guard_report"]["source_only"] is True
    assert compiled["guard_report"]["fabricated_entities"] == []


def test_compile_never_adds_jd_only_claims() -> None:
    compiled = compile_resume(
        _snapshot(),
        "Must have Kubernetes, Rust, and 10 years of leadership.",
    )
    rendered = str(compiled["resume"])
    assert "Kubernetes" not in rendered
    assert "Rust" not in rendered
    assert "10 years" not in rendered


def test_jd_coverage_normalizes_punctuation_and_ignores_stop_words() -> None:
    compiled = compile_resume(
        _snapshot(),
        "PostgreSQL with reliability.",
    )
    coverage = compiled["quality_report"]["jd_coverage"]

    assert coverage["jd_token_count"] == 2
    assert coverage["matched_tokens"] == ["postgresql"]
    assert coverage["unmatched_tokens"] == ["reliability"]


def test_compile_uses_outcome_signal_only_as_jd_tiebreaker() -> None:
    compiled = compile_resume(
        _snapshot(),
        "Backend engineering",
        max_achievements_per_role=1,
        evidence_ranking={"achievement:database": 5},
    )
    assert compiled["resume"]["work"][0]["highlights"] == [
        "Migrated billing from MySQL to PostgreSQL without downtime."
    ]
    assert compiled["guard_report"]["outcome_ranked_node_count"] == 1

    jd_wins = compile_resume(
        _snapshot(),
        "React accessibility",
        max_achievements_per_role=1,
        evidence_ranking={"achievement:database": 100},
    )
    assert jd_wins["resume"]["work"][0]["highlights"] == [
        "Shipped an accessible React account settings page."
    ]


def test_one_page_profile_caps_sections_and_reports_omitted_evidence() -> None:
    snapshot = _snapshot()
    for index in range(8):
        achievement_id = f"achievement:extra-{index}"
        snapshot["nodes"].append(
            _node(
                achievement_id,
                "achievement",
                {"text": f"Delivered PostgreSQL reliability improvement {index}."},
            )
        )
        snapshot["edges"].append(
            {
                "id": f"edge:extra-{index}",
                "from": "role:acme",
                "to": achievement_id,
                "type": "includes",
            }
        )
    for index in range(12):
        snapshot["nodes"].append(_node(f"skill:extra-{index}", "skill", {"name": f"Skill {index}"}))

    compiled = compile_resume(
        snapshot,
        "PostgreSQL reliability",
        artifact_locale="zh",
        length_budget="one_page",
        ats_profile="strict",
    )

    assert compiled["compiler_config"]["profile_version"] == 1
    assert compiled["compiler_config"]["artifact_locale"] == "zh"
    assert compiled["compiler_config"]["target_pages"] == 1
    assert len(compiled["resume"]["work"][0]["highlights"]) == 3
    assert len(compiled["resume"]["skills"]) == 10
    assert compiled["quality_report"]["artifact_locale_behavior"] == (
        "structural_labels_only_source_facts_unchanged"
    )
    assert compiled["quality_report"]["selection"]["omitted_node_count"] > 0
    source_achievements = {
        node["data"]["text"] for node in snapshot["nodes"] if node["type"] == "achievement"
    }
    assert set(compiled["resume"]["work"][0]["highlights"]) <= source_achievements


def test_strict_ats_profile_reports_missing_fields_without_fabricating_them() -> None:
    snapshot = _snapshot()
    del snapshot["nodes"][0]["data"]["email"]
    del snapshot["nodes"][1]["data"]["end_date"]

    compiled = compile_resume(snapshot, "Backend engineer", ats_profile="strict")

    checks = {item["id"]: item["passed"] for item in compiled["quality_report"]["ats"]["checks"]}
    assert checks["has_email"] is False
    assert checks["work_dates_present"] is False
    assert compiled["quality_report"]["ats"]["ready"] is False
    assert compiled["quality_report"]["quality_status"] == "needs_human_attention"
    assert "email" not in compiled["resume"]["basics"]
    assert compiled["guard_report"]["source_only"] is True


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("artifact_locale", "fr", "artifact_locale"),
        ("length_budget", "three_page", "length_budget"),
        ("ats_profile", "magic", "ats_profile"),
        ("max_achievements_per_role", 0, "between 1 and 8"),
        ("max_achievements_per_role", 2.5, "between 1 and 8"),
        ("max_achievements_per_role", True, "between 1 and 8"),
    ],
)
def test_compiler_profile_rejects_unknown_or_unsafe_inputs(
    field: str,
    value: object,
    message: str,
) -> None:
    values: dict[str, object] = {
        "artifact_locale": "en",
        "length_budget": "two_page",
        "ats_profile": "standard",
        "max_achievements_per_role": None,
    }
    values[field] = value
    with pytest.raises(ValueError, match=message):
        normalize_compiler_config(**values)  # type: ignore[arg-type]
