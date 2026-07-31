from __future__ import annotations

import pytest

from agents.career_graph.store import CareerGraphStateError
from agents.mcp_relay import tools


def _operations() -> list[dict]:
    provenance = {"source_type": "user_asserted", "source_ref": "test fixture"}
    nodes = [
        {
            "id": "person:alex",
            "type": "person",
            "data": {"name": "Alex Doe", "email": "alex@example.test"},
            "provenance": provenance,
        },
        {
            "id": "role:acme",
            "type": "role",
            "data": {
                "organization": "Acme Corp",
                "position": "Backend Engineer",
                "start_date": "2022-01",
                "end_date": "present",
            },
            "provenance": provenance,
        },
        {
            "id": "achievement:postgres",
            "type": "achievement",
            "data": {"text": "Migrated billing workloads to PostgreSQL."},
            "provenance": provenance,
        },
    ]
    edges = [
        {
            "id": "edge:person-role",
            "from": "person:alex",
            "to": "role:acme",
            "type": "held_role",
        },
        {
            "id": "edge:role-achievement",
            "from": "role:acme",
            "to": "achievement:postgres",
            "type": "includes",
        },
    ]
    return [
        *({"op": "upsert_node", "node": node} for node in nodes),
        *({"op": "upsert_edge", "edge": edge} for edge in edges),
    ]


@pytest.fixture(autouse=True)
def _fake_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_MCP_FAKE", "1")
    tools.FAKE_STORE.reset()


async def _approved_graph() -> dict:
    proposal = await tools.propose_career_graph_changes(
        operations=_operations(),
        summary="Import user-confirmed work history",
    )
    change_id = proposal["id"]
    return await tools.approve_career_graph_change(
        change_set_id=change_id,
        confirmation=f"APPROVE CAREER CHANGE {change_id}",
    )


async def test_status_uses_server_side_identity() -> None:
    status = await tools.relay_status()
    assert status["identity_source"] == "fake_fixture"
    assert status["server_side_submission"] is False


async def test_evidence_report_is_owner_scoped_and_explains_ranking_policy() -> None:
    approved = await _approved_graph()
    report = await tools.get_career_graph_evidence_report(approved["graph_id"])
    assert report["graph_id"] == approved["graph_id"]
    assert report["linked_application_count"] == 0
    assert report["ranking_policy"]["jd_relevance_precedes_outcome_signal"] is True
    assert report["ranking_policy"]["rejection_penalty"] == 0


async def test_existing_resume_import_is_pending_and_source_provenanced() -> None:
    listed = await tools.list_source_resumes()
    resume_id = listed["resumes"][0]["id"]
    proposal = await tools.propose_resume_import(resume_id=resume_id)
    assert proposal["status"] == "pending"
    assert proposal["import_report"]["upsert_only"] is True
    assert proposal["import_report"]["node_count"] > 0
    change = await tools.get_career_graph_change(proposal["id"])
    node_ops = [op for op in change["operations"] if op["op"] == "upsert_node"]
    assert all(op["node"]["provenance"]["source_type"] == "resume_import" for op in node_ops)
    graph = await tools.get_career_graph(proposal["graph_id"])
    assert graph["current_revision"] is None


async def test_graph_change_requires_exact_confirmation() -> None:
    proposal = await tools.propose_career_graph_changes(
        operations=_operations(),
        summary="Import user-confirmed work history",
    )
    with pytest.raises(CareerGraphStateError, match="human confirmation"):
        await tools.approve_career_graph_change(
            change_set_id=proposal["id"],
            confirmation="yes",
        )
    graphs = await tools.list_career_graphs()
    assert graphs["graphs"][0]["revision"] == 0


async def test_full_review_compile_handoff_publish_flow() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="PostgreSQL backend engineer",
    )
    compilation_id = compilation["id"]
    assert compilation["status"] == "draft"
    assert compilation["guard_report"]["source_only"] is True

    with pytest.raises(CareerGraphStateError, match="approve the compilation"):
        await tools.prepare_application_handoff(
            compilation_id=compilation_id,
            job_url="https://jobs.example.test/backend",
        )

    await tools.approve_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"APPROVE RESUME {compilation_id}",
    )
    application = await tools.create_application_draft(
        compilation_id=compilation_id,
        company="Example",
        role_title="Backend Engineer",
        job_url="https://jobs.example.test/backend",
    )
    repeated = await tools.create_application_draft(
        compilation_id=compilation_id,
        company="Example",
        role_title="Backend Engineer",
        job_url="https://jobs.example.test/backend",
    )
    assert application["application_status"] == "review"
    assert application["server_side_submission"] is False
    assert repeated["application_id"] == application["application_id"]
    assert repeated["reused"] is True

    handoff = await tools.prepare_application_handoff(
        compilation_id=compilation_id,
        job_url="https://jobs.example.test/backend",
    )
    assert handoff["application_id"] == application["application_id"]
    assert handoff["execution"] == "user_browser_only"
    assert handoff["requires_submit_confirmation"] is True
    assert any("CAPTCHA" in item for item in handoff["forbidden_automation"])

    with pytest.raises(CareerGraphStateError, match="explicit confirmation"):
        await tools.publish_resume_compilation(
            compilation_id=compilation_id,
            confirmation="publish it",
        )
    published = await tools.publish_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"PUBLISH {compilation_id}",
    )
    assert published["status"] == "published"
    assert published["public_url"].startswith("http://localhost:3000/r/")


async def test_application_draft_requires_approved_compilation() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer",
    )
    with pytest.raises(CareerGraphStateError, match="approve the compilation"):
        await tools.create_application_draft(
            compilation_id=compilation["id"],
            company="Example",
            role_title="Engineer",
            job_url="https://jobs.example.test/engineer",
        )
