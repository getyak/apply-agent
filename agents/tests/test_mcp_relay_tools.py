from __future__ import annotations

from uuid import UUID

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


async def _approve_questionnaire(
    *,
    compilation_id: str,
    application_id: str,
    job_url: str,
    company: str,
    role_title: str,
    questions: list[dict] | None = None,
) -> dict:
    proposed = await tools.propose_application_questionnaire(
        compilation_id=compilation_id,
        job_url=job_url,
        observed_url=job_url + ("/apply" if "jobs.lever.co" in job_url else ""),
        observed_company=company,
        observed_role_title=role_title,
        questions=(
            questions
            if questions is not None
            else [
                {
                    "id": "resume_cv",
                    "label": "Resume/CV",
                    "field_type": "file",
                    "required": True,
                    "answer": None,
                    "action": "manual",
                    "confidence": 0,
                    "evidence": [],
                }
            ]
        ),
        visible_text="Application form",
    )
    assert proposed["status"] == "draft"
    return await tools.approve_application_questionnaire(
        compilation_id=compilation_id,
        job_url=job_url,
        confirmation=f"APPROVE QUESTIONNAIRE {application_id}",
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


async def test_inventory_restores_versions_and_outcomes_without_capabilities() -> None:
    approved = await _approved_graph()
    draft = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Python platform engineer " + ("x" * 300),
    )
    assert "_jd_text" not in draft
    published = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="PostgreSQL backend engineer",
        ats_profile="strict",
    )
    compilation_id = published["id"]
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
    await tools.publish_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"PUBLISH {compilation_id}",
    )
    await tools.record_application_progress(
        application_id=application["application_id"],
        status="submitted",
        evidence_source="user_reported",
        submitted_via="manual",
    )
    await tools.record_application_progress(
        application_id=application["application_id"],
        status="interview",
        evidence_source="recruiter_message",
        interview_date="2026-08-15",
    )

    first_page = await tools.list_resume_compilations(
        graph_id=approved["graph_id"],
        limit=1,
    )
    assert first_page["page"] == {
        "limit": 1,
        "offset": 0,
        "returned": 1,
        "has_more": True,
        "next_offset": 1,
    }
    assert first_page["contains_resume_content"] is False
    assert first_page["contains_download_capabilities"] is False
    assert first_page["jd_preview_is_untrusted_source_text"] is True
    second_page = await tools.list_resume_compilations(
        graph_id=approved["graph_id"],
        limit=1,
        offset=1,
    )
    assert second_page["page"]["has_more"] is False
    assert second_page["page"]["next_offset"] is None
    assert [item["id"] for item in second_page["compilations"]] == [draft["id"]]
    assert len(second_page["compilations"][0]["jd_preview"]) == 240
    assert second_page["compilations"][0]["jd_preview_truncated"] is True

    published_versions = await tools.list_resume_compilations(status="published")
    assert len(published_versions["compilations"]) == 1
    version = published_versions["compilations"][0]
    assert version["id"] == compilation_id
    assert version["graph_revision"] == 1
    assert version["quality_summary"]["ats_ready"] is True
    assert version["tracked_application_count"] == 1
    assert version["public_url"].startswith("http://localhost:3000/r/")
    assert version["publication_active"] is True
    assert version["publication_state"] == "active"
    assert version["next_actions"] == [
        "get_resume_compilation",
        "update_published_resume",
        "revoke_published_resume",
        "create_application_draft",
    ]
    assert "publish_token" not in version
    assert "resume" not in version
    assert "download_code" not in version

    applications = await tools.list_tracked_applications(
        graph_id=approved["graph_id"],
        status="interview",
    )
    assert applications["server_side_submission"] is False
    assert applications["contains_form_answers"] is False
    assert applications["contains_download_capabilities"] is False
    assert len(applications["applications"]) == 1
    tracked = applications["applications"][0]
    assert tracked["application_id"] == application["application_id"]
    assert tracked["compilation_id"] == compilation_id
    assert tracked["job"]["role_title"] == "Backend Engineer"
    assert tracked["history_event_count"] == 3
    assert tracked["latest_history_event"]["event_source"] == ("codex_mcp_recruiter_message")
    assert tracked["latest_history_event"]["to_status"] == "interview"
    assert "form_answers" not in tracked
    assert "resume" not in tracked
    assert "download_code" not in tracked

    other_user = UUID("00000000-0000-4000-8000-000000000777")
    assert await tools.FAKE_STORE.list_compilations(other_user) == []
    assert await tools.FAKE_STORE.list_tracked_applications(other_user) == []
    drafts = await tools.list_resume_compilations(status="draft")
    assert [item["id"] for item in drafts["compilations"]] == [draft["id"]]


