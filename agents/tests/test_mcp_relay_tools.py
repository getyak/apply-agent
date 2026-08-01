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
    assert proposal["review_summary"]["total_changes"] > 0
    assert proposal["confirmation"]["approve"] == f"APPROVE CAREER CHANGE {proposal['id']}"
    assert proposal["import_report"]["upsert_only"] is True
    assert proposal["import_report"]["node_count"] > 0
    change = await tools.get_career_graph_change(proposal["id"])
    node_ops = [op for op in change["operations"] if op["op"] == "upsert_node"]
    assert all(op["node"]["provenance"]["source_type"] == "resume_import" for op in node_ops)
    graph = await tools.get_career_graph(proposal["graph_id"])
    assert graph["current_revision"] is None
    await tools.approve_career_graph_change(
        change_set_id=proposal["id"],
        confirmation=proposal["confirmation"]["approve"],
    )
    graph = await tools.get_career_graph(proposal["graph_id"])
    assert graph["current_revision"]["created_by"] == "import"


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


async def test_identical_reproposal_is_rejected_as_noop() -> None:
    approved = await _approved_graph()
    with pytest.raises(CareerGraphStateError, match="does not change"):
        await tools.propose_career_graph_changes(
            graph_id=approved["graph_id"],
            operations=_operations(),
            summary="Repeat the already-approved snapshot",
        )


async def test_full_review_compile_handoff_publish_flow() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="PostgreSQL backend engineer",
    )
    compilation_id = compilation["id"]
    assert compilation["status"] == "draft"
    assert compilation["guard_report"]["source_only"] is True
    assert compilation["compiler_config"]["length_budget"] == "two_page"
    assert compilation["compiler_config"]["ats_profile"] == "standard"
    assert compilation["quality_report"]["quality_status"] == "ready_for_human_review"

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
    assert handoff["target_site"]["platform"] == "other"
    assert handoff["requires_submit_confirmation"] is True
    assert handoff["submission_gate"]["dom_button_state_is_authorization"] is False
    assert handoff["submission_gate"]["confirmation_phrase"] == (
        f"SUBMIT APPLICATION {application['application_id']}"
    )
    assert any("CAPTCHA" in item for item in handoff["forbidden_automation"])
    delivery = handoff["artifact_delivery"]
    assert delivery["artifact_format"] == "pdf"
    assert delivery["purpose"] == "application_upload"
    assert delivery["application_id"] == application["application_id"]
    assert len(delivery["download_code"]) == 64
    assert delivery["download_code"] not in delivery["download_page_url"]
    assert delivery["download_page_url"].startswith("http://localhost:3001/api/public/artifacts/")
    assert delivery["capability_secret_in_url"] is False
    assert delivery["public_resume_publication_required"] is False
    assert delivery["requires_local_download_before_upload"] is True

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


async def test_draft_artifact_review_is_separate_from_approval_and_upload() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer",
    )
    compilation_id = compilation["id"]

    first = await tools.prepare_resume_artifact_review(
        compilation_id=compilation_id,
        artifact_format="docx",
    )
    second = await tools.prepare_resume_artifact_review(
        compilation_id=compilation_id,
        artifact_format="docx",
    )

    delivery = second["artifact_delivery"]
    first_grant = tools.FAKE_STORE.artifact_delivery_grants[first["artifact_delivery"]["grant_id"]]
    assert first_grant["revoked"] is True
    assert second["compilation_status"] == "draft"
    assert second["approval_unchanged"] is True
    assert delivery["purpose"] == "compilation_review"
    assert delivery["application_id"] is None
    assert delivery["requires_local_download_before_upload"] is False
    assert delivery["public_resume_publication_required"] is False
    assert len(delivery["download_code"]) == 64
    assert delivery["download_code"] not in delivery["download_page_url"]
    assert tools.FAKE_STORE.compilations[compilation_id]["status"] == "draft"

    await tools.reject_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"REJECT RESUME {compilation_id}",
    )
    with pytest.raises(CareerGraphStateError, match="rejected compilations"):
        await tools.prepare_resume_artifact_review(
            compilation_id=compilation_id,
        )


