from __future__ import annotations

from agents.career_graph.importer import json_resume_to_operations


def _resume() -> dict:
    return {
        "basics": {
            "name": "Alex Doe",
            "email": "alex@example.test",
            "location": {"city": "Singapore", "countryCode": "SG"},
        },
        "work": [
            {
                "name": "Acme Corp",
                "position": "Backend Engineer",
                "startDate": "2022-01",
                "endDate": "present",
                "highlights": [
                    "Migrated billing workloads to PostgreSQL.",
                    "Owned the on-call rotation.",
                ],
            }
        ],
        "skills": [{"name": "PostgreSQL"}, "Python"],
        "education": [
            {
                "institution": "Example University",
                "area": "Computer Science",
                "studyType": "BSc",
            }
        ],
    }


def test_import_is_deterministic_upsert_only_and_provenanced() -> None:
    first = json_resume_to_operations(_resume(), source_ref="resume:abc:v1")
    second = json_resume_to_operations(_resume(), source_ref="resume:abc:v1")
    assert first == second
    assert first["report"]["upsert_only"] is True
    assert all(operation["op"].startswith("upsert_") for operation in first["operations"])

    node_operations = [
        operation for operation in first["operations"] if operation["op"] == "upsert_node"
    ]
    assert len(node_operations) == 7
    assert all(
        operation["node"]["provenance"]
        == {"source_type": "resume_import", "source_ref": "resume:abc:v1"}
        for operation in node_operations
    )


def test_import_builds_role_achievement_relationships() -> None:
    imported = json_resume_to_operations(_resume(), source_ref="resume:abc:v1")
    edge_types = {
        operation["edge"]["type"]
        for operation in imported["operations"]
        if operation["op"] == "upsert_edge"
    }
    assert {"held_role", "includes", "studied"}.issubset(edge_types)


def test_import_does_not_treat_missing_sections_as_removals() -> None:
    imported = json_resume_to_operations(
        {"basics": {"name": "Alex Doe"}},
        source_ref="resume:abc:v2",
    )
    assert all(operation["op"] != "remove_node" for operation in imported["operations"])