async def test_inventory_rejects_invalid_filters_before_store_access() -> None:
    with pytest.raises(CareerGraphStateError, match="compilation status"):
        await tools.list_resume_compilations(status="submitted")
    with pytest.raises(CareerGraphStateError, match="application status"):
        await tools.list_tracked_applications(status="published")
    with pytest.raises(CareerGraphStateError, match="limit"):
        await tools.list_resume_compilations(limit=101)
    with pytest.raises(CareerGraphStateError, match="offset"):
        await tools.list_tracked_applications(offset=-1)
    assert tools.FAKE_STORE.compilations == {}
    assert tools.FAKE_STORE.application_drafts == {}


async def test_publication_update_preserves_url_and_appends_history() -> None:
    approved = await _approved_graph()
    source = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer v1",
    )
    target = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Backend engineer v2",
        ats_profile="strict",
    )
    for compilation in (source, target):
        await tools.approve_resume_compilation(
            compilation_id=compilation["id"],
            confirmation=f"APPROVE RESUME {compilation['id']}",
        )

    published = await tools.publish_resume_compilation(
        compilation_id=source["id"],
        confirmation=f"PUBLISH {source['id']}",
    )
    assert published["publication_active"] is True
    assert published["publication_event"]["event_kind"] == "published"
    stable_url = published["public_url"]

    with pytest.raises(CareerGraphStateError, match="human confirmation"):
        await tools.update_published_resume(
            source_compilation_id=source["id"],
            target_compilation_id=target["id"],
            confirmation="update it",
        )
    assert len(tools.FAKE_STORE.publication_events) == 1
    assert tools.FAKE_STORE.compilations[source["id"]]["publish_token"] is not None
    assert tools.FAKE_STORE.compilations[target["id"]]["publish_token"] is None

    updated = await tools.update_published_resume(
        source_compilation_id=source["id"],
        target_compilation_id=target["id"],
        confirmation=f"UPDATE PUBLIC RESUME {source['id']} TO {target['id']}",
    )
    assert updated["public_url"] == stable_url
    assert updated["link_preserved"] is True
    assert updated["source_artifact_immutable"] is True
    assert updated["source_publication_active"] is False
    assert updated["target_publication_active"] is True
    assert updated["publication_event"]["event_kind"] == "updated"

    versions = await tools.list_resume_compilations(graph_id=approved["graph_id"])
    versions_by_id = {item["id"]: item for item in versions["compilations"]}
    assert versions_by_id[source["id"]]["publication_state"] == "historical"
    assert versions_by_id[source["id"]]["public_url"] is None
    assert versions_by_id[target["id"]]["publication_state"] == "active"
    assert versions_by_id[target["id"]]["public_url"] == stable_url

    history = await tools.get_resume_publication_history(graph_id=approved["graph_id"])
    assert [event["event_kind"] for event in history["events"]] == [
        "updated",
        "published",
    ]
    assert history["active_publications"][0]["compilation_id"] == target["id"]
    assert history["active_publications"][0]["public_url"] == stable_url
    assert history["contains_public_token_digest"] is False
    assert "publish_token" not in history["active_publications"][0]
    assert all("public_token_digest" not in event for event in history["events"])

    with pytest.raises(CareerGraphStateError, match="human confirmation"):
        await tools.revoke_published_resume(
            compilation_id=target["id"],
            confirmation="revoke",
        )
    revoked = await tools.revoke_published_resume(
        compilation_id=target["id"],
        confirmation=f"REVOKE PUBLIC RESUME {target['id']}",
    )
    assert revoked["publication_active"] is False
    assert revoked["public_url"] is None
    assert revoked["artifact_deleted"] is False
    assert revoked["publication_event"]["event_kind"] == "revoked"

    history = await tools.get_resume_publication_history(graph_id=approved["graph_id"])
    assert history["active_publications"] == []
    assert [event["event_kind"] for event in history["events"]] == [
        "revoked",
        "updated",
        "published",
    ]
    assert (await tools.get_resume_compilation(source["id"]))["status"] == "published"
    assert (await tools.get_resume_compilation(target["id"]))["status"] == "published"