async def test_application_handoff_rotates_delivery_grants_and_rejects_insecure_api_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer",
    )
    compilation_id = compilation["id"]
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

    first = await tools.prepare_application_handoff(
        compilation_id=compilation_id,
        job_url="https://jobs.example.test/backend",
        artifact_format="docx",
    )
    second = await tools.prepare_application_handoff(
        compilation_id=compilation_id,
        job_url="https://jobs.example.test/backend",
        artifact_format="docx",
    )
    first_grant = tools.FAKE_STORE.artifact_delivery_grants[first["artifact_delivery"]["grant_id"]]
    assert first["artifact_delivery"]["artifact_format"] == "docx"
    assert first_grant["revoked"] is True
    assert (
        second["artifact_delivery"]["download_code"]
        != (first["artifact_delivery"]["download_code"])
    )
    assert second["artifact_delivery"]["application_id"] == application["application_id"]

    monkeypatch.setenv("RELAY_API_BASE_URL", "http://api.example.test")
    with pytest.raises(CareerGraphStateError, match="loopback"):
        await tools.prepare_application_handoff(
            compilation_id=compilation_id,
            job_url="https://jobs.example.test/backend",
        )

    monkeypatch.setenv("RELAY_API_BASE_URL", "https://user@api.example.test")
    with pytest.raises(CareerGraphStateError, match="credentials"):
        await tools.prepare_application_handoff(
            compilation_id=compilation_id,
            job_url="https://jobs.example.test/backend",
        )


async def test_compiler_profile_round_trips_through_mcp_review() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="PostgreSQL backend engineer",
        artifact_locale="zh",
        length_budget="one_page",
        ats_profile="strict",
    )
    reviewed = await tools.get_resume_compilation(compilation["id"])

    assert reviewed["compiler_config"]["artifact_locale"] == "zh"
    assert reviewed["compiler_config"]["target_pages"] == 1
    assert reviewed["quality_report"]["ats"]["profile"] == "strict"
    assert reviewed["quality_report"]["length"]["budget"] == "one_page"
    assert reviewed["guard_report"]["source_only"] is True


async def test_compiler_rejects_unknown_profile_before_persisting() -> None:
    approved = await _approved_graph()
    with pytest.raises(CareerGraphStateError, match="artifact_locale"):
        await tools.compile_resume_for_jd(
            graph_id=approved["graph_id"],
            jd_text="Backend engineer",
            artifact_locale="fr",
        )
    with pytest.raises(CareerGraphStateError, match="at most 50000"):
        await tools.compile_resume_for_jd(
            graph_id=approved["graph_id"],
            jd_text="x" * 50_001,
        )
    assert tools.FAKE_STORE.compilations == {}


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


async def test_handoff_requires_a_draft_for_the_exact_job_url() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer",
    )
    compilation_id = compilation["id"]
    await tools.approve_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"APPROVE RESUME {compilation_id}",
    )
    await tools.create_application_draft(
        compilation_id=compilation_id,
        company="Example",
        role_title="Engineer",
        job_url="https://jobs.example.test/engineer",
    )
    with pytest.raises(CareerGraphStateError, match="exact job URL"):
        await tools.prepare_application_handoff(
            compilation_id=compilation_id,
            job_url="https://jobs.example.test/different-role",
        )


async def test_application_progress_builds_history_and_feedback_without_rewriting_facts() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer",
    )
    compilation_id = compilation["id"]
    await tools.approve_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"APPROVE RESUME {compilation_id}",
    )
    application = await tools.create_application_draft(
        compilation_id=compilation_id,
        company="Example",
        role_title="Engineer",
        job_url="https://jobs.example.test/engineer",
    )
    application_id = application["application_id"]

    submitted = await tools.record_application_progress(
        application_id=application_id,
        status="submitted",
        evidence_source="browser_confirmation",
        submitted_via="client_extension",
    )
    interviewed = await tools.record_application_progress(
        application_id=application_id,
        status="interview",
        evidence_source="recruiter_message",
        interview_date="2026-08-15",
    )
    rejected = await tools.record_application_progress(
        application_id=application_id,
        status="rejected",
        evidence_source="user_reported",
        outcome="Position filled",
        clear_interview_date=True,
    )
    repeated = await tools.record_application_progress(
        application_id=application_id,
        status="rejected",
        evidence_source="user_reported",
        outcome="Position filled",
        clear_interview_date=True,
    )
    report = await tools.get_career_graph_evidence_report(approved["graph_id"])

    assert submitted["history_event"]["event_source"] == ("codex_mcp_browser_confirmation")
    assert submitted["facts_changed"] is False
    assert interviewed["interview_date"] == "2026-08-15"
    assert rejected["status"] == "rejected"
    assert rejected["interview_date"] is None
    assert repeated["changed"] is False
    assert repeated["history_event"] is None
    assert report["linked_application_count"] == 1
    assert report["evidence"][0]["interview_count"] == 1
    assert report["evidence"][0]["ranking_score"] == 2
    assert report["application_history"][0]["furthest_observed_stage"] == "interview"
    assert report["application_history"][0]["event_count"] == 4
    assert report["cohorts"]["overall"]["interpretation"] == "insufficient_sample"
    assert report["ranking_policy"]["cohort_rates_change_facts_or_scores"] is False


