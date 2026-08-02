"""Codex-native paid application journeys, each gated at >=99/100.

These scorecards exercise the durable MCP domain surface that Codex uses:

1. one-sentence workflow start/resume;
2. application-bound questionnaire creation/render/review;
3. semantic browser safety and one-click submission authorization.

Browser DOM interaction remains client-side. The scorecard proves Relay's
state, evidence, and authorization contracts; live Playwright verification is
run separately because public ATS pages are not deterministic CI fixtures.
"""

from __future__ import annotations

from typing import Any

import pytest

from agents.career_graph.store import CareerGraphStateError
from agents.mcp_relay import tools


@pytest.fixture(autouse=True)
def _fake_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_MCP_FAKE", "1")
    tools.FAKE_STORE.reset()


def _operations() -> list[dict[str, Any]]:
    provenance = {"source_type": "user_asserted", "source_ref": "scorecard fixture"}
    return [
        {
            "op": "upsert_node",
            "node": {
                "id": "person:alex",
                "type": "person",
                "data": {"name": "Alex Doe", "email": "alex@example.test"},
                "provenance": provenance,
            },
        },
        {
            "op": "upsert_node",
            "node": {
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
        },
        {
            "op": "upsert_node",
            "node": {
                "id": "achievement:postgres",
                "type": "achievement",
                "data": {"text": "Migrated billing workloads to PostgreSQL."},
                "provenance": provenance,
            },
        },
        {
            "op": "upsert_edge",
            "edge": {
                "id": "edge:person-role",
                "from": "person:alex",
                "to": "role:acme",
                "type": "held_role",
            },
        },
        {
            "op": "upsert_edge",
            "edge": {
                "id": "edge:role-achievement",
                "from": "role:acme",
                "to": "achievement:postgres",
                "type": "includes",
            },
        },
    ]


async def _graph_id() -> str:
    proposal = await tools.propose_career_graph_changes(
        operations=_operations(),
        summary="Evidence-backed scorecard profile",
    )
    approved = await tools.approve_career_graph_change(
        change_set_id=proposal["id"],
        confirmation=proposal["confirmation"]["approve"],
    )
    return approved["graph_id"]


async def _started_workflow() -> dict[str, Any]:
    return await tools.start_application_workflow(
        graph_id=await _graph_id(),
        jd_text="Senior Backend Engineer. PostgreSQL and Python required.",
        company="Example, Inc.",
        role_title="Senior Backend Engineer",
        job_url="https://jobs.lever.co/example/backend-123",
        artifact_locale="en",
        length_budget="one_page",
        ats_profile="strict",
    )


def _print_score(name: str, dimensions: dict[str, tuple[int, bool]]) -> int:
    total = sum(points if passed else 0 for points, passed in dimensions.values())
    print(f"\n[chain10] {name}: {total}/100")
    for dimension, (points, passed) in dimensions.items():
        print(f"  {'PASS' if passed else 'FAIL'} {dimension}: {points}")
    return total


async def test_paid_scene_one_sentence_start_and_resume_scores_100() -> None:
    started = await _started_workflow()
    workflow_id = started["workflow_id"]
    waiting = await tools.resume_application_workflow(workflow_id=workflow_id)
    no_application_before_approval = not tools.FAKE_STORE.application_drafts
    await tools.approve_resume_compilation(
        compilation_id=workflow_id,
        confirmation=f"APPROVE RESUME {workflow_id}",
    )
    resumed = await tools.resume_application_workflow(workflow_id=workflow_id)

    dimensions = {
        "single_high_level_entry": (15, started["stage"] == "resume_review"),
        "durable_workflow_id": (15, waiting["workflow_id"] == workflow_id),
        "job_identity_persisted": (
            15,
            waiting["job_identity"]["job_url"]
            == "https://jobs.lever.co/example/backend-123",
        ),
        "source_only_resume": (
            15,
            started["resume_compilation"]["guard_report"]["source_only"] is True,
        ),
        "resume_approval_gate": (15, no_application_before_approval),
        "resume_after_review": (15, resumed["stage"] == "browser_inspection"),
        "never_server_submit": (10, resumed["server_side_submission"] is False),
    }
    assert _print_score("one-sentence durable workflow", dimensions) >= 99
    assert all(passed for _, passed in dimensions.values())


async def test_paid_scene_questionnaire_review_artifact_scores_100() -> None:
    started = await _started_workflow()
    workflow_id = started["workflow_id"]
    await tools.approve_resume_compilation(
        compilation_id=workflow_id,
        confirmation=f"APPROVE RESUME {workflow_id}",
    )
    resumed = await tools.resume_application_workflow(workflow_id=workflow_id)
    application_id = resumed["application_id"]
    proposed = await tools.propose_application_questionnaire(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        observed_url="https://jobs.lever.co/example/backend-123/apply",
        observed_company="Example",
        observed_role_title="Backend Engineer, Sr.",
        questions=[
            {
                "id": "name",
                "label": "Full name",
                "field_type": "text",
                "answer": "Alex Doe",
                "action": "fill",
                "confidence": 1,
                "sensitive": False,
                "evidence": [
                    {
                        "source_type": "career_graph",
                        "source_ref": "person:alex.data.name",
                    }
                ],
            },
            {
                "id": "salary",
                "label": "Expected salary",
                "field_type": "text",
                "answer": None,
                "action": "manual",
                "confidence": 0,
                "sensitive": True,
                "evidence": [],
            },
        ],
    )
    exact_gate_rejected = False
    try:
        await tools.approve_application_questionnaire(
            compilation_id=workflow_id,
            job_url="https://jobs.lever.co/example/backend-123",
            confirmation="yes",
        )
    except CareerGraphStateError:
        exact_gate_rejected = True
    approved = await tools.approve_application_questionnaire(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        confirmation=f"APPROVE QUESTIONNAIRE {application_id}",
    )
    handoff = await tools.prepare_application_handoff(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
    )

    dimensions = {
        "application_binding": (15, proposed["application_id"] == application_id),
        "semantic_job_binding": (15, proposed["job_identity"]["verified"] is True),
        "answer_provenance": (
            15,
            proposed["summary"]["all_fill_answers_have_evidence"] is True
            and proposed["summary"]["all_evidence_references_verified"] is True,
        ),
        "sensitive_manual_stop": (15, proposed["summary"]["sensitive_count"] == 1),
        "rendered_review": (15, "| Full name | fill | Alex Doe |" in proposed["review_markdown"]),
        "exact_review_gate": (15, exact_gate_rejected and approved["status"] == "approved"),
        "approved_handoff_only": (
            10,
            handoff["questionnaire"]["status"] == "approved"
            and handoff["questionnaire"]["fields"][0]["answer"] == "Alex Doe",
        ),
    }
    assert _print_score("questionnaire artifact", dimensions) >= 99
    assert all(passed for _, passed in dimensions.values())


async def test_paid_scene_browser_safety_and_submission_receipt_scores_100() -> None:
    started = await _started_workflow()
    workflow_id = started["workflow_id"]
    await tools.approve_resume_compilation(
        compilation_id=workflow_id,
        confirmation=f"APPROVE RESUME {workflow_id}",
    )
    resumed = await tools.resume_application_workflow(workflow_id=workflow_id)
    application_id = resumed["application_id"]

    missing_identity = await tools.assess_application_browser_checkpoint(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        observed_url="https://jobs.lever.co/example/backend-123/apply",
    )
    drift = await tools.assess_application_browser_checkpoint(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        observed_url="https://jobs.lever.co/example/backend-123/apply",
        observed_company="Attacker Corp",
        observed_role_title="Senior Backend Engineer",
    )
    correct = await tools.assess_application_browser_checkpoint(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        observed_url="https://jobs.lever.co/example/backend-123/apply",
        observed_company="Example",
        observed_role_title="Backend Engineer, Sr.",
        stage="before_submit",
    )
    questionnaire_required = False
    try:
        await tools.authorize_application_submission(
            compilation_id=workflow_id,
            job_url="https://jobs.lever.co/example/backend-123",
            observed_url="https://jobs.lever.co/example/backend-123/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            confirmation=f"SUBMIT APPLICATION {application_id}",
            observed_field_ids=[],
            completed_field_ids=[],
        )
    except CareerGraphStateError as exc:
        questionnaire_required = "questionnaire" in str(exc)

    await tools.propose_application_questionnaire(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        observed_url="https://jobs.lever.co/example/backend-123/apply",
        observed_company="Example",
        observed_role_title="Senior Backend Engineer",
        questions=[
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
        ],
    )
    await tools.approve_application_questionnaire(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        confirmation=f"APPROVE QUESTIONNAIRE {application_id}",
    )
    completion_gate_rejected = False
    try:
        await tools.authorize_application_submission(
            compilation_id=workflow_id,
            job_url="https://jobs.lever.co/example/backend-123",
            observed_url="https://jobs.lever.co/example/backend-123/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            confirmation=f"SUBMIT APPLICATION {application_id}",
            observed_field_ids=["resume_cv"],
            completed_field_ids=[],
        )
    except CareerGraphStateError as exc:
        completion_gate_rejected = "incomplete" in str(exc)
    field_drift_rejected = False
    try:
        await tools.authorize_application_submission(
            compilation_id=workflow_id,
            job_url="https://jobs.lever.co/example/backend-123",
            observed_url="https://jobs.lever.co/example/backend-123/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            confirmation=f"SUBMIT APPLICATION {application_id}",
            observed_field_ids=["unexpected_new_field"],
            completed_field_ids=["resume_cv"],
        )
    except CareerGraphStateError as exc:
        field_drift_rejected = "browser fields changed" in str(exc)
    receipt = await tools.authorize_application_submission(
        compilation_id=workflow_id,
        job_url="https://jobs.lever.co/example/backend-123",
        observed_url="https://jobs.lever.co/example/backend-123/apply",
        observed_company="Example",
        observed_role_title="Senior Backend Engineer",
        confirmation=f"SUBMIT APPLICATION {application_id}",
        observed_field_ids=["resume_cv"],
        completed_field_ids=["resume_cv"],
    )

    dimensions = {
        "missing_identity_stops": (15, missing_identity["status"] == "stop"),
        "semantic_drift_stops": (15, drift["status"] == "stop"),
        "correct_identity_reviews": (10, correct["status"] == "review_required"),
        "questionnaire_gate": (15, questionnaire_required),
        "completion_and_field_drift_stop": (
            15,
            completion_gate_rejected and field_drift_rejected,
        ),
        "application_exact_phrase": (
            10,
            receipt["application_id"] == application_id,
        ),
        "one_click_short_lived_receipt": (
            10,
            receipt["one_final_click_authorized"] is True
            and receipt["authorization_scope"] == "one_application_one_final_click",
        ),
        "never_server_submit": (10, receipt["server_side_submission"] is False),
    }
    assert _print_score("browser safety and authorization", dimensions) >= 99
    assert all(passed for _, passed in dimensions.values())