async def test_legacy_active_tokens_can_be_discovered_updated_and_revoked() -> None:
    approved = await _approved_graph()
    legacy_source = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Legacy public résumé",
    )
    target = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Replacement public résumé",
    )
    legacy_revoke = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Legacy public résumé to revoke",
    )
    for compilation in (legacy_source, target, legacy_revoke):
        await tools.approve_resume_compilation(
            compilation_id=compilation["id"],
            confirmation=f"APPROVE RESUME {compilation['id']}",
        )

    tools.FAKE_STORE.compilations[legacy_source["id"]]["publish_token"] = "a" * 32
    tools.FAKE_STORE.compilations[legacy_revoke["id"]]["publish_token"] = "b" * 32

    versions = await tools.list_resume_compilations(graph_id=approved["graph_id"])
    versions_by_id = {item["id"]: item for item in versions["compilations"]}
    assert versions_by_id[legacy_source["id"]]["status"] == "approved"
    assert versions_by_id[legacy_source["id"]]["publication_state"] == "active"
    assert versions_by_id[legacy_source["id"]]["next_actions"] == [
        "get_resume_compilation",
        "update_published_resume",
        "revoke_published_resume",
        "create_application_draft",
    ]
    legacy_history = await tools.get_resume_publication_history(graph_id=approved["graph_id"])
    legacy_active = {item["compilation_id"]: item for item in legacy_history["active_publications"]}
    assert legacy_active[legacy_source["id"]]["published_at"] is None
    assert legacy_active[legacy_source["id"]]["public_url"].endswith("/" + ("a" * 32))
    with pytest.raises(CareerGraphStateError, match="already owns an active"):
        await tools.publish_resume_compilation(
            compilation_id=legacy_source["id"],
            confirmation=f"PUBLISH {legacy_source['id']}",
        )

    updated = await tools.update_published_resume(
        source_compilation_id=legacy_source["id"],
        target_compilation_id=target["id"],
        confirmation=(f"UPDATE PUBLIC RESUME {legacy_source['id']} TO {target['id']}"),
    )
    assert updated["link_preserved"] is True
    assert updated["public_url"].endswith("/" + ("a" * 32))

    revoked = await tools.revoke_published_resume(
        compilation_id=legacy_revoke["id"],
        confirmation=f"REVOKE PUBLIC RESUME {legacy_revoke['id']}",
    )
    assert revoked["status"] == "approved"
    assert revoked["publication_active"] is False


async def test_publication_update_rejects_invalid_version_relationships() -> None:
    first_graph = await _approved_graph()
    source = await tools.compile_resume_for_jd(
        graph_id=first_graph["graph_id"],
        jd_text="Backend engineer",
    )
    await tools.approve_resume_compilation(
        compilation_id=source["id"],
        confirmation=f"APPROVE RESUME {source['id']}",
    )
    await tools.publish_resume_compilation(
        compilation_id=source["id"],
        confirmation=f"PUBLISH {source['id']}",
    )

    second_proposal = await tools.propose_career_graph_changes(
        operations=_operations(),
        summary="Second graph",
        graph_label="Second Career Graph",
    )
    second_graph = await tools.approve_career_graph_change(
        change_set_id=second_proposal["id"],
        confirmation=f"APPROVE CAREER CHANGE {second_proposal['id']}",
    )
    other_graph_target = await tools.compile_resume_for_jd(
        graph_id=second_graph["graph_id"],
        jd_text="Backend engineer v2",
    )
    await tools.approve_resume_compilation(
        compilation_id=other_graph_target["id"],
        confirmation=f"APPROVE RESUME {other_graph_target['id']}",
    )

    with pytest.raises(CareerGraphStateError, match="same Career Graph"):
        await tools.update_published_resume(
            source_compilation_id=source["id"],
            target_compilation_id=other_graph_target["id"],
            confirmation=(f"UPDATE PUBLIC RESUME {source['id']} TO {other_graph_target['id']}"),
        )
    assert len(tools.FAKE_STORE.publication_events) == 1


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
    upload_preflight = delivery["upload_preflight"]
    assert upload_preflight["preferred_surface"] == "chrome_extension"
    assert upload_preflight["built_in_browser_file_upload_supported"] is False
    assert upload_preflight["required_extension_permission"] == "Allow access to file URLs"
    assert upload_preflight["permission_state_detectable_by_relay"] is False
    assert upload_preflight["failure_action"].startswith("stop_batch")

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


