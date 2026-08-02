"""Live PostgreSQL contract for the Codex-native application workflow."""

from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from dotenv import load_dotenv

from agents.mcp_relay import tools

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


@pytest.mark.integration
async def test_live_pg_workflow_questionnaire_and_browser_gate_score_100(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        pytest.skip("RELAY_PG_DSN is required for the live PostgreSQL scorecard")
    # Docker Desktop/OrbStack may publish localhost on both address families
    # while PostgreSQL is ready on IPv4 first. Pin the integration probe to
    # loopback IPv4 so a transient IPv6 half-open cannot hang the scorecard.
    dsn = dsn.replace("@localhost:", "@127.0.0.1:")
    monkeypatch.setenv("RELAY_PG_DSN", dsn)

    user_id = uuid4()
    resume_id = uuid4()
    email = f"chain10-{user_id}@example.test"
    resume = {
        "basics": {
            "name": "Chain Ten",
            "email": email,
            "phone": "+1-555-0100",
        },
        "work": [
            {
                "name": "Acme",
                "position": "Backend Engineer",
                "startDate": "2022-01",
                "endDate": "Present",
                "highlights": ["Migrated billing workloads to PostgreSQL."],
            }
        ],
        "skills": [{"name": "Backend", "keywords": ["Python", "PostgreSQL"]}],
    }
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO users (id, email, display_name) VALUES (%s, %s, %s)",
                (str(user_id), email, "Chain Ten"),
            )
            await cur.execute(
                """
                INSERT INTO resumes (id, user_id, version, content, is_base, label)
                VALUES (%s, %s, 1, %s::jsonb, true, 'Chain 10 source')
                """,
                (str(resume_id), str(user_id), json.dumps(resume)),
            )
        await conn.commit()

    monkeypatch.delenv("RELAY_MCP_FAKE", raising=False)
    monkeypatch.setenv("RELAY_USER_ID", str(user_id))
    monkeypatch.setenv("RELAY_API_BASE_URL", "http://localhost:3001")
    job_url = "https://jobs.lever.co/example/backend-123"
    try:
        imported = await tools.propose_resume_import(resume_id=str(resume_id))
        await tools.approve_career_graph_change(
            change_set_id=imported["id"],
            confirmation=imported["confirmation"]["approve"],
        )
        started = await tools.start_application_workflow(
            graph_id=imported["graph_id"],
            jd_text="Senior Backend Engineer. Python and PostgreSQL required.",
            company="Example",
            role_title="Senior Backend Engineer",
            job_url=job_url,
            length_budget="one_page",
            ats_profile="strict",
        )
        workflow_id = started["workflow_id"]
        waiting = await tools.resume_application_workflow(workflow_id=workflow_id)
        await tools.approve_resume_compilation(
            compilation_id=workflow_id,
            confirmation=f"APPROVE RESUME {workflow_id}",
        )
        browser = await tools.resume_application_workflow(workflow_id=workflow_id)
        application_id = browser["application_id"]
        proposed = await tools.propose_application_questionnaire(
            compilation_id=workflow_id,
            job_url=job_url,
            observed_url=f"{job_url}/apply",
            observed_company="Example, Inc.",
            observed_role_title="Backend Engineer, Sr.",
            questions=[
                {
                    "id": "email",
                    "label": "Email",
                    "answer": email,
                    "action": "fill",
                    "confidence": 1,
                    "sensitive": False,
                    "evidence": [
                        {
                            "source_type": "approved_resume",
                            "source_ref": "resume.basics.email",
                        }
                    ],
                }
            ],
        )
        await tools.approve_application_questionnaire(
            compilation_id=workflow_id,
            job_url=job_url,
            confirmation=f"APPROVE QUESTIONNAIRE {application_id}",
        )
        ready = await tools.resume_application_workflow(workflow_id=workflow_id)
        checkpoint = await tools.assess_application_browser_checkpoint(
            compilation_id=workflow_id,
            job_url=job_url,
            observed_url=f"{job_url}/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            stage="before_submit",
        )
        receipt = await tools.authorize_application_submission(
            compilation_id=workflow_id,
            job_url=job_url,
            observed_url=f"{job_url}/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            confirmation=f"SUBMIT APPLICATION {application_id}",
            observed_field_ids=["email"],
            completed_field_ids=["email"],
        )
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT application.form_answers,
                           count(questionnaire.id),
                           max(questionnaire.status)
                      FROM application_drafts application
                      LEFT JOIN application_questionnaires questionnaire
                        ON questionnaire.application_id = application.id
                       AND questionnaire.user_id = application.user_id
                     WHERE application.id = %s
                     GROUP BY application.form_answers
                    """,
                    (application_id,),
                )
                persistence = await cur.fetchone()
        assert persistence is not None
        revised = await tools.propose_application_questionnaire(
            compilation_id=workflow_id,
            job_url=job_url,
            observed_url=f"{job_url}/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            questions=[
                {
                    "id": "email",
                    "label": "Email",
                    "answer": email,
                    "action": "fill",
                    "confidence": 1,
                    "evidence": [
                        {
                            "source_type": "approved_resume",
                            "source_ref": "resume.basics.email",
                        }
                    ],
                }
            ],
        )
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT invalidated_at IS NOT NULL
                      FROM application_submission_authorizations
                     WHERE id = %s
                    """,
                    (receipt["submission_authorization_id"],),
                )
                invalidated = await cur.fetchone()
        await tools.approve_application_questionnaire(
            compilation_id=workflow_id,
            job_url=job_url,
            confirmation=f"APPROVE QUESTIONNAIRE {application_id}",
        )
        replacement_receipt = await tools.authorize_application_submission(
            compilation_id=workflow_id,
            job_url=job_url,
            observed_url=f"{job_url}/apply",
            observed_company="Example",
            observed_role_title="Senior Backend Engineer",
            confirmation=f"SUBMIT APPLICATION {application_id}",
            observed_field_ids=["email"],
            completed_field_ids=["email"],
        )
        checks = {
            "durable_start": started["stage"] == "resume_review",
            "resume_gate": waiting["stage"] == "resume_review",
            "source_only": started["resume_compilation"]["guard_report"]["source_only"],
            "application_resume": browser["stage"] == "browser_inspection",
            "questionnaire_evidence": proposed["summary"][
                "all_fill_answers_have_evidence"
            ]
            and proposed["summary"]["all_evidence_references_verified"],
            "questionnaire_resume": ready["stage"] == "ready_for_browser_fill",
            "semantic_checkpoint": checkpoint["job_identity"]["verified"],
            "one_click_receipt": receipt["one_final_click_authorized"],
            "questionnaire_revision_invalidates_receipt": (
                revised["revision"] == 2
                and invalidated == (True,)
                and replacement_receipt["questionnaire_revision"] == 2
            ),
            "never_server_submit": receipt["server_side_submission"] is False,
            "legacy_answers_untouched": persistence[0] == {},
            "versioned_questionnaire_row": persistence[1:] == (1, "approved"),
        }
        score = round(sum(checks.values()) / len(checks) * 100)
        assert score >= 99, checks
        assert all(checks.values()), checks
    finally:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute("DELETE FROM users WHERE id = %s", (str(user_id),))
            await conn.commit()