async def test_application_progress_rejects_unverifiable_inputs_before_writing() -> None:
    with pytest.raises(CareerGraphStateError, match="interview_date"):
        await tools.record_application_progress(
            application_id="00000000-0000-4000-8000-000000000123",
            status="interview",
            evidence_source="user_reported",
            interview_date="next Tuesday",
        )
    with pytest.raises(CareerGraphStateError, match="only valid"):
        await tools.record_application_progress(
            application_id="00000000-0000-4000-8000-000000000123",
            status="offer",
            evidence_source="user_reported",
            submitted_via="manual",
        )
    assert tools.FAKE_STORE.application_drafts == {}


async def test_browser_checkpoint_is_owned_and_never_authorizes_submit() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer",
    )
    compilation_id = compilation["id"]
    await tools.approve_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"APPROVE RESUME {compilation_id}",
    )
    application = await tools.create_application_draft(
        compilation_id=compilation_id,
        company="Example",
        role_title="Engineer",
        job_url="https://jobs.lever.co/example/abc",
    )
    checkpoint = await tools.assess_application_browser_checkpoint(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        visible_text="Submit application",
        stage="before_submit",
    )
    assert checkpoint["application_id"] == application["application_id"]
    assert checkpoint["status"] == "review_required"
    assert checkpoint["safe_to_submit"] is False
    assert checkpoint["submission_gate"]["confirmation_phrase"] == (
        f"SUBMIT APPLICATION {application['application_id']}"
    )
    assert checkpoint["next_action"] == "ask_user_for_exact_confirmation_phrase"
    assert "resume" not in checkpoint


async def test_batch_prepares_each_application_without_blanket_submit_approval() -> None:
    approved = await _approved_graph()
    items = []
    targets = [
        (
            "Greenhouse Role",
            "https://job-boards.greenhouse.io/example/jobs/123",
        ),
        (
            "Boss Role",
            "https://www.zhipin.com/job_detail/example.html",
        ),
    ]
    for role_title, job_url in targets:
        compilation = await tools.compile_resume_for_jd(
            graph_id=approved["graph_id"],
            jd_text=f"{role_title} Python PostgreSQL",
        )
        compilation_id = compilation["id"]
        await tools.approve_resume_compilation(
            compilation_id=compilation_id,
            confirmation=f"APPROVE RESUME {compilation_id}",
        )
        items.append(
            {
                "compilation_id": compilation_id,
                "company": "Example",
                "role_title": role_title,
                "job_url": job_url,
            }
        )

    batch = await tools.prepare_application_batch(applications=items)
    assert [item["status"] for item in batch["applications"]] == [
        "prepared_not_submitted",
        "prepared_not_submitted",
    ]
    assert [item["target_site"]["platform"] for item in batch["applications"]] == [
        "greenhouse",
        "boss_zhipin",
    ]
    assert batch["batch"]["preparation_only"] is True
    assert batch["batch"]["blanket_submit_approval"] is False
    assert batch["batch"]["approval_granularity"] == "one_application"
    assert batch["server_side_submission"] is False
    assert all(item["handoff_ready"] is True for item in batch["applications"])
    assert all(item["next_tool"] == "prepare_application_handoff" for item in batch["applications"])
    assert all("handoff" not in item for item in batch["applications"])
    assert tools.FAKE_STORE.artifact_delivery_grants == {}


async def test_batch_validates_every_item_before_writing() -> None:
    with pytest.raises(CareerGraphStateError, match="absolute http"):
        await tools.prepare_application_batch(
            applications=[
                {
                    "compilation_id": "00000000-0000-4000-8000-000000000123",
                    "company": "Example",
                    "role_title": "Engineer",
                    "job_url": "javascript:alert(1)",
                }
            ]
        )
    assert tools.FAKE_STORE.application_drafts == {}