async def test_one_sentence_workflow_persists_job_and_resumes_across_review_gates() -> None:
    approved = await _approved_graph()
    job_url = "https://jobs.lever.co/example/backend-123"
    started = await tools.start_application_workflow(
        graph_id=approved["graph_id"],
        jd_text="Senior backend engineer with PostgreSQL experience",
        company="Example",
        role_title="Senior Backend Engineer",
        job_url=job_url,
        length_budget="one_page",
        ats_profile="strict",
    )
    workflow_id = started["workflow_id"]
    assert started["stage"] == "resume_review"
    assert started["resumable"] is True
    assert started["job_identity"]["job_url"] == job_url
    assert started["approval_gates_remaining"] == [
        "resume",
        "questionnaire",
        "final_submission",
    ]

    waiting = await tools.resume_application_workflow(workflow_id=workflow_id)
    assert waiting["stage"] == "resume_review"
    assert tools.FAKE_STORE.application_drafts == {}

    await tools.approve_resume_compilation(
        compilation_id=workflow_id,
        confirmation=f"APPROVE RESUME {workflow_id}",
    )
    browser = await tools.resume_application_workflow(workflow_id=workflow_id)
    assert browser["stage"] == "browser_inspection"
    assert browser["questionnaire_status"] == "missing"
    application_id = browser["application_id"]

    await _approve_questionnaire(
        compilation_id=workflow_id,
        application_id=application_id,
        job_url=job_url,
        company="Example",
        role_title="Senior Backend Engineer",
    )
    ready = await tools.resume_application_workflow(workflow_id=workflow_id)
    assert ready["stage"] == "ready_for_browser_fill"
    assert ready["application_id"] == application_id
    assert ready["next_action"]["tool"] == "prepare_application_handoff"


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
    assert "upload_preflight" not in delivery
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
        job_url="https://jobs.lever.co/example/engineer",
    )
    application_id = application["application_id"]
    await _approve_questionnaire(
        compilation_id=compilation_id,
        application_id=application_id,
        job_url="https://jobs.lever.co/example/engineer",
        company="Example",
        role_title="Engineer",
    )

    authorization = await tools.authorize_application_submission(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/engineer",
        observed_url="https://jobs.lever.co/example/engineer/apply",
        observed_company="Example",
        observed_role_title="Engineer",
        visible_text="Submit application",
        confirmation=f"SUBMIT APPLICATION {application_id}",
        observed_field_ids=["resume_cv"],
        completed_field_ids=["resume_cv"],
    )
    submitted = await tools.record_application_progress(
        application_id=application_id,
        status="submitted",
        evidence_source="browser_confirmation",
        submitted_via="client_extension",
        submission_authorization_id=authorization["submission_authorization_id"],
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
    with pytest.raises(CareerGraphStateError, match="authorization receipt"):
        await tools.record_application_progress(
            application_id="00000000-0000-4000-8000-000000000123",
            status="submitted",
            evidence_source="browser_confirmation",
            submitted_via="client_extension",
        )
    assert tools.FAKE_STORE.application_drafts == {}


async def test_questionnaire_is_application_bound_evidence_backed_and_review_gated() -> None:
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
        company="Example, Inc.",
        role_title="Senior Backend Engineer",
        job_url="https://jobs.lever.co/example/backend-123",
    )
    application_id = application["application_id"]
    questions = [
        {
            "id": "first_name",
            "label": "First name",
            "field_type": "text",
            "required": True,
            "selector": "#first_name",
            "answer": "Alex",
            "action": "fill",
            "confidence": 1,
            "sensitive": False,
            "evidence": [
                {
                    "source_type": "approved_resume",
                    "source_ref": "resume.basics.name",
                }
            ],
        },
        {
            "id": "salary",
            "label": "Expected salary",
            "field_type": "text",
            "required": False,
            "answer": None,
            "action": "manual",
            "confidence": 0,
            "sensitive": True,
            "evidence": [],
        },
    ]
    proposed = await tools.propose_application_questionnaire(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/backend-123",
        observed_url="https://jobs.lever.co/example/backend-123/apply",
        observed_company="Example",
        observed_role_title="Backend Engineer, Sr.",
        questions=questions,
        visible_text="Application form",
    )
    assert proposed["application_id"] == application_id
    assert proposed["status"] == "draft"
    assert proposed["revision"] == 1
    assert proposed["summary"]["fillable_count"] == 1
    assert proposed["summary"]["manual_count"] == 1
    assert proposed["summary"]["all_fill_answers_have_evidence"] is True
    assert "First name" in proposed["review_markdown"]
    assert proposed["browser_fill_performed"] is False

    with pytest.raises(CareerGraphStateError, match="draft questionnaire already exists"):
        await tools.propose_application_questionnaire(
            compilation_id=compilation_id,
            job_url="https://jobs.lever.co/example/backend-123",
            observed_url="https://jobs.lever.co/example/backend-123/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            questions=[
                {
                    "id": "resume_cv",
                    "label": "Resume/CV",
                    "field_type": "file",
                    "action": "manual",
                }
            ],
        )

    with pytest.raises(CareerGraphStateError, match="type exactly"):
        await tools.approve_application_questionnaire(
            compilation_id=compilation_id,
            job_url="https://jobs.lever.co/example/backend-123",
            confirmation="yes",
        )

    approved_questionnaire = await tools.approve_application_questionnaire(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/backend-123",
        confirmation=f"APPROVE QUESTIONNAIRE {application_id}",
    )
    assert approved_questionnaire["status"] == "approved"
    handoff = await tools.prepare_application_handoff(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/backend-123",
    )
    assert handoff["questionnaire"]["status"] == "approved"
    assert handoff["questionnaire"]["fields"][0]["answer"] == "Alex"
    assert handoff["questionnaire"]["required_before_submit"] is True

    with pytest.raises(CareerGraphStateError, match="current user response"):
        await tools.propose_application_questionnaire(
            compilation_id=compilation_id,
            job_url="https://jobs.lever.co/example/backend-123",
            observed_url="https://jobs.lever.co/example/backend-123/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            questions=[
                {
                    "id": "sponsorship",
                    "label": "Will you require sponsorship?",
                    "answer": "No",
                    "action": "fill",
                    "confidence": 1,
                    "sensitive": False,
                    "evidence": [
                        {
                            "source_type": "approved_resume",
                            "source_ref": "resume.basics",
                        }
                    ],
                }
            ],
        )


async def test_questionnaire_rejects_unreviewed_answers_and_fake_evidence() -> None:
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
        role_title="Backend Engineer",
        job_url="https://jobs.lever.co/example/backend-123",
    )
    common = {
        "compilation_id": compilation_id,
        "job_url": "https://jobs.lever.co/example/backend-123",
        "observed_url": "https://jobs.lever.co/example/backend-123/apply",
        "observed_company": "Example",
        "observed_role_title": "Backend Engineer",
    }
    programming_languages = await tools.propose_application_questionnaire(
        **common,
        questions=[
            {
                "id": "programming_languages",
                "label": "What programming languages are you proficient in?",
                "answer": "Python",
                "action": "fill",
                "confidence": 1,
                "sensitive": False,
                "evidence": [
                    {
                        "source_type": "user_response",
                        "source_ref": "current_turn:test_fixture",
                    }
                ],
            }
        ],
    )
    assert programming_languages["fields"][0]["sensitive"] is False
    await tools.reject_application_questionnaire(
        compilation_id=compilation_id,
        job_url=common["job_url"],
        confirmation=(f"REJECT QUESTIONNAIRE {programming_languages['application_id']}"),
    )
    with pytest.raises(CareerGraphStateError, match="must be empty"):
        await tools.propose_application_questionnaire(
            **common,
            questions=[
                {
                    "id": "salary",
                    "label": "Expected salary",
                    "answer": "$200k",
                    "action": "manual",
                }
            ],
        )
    with pytest.raises(CareerGraphStateError, match="source_type is unsupported"):
        await tools.propose_application_questionnaire(
            **common,
            questions=[
                {
                    "id": "portfolio",
                    "label": "Portfolio",
                    "answer": "https://example.test",
                    "action": "fill",
                    "confidence": 1,
                    "evidence": [
                        {
                            "source_type": "manual",
                            "source_ref": "trust me",
                        }
                    ],
                }
            ],
        )
    with pytest.raises(CareerGraphStateError, match="approved résumé"):
        await tools.propose_application_questionnaire(
            **common,
            questions=[
                {
                    "id": "portfolio",
                    "label": "Portfolio",
                    "answer": "https://example.test",
                    "action": "fill",
                    "confidence": 1,
                    "evidence": [
                        {
                            "source_type": "approved_resume",
                            "source_ref": "resume.nonexistent.url",
                        }
                    ],
                }
            ],
        )
    with pytest.raises(CareerGraphStateError, match="does not resolve"):
        await tools.propose_application_questionnaire(
            **common,
            questions=[
                {
                    "id": "portfolio",
                    "label": "Portfolio",
                    "answer": "https://example.test",
                    "action": "fill",
                    "confidence": 1,
                    "evidence": [
                        {
                            "source_type": "career_graph",
                            "source_ref": "person:alex.data.nonexistent",
                        }
                    ],
                }
            ],
        )


async def test_questionnaire_creation_stops_on_same_url_semantic_drift() -> None:
    approved = await _approved_graph()
    compilation = await tools.compile_resume_for_jd(
        graph_id=approved["graph_id"],
        jd_text="Senior Software Engineer",
    )
    compilation_id = compilation["id"]
    await tools.approve_resume_compilation(
        compilation_id=compilation_id,
        confirmation=f"APPROVE RESUME {compilation_id}",
    )
    job_url = "https://job-boards.greenhouse.io/glossgenius/jobs/6681936003"
    await tools.create_application_draft(
        compilation_id=compilation_id,
        company="GlossGenius",
        role_title="Senior Software Engineer",
        job_url=job_url,
    )
    with pytest.raises(CareerGraphStateError, match="identity"):
        await tools.propose_application_questionnaire(
            compilation_id=compilation_id,
            job_url=job_url,
            observed_url=job_url,
            observed_company="Genius AI",
            observed_role_title="Software Engineer - All Levels",
            questions=[],
            visible_text="Job Application for Software Engineer - All Levels at Genius AI",
        )


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
        observed_company="Example",
        observed_role_title="Engineer",
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

    with pytest.raises(CareerGraphStateError, match="questionnaire"):
        await tools.authorize_application_submission(
            compilation_id=compilation_id,
            job_url="https://jobs.lever.co/example/abc",
            observed_url="https://jobs.lever.co/example/abc/apply",
            observed_company="Example",
            observed_role_title="Engineer",
            visible_text="Submit application",
            confirmation=f"SUBMIT APPLICATION {application['application_id']}",
            observed_field_ids=[],
            completed_field_ids=[],
        )

    await _approve_questionnaire(
        compilation_id=compilation_id,
        application_id=application["application_id"],
        job_url="https://jobs.lever.co/example/abc",
        company="Example",
        role_title="Engineer",
    )

    with pytest.raises(CareerGraphStateError, match="type exactly"):
        await tools.authorize_application_submission(
            compilation_id=compilation_id,
            job_url="https://jobs.lever.co/example/abc",
            observed_url="https://jobs.lever.co/example/abc/apply",
            observed_company="Example",
            observed_role_title="Engineer",
            visible_text="Submit application",
            confirmation="yes",
            observed_field_ids=["resume_cv"],
            completed_field_ids=["resume_cv"],
        )

    phrase = f"SUBMIT APPLICATION {application['application_id']}"
    with pytest.raises(CareerGraphStateError, match="browser fields changed"):
        await tools.authorize_application_submission(
            compilation_id=compilation_id,
            job_url="https://jobs.lever.co/example/abc",
            observed_url="https://jobs.lever.co/example/abc/apply",
            observed_company="Example",
            observed_role_title="Engineer",
            visible_text="Submit application",
            confirmation=phrase,
            observed_field_ids=["unexpected_new_field"],
            completed_field_ids=["resume_cv"],
        )
    first_authorization = await tools.authorize_application_submission(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        observed_company="Example",
        observed_role_title="Engineer",
        visible_text="Submit application",
        confirmation=phrase,
        observed_field_ids=["resume_cv"],
        completed_field_ids=["resume_cv"],
    )
    authorization = await tools.authorize_application_submission(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        observed_company="Example",
        observed_role_title="Engineer",
        visible_text="Submit application",
        confirmation=phrase,
        observed_field_ids=["resume_cv"],
        completed_field_ids=["resume_cv"],
    )
    assert authorization["authorization_scope"] == "one_application_one_final_click"
    assert authorization["one_final_click_authorized"] is True
    assert authorization["server_side_submission"] is False
    assert (
        tools.FAKE_STORE.submission_authorizations[
            first_authorization["submission_authorization_id"]
        ]["invalidated_at"]
        is not None
    )
    keyed_authorization = await tools.authorize_application_submission(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        observed_company="Example",
        observed_role_title="Engineer",
        visible_text="Submit application",
        confirmation=phrase,
        observed_field_ids=["resume_cv"],
        completed_field_ids=["resume_cv"],
        idempotency_key="authorize-browser-click-001",
    )
    authorization_count = len(tools.FAKE_STORE.submission_authorizations)
    replayed_authorization = await tools.authorize_application_submission(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        observed_company="Example",
        observed_role_title="Engineer",
        visible_text="Submit application",
        confirmation=phrase,
        observed_field_ids=["resume_cv"],
        completed_field_ids=["resume_cv"],
        idempotency_key="authorize-browser-click-001",
    )
    assert (
        replayed_authorization["submission_authorization_id"]
        == (keyed_authorization["submission_authorization_id"])
    )
    assert (
        replayed_authorization["operation"]["operation_id"]
        == (keyed_authorization["operation"]["operation_id"])
    )
    assert len(tools.FAKE_STORE.submission_authorizations) == authorization_count
    revised = await tools.propose_application_questionnaire(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        observed_company="Example",
        observed_role_title="Engineer",
        questions=[
            {
                "id": "portfolio",
                "label": "Portfolio",
                "required": True,
                "answer": None,
                "action": "manual",
            }
        ],
    )
    assert (
        tools.FAKE_STORE.submission_authorizations[authorization["submission_authorization_id"]][
            "invalidated_at"
        ]
        is not None
    )
    await tools.approve_application_questionnaire(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        confirmation=f"APPROVE QUESTIONNAIRE {application['application_id']}",
    )
    authorization = await tools.authorize_application_submission(
        compilation_id=compilation_id,
        job_url="https://jobs.lever.co/example/abc",
        observed_url="https://jobs.lever.co/example/abc/apply",
        observed_company="Example",
        observed_role_title="Engineer",
        visible_text="Submit application",
        confirmation=phrase,
        observed_field_ids=["portfolio"],
        completed_field_ids=["portfolio"],
    )
    assert revised["revision"] == 2
    assert authorization["questionnaire_revision"] == 2

    with pytest.raises(CareerGraphStateError, match="authorization receipt"):
        await tools.record_application_progress(
            application_id=application["application_id"],
            status="submitted",
            evidence_source="browser_confirmation",
            submitted_via="client_extension",
        )
    with pytest.raises(CareerGraphStateError, match="unavailable or expired"):
        await tools.record_application_progress(
            application_id=application["application_id"],
            status="submitted",
            evidence_source="browser_confirmation",
            submitted_via="client_extension",
            submission_authorization_id=("00000000-0000-4000-8000-000000000123"),
        )

    submitted = await tools.record_application_progress(
        application_id=application["application_id"],
        status="submitted",
        evidence_source="browser_confirmation",
        submitted_via="client_extension",
        submission_authorization_id=authorization["submission_authorization_id"],
    )
    assert submitted["submission_authorization"]["consumed"] is True
    assert submitted["changed"] is True

    repeated = await tools.record_application_progress(
        application_id=application["application_id"],
        status="submitted",
        evidence_source="browser_confirmation",
        submitted_via="client_extension",
        submission_authorization_id=authorization["submission_authorization_id"],
    )
    assert repeated["submission_authorization"]["consumed"] is True
    assert repeated["changed"] is False
    with pytest.raises(CareerGraphStateError, match="unavailable or expired"):
        await tools.record_application_progress(
            application_id=application["application_id"],
            status="submitted",
            evidence_source="browser_confirmation",
            submitted_via="client_extension",
            submission_authorization_id=("00000000-0000-4000-8000-000000000124"),
        )


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
