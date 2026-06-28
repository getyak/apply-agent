"""End-to-end (hermetic) tests for the prepare_application workflow.

Covers the saga contract from docs/architecture/delivery-loop-plan.md § 2.3:
- happy path: all 4 stages produce ok results, status=review on exit
- parse_jd fails → short-circuit to finalize, status=draft, last_error set
- customize_resume returns ok=False → fallback to base, chain continues
- cover_letter LLM fail → template fallback, chain continues
- form_answers with sensitive field → that field is forced skip
- TTAR stage_status & timings end up in the TTARRecord (verified via monkeypatch
  on the _persist sink)

Everything is stubbed:
- jobmatch_agent.parse_jd_from_url → returns canned ParsedJD
- resume_agent.customize           → returns canned ok/ok=False
- appprep.generate_cover_letter    → returns canned CoverLetter
- appprep.generate_form_answers    → returns canned FormFieldAnswer list (or real, sensitive-skip case)
- TTAR persist sink (_persist)     → captured into a list, no DB needed
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest

from agents.coordinator import workflows
from agents.harness import ttar as ttar_mod
from agents.nodes import appprep_agent as appprep
from agents.nodes import jobmatch_agent as jm
from agents.nodes import resume_agent as ra

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "jd"


@pytest.fixture(autouse=True)
def _hermetic_env(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)
    monkeypatch.setenv("RELAY_JD_FIXTURE_DIR", str(FIXTURE_DIR))


@pytest.fixture
def ttar_sink(monkeypatch):
    """Capture every TTAR record that would have been UPDATE-d into PG."""
    captured: list[dict] = []

    async def stub_persist(record):
        captured.append(record.to_jsonb())

    monkeypatch.setattr(ttar_mod, "_persist", stub_persist)
    return captured


# ─── canned stubs for the 4 stages ─────────────────────────────────────


def _stub_parsed_jd(*, source="greenhouse", external_id="4071234"):
    return jm.ParsedJD(
        job_id=uuid4(),
        source=source,
        external_id=external_id,
        company="Synthetic Labs",
        role_title="Senior Software Engineer, Platform",
        jd_text="We need a senior backend engineer with TypeScript and PostgreSQL.",
        parsed={
            "skills": ["TypeScript", "PostgreSQL", "AWS"],
            "level": "senior",
            "must_haves": ["5+ years backend"],
            "responsibilities": ["Own backend services"],
            "tech_stack": ["TypeScript", "PostgreSQL"],
            "salary_min": 180000,
            "salary_max": 230000,
            "salary_currency": "USD",
            "locations": ["San Francisco, CA"],
            "remote": "hybrid",
            "nice_to_haves": ["Go"],
        },
        url="https://boards.greenhouse.io/synthetic/jobs/4071234",
    )


BASE_RESUME = {
    "basics": {"name": "Alice Engineer", "email": "alice@example.com"},
    "work": [
        {
            "company": "Synthetic Labs",
            "position": "Engineer",
            "startDate": "2020",
            "endDate": "2024",
        },
    ],
    "skills": [{"name": "TypeScript"}, {"name": "PostgreSQL"}],
}


# ─── happy path ────────────────────────────────────────────────────────


async def test_prepare_application_happy_path(monkeypatch, ttar_sink):
    async def fake_parse_jd(url, user_id, persist=True, http_client=None):
        return _stub_parsed_jd()

    async def fake_customize(*, base_resume, jd_text, user_id, base_version, base_id, job_id):
        return {
            "ok": True,
            "tailored": {**base_resume, "summary": "Tailored for Synthetic Labs"},
            "version": base_version + 1,
            "resume_id": str(uuid4()),
            "diff": {},
        }

    async def fake_cover(**kwargs):
        return appprep.CoverLetter(
            subject="Application for X — Alice",
            body="Dear Hiring Team,\n\n…\n\nBest,\nAlice",
            tone="warm",
            fallback=False,
            fabricated_entities=[],
        )

    async def fake_form(**kwargs):
        return [
            appprep.FormFieldAnswer(
                id="first_name", answer="Alice", skip=False, reason=None, confidence=0.95
            )
        ]

    monkeypatch.setattr(jm, "parse_jd_from_url", fake_parse_jd)
    monkeypatch.setattr(ra, "customize", fake_customize)
    monkeypatch.setattr(appprep, "generate_cover_letter", fake_cover)
    monkeypatch.setattr(appprep, "generate_form_answers", fake_form)

    result = await workflows.run_prepare_application(
        user_id=uuid4(),
        jd_url="https://boards.greenhouse.io/synthetic/jobs/4071234",
        base_resume_id=uuid4(),
        base_resume_content=BASE_RESUME,
        base_resume_version=1,
        form_fields=[{"id": "first_name", "label": "First Name", "type": "text"}],
    )

    assert result["status"] == "review"
    assert result["stage_status"] == {
        "parse_jd": "ok",
        "customize_resume": "ok",
        "cover_letter": "ok",
        "form_answers": "ok",
    }
    assert result["cover_letter"]["fallback"] is False
    assert result["form_answers"][0]["answer"] == "Alice"
    assert result["company"] == "Synthetic Labs"

    # TTAR captured exactly one record with all 4 stages timed and success=True.
    assert len(ttar_sink) == 1
    rec = ttar_sink[0]
    assert rec["success"] is True
    assert set(rec["stages"].keys()) >= {"parse_jd_ms", "customize_ms", "cover_ms", "form_ms"}
    assert rec["fabrication_attempts"] == 0


# ─── parse_jd failure short-circuits the chain ─────────────────────────


async def test_prepare_application_parse_jd_failure(monkeypatch, ttar_sink):
    async def boom(url, user_id, persist=True, http_client=None):
        raise jm.JDFetchError("simulated 404 from Greenhouse")

    monkeypatch.setattr(jm, "parse_jd_from_url", boom)

    result = await workflows.run_prepare_application(
        user_id=uuid4(),
        jd_url="https://boards.greenhouse.io/missing/jobs/0",
        base_resume_id=uuid4(),
        base_resume_content=BASE_RESUME,
        base_resume_version=1,
    )

    assert result["status"] == "draft"
    assert result["stage_status"]["parse_jd"] == "failed"
    # Downstream stages must NOT have run.
    assert "customize_resume" not in result["stage_status"]
    assert "cover_letter" not in result["stage_status"]
    assert "404" in (result["last_error"] or "")

    # TTAR should still flush — failed prepares must show up in success-rate.
    assert len(ttar_sink) == 1
    assert ttar_sink[0]["success"] is False


# ─── customize_resume fabrication 3-strikes → fallback to base ─────────


async def test_prepare_application_customize_fabrication_falls_back(monkeypatch, ttar_sink):
    async def fake_parse_jd(url, user_id, persist=True, http_client=None):
        return _stub_parsed_jd()

    async def fake_customize_refuses(**kwargs):
        return {"ok": False, "reason": "fabrication_guard_failed", "fabricated": ["FakeCorp"]}

    async def fake_cover(**kwargs):
        return appprep.CoverLetter(
            subject="...", body="...", tone="direct", fallback=True, fabricated_entities=[]
        )

    async def fake_form(**kwargs):
        return []

    monkeypatch.setattr(jm, "parse_jd_from_url", fake_parse_jd)
    monkeypatch.setattr(ra, "customize", fake_customize_refuses)
    monkeypatch.setattr(appprep, "generate_cover_letter", fake_cover)
    monkeypatch.setattr(appprep, "generate_form_answers", fake_form)

    base_id = uuid4()
    result = await workflows.run_prepare_application(
        user_id=uuid4(),
        jd_url="https://boards.greenhouse.io/synthetic/jobs/4071234",
        base_resume_id=base_id,
        base_resume_content=BASE_RESUME,
        base_resume_version=1,
    )

    # Stage 2 marked fallback, but the chain continued.
    assert result["stage_status"]["customize_resume"] == "fallback"
    # tailored_resume_id should == base_resume_id when fallback occurred.
    assert result["tailored_resume_id"] == str(base_id)
    # cover & form still ran (saga continued).
    assert result["stage_status"]["cover_letter"] == "fallback"
    assert result["stage_status"]["form_answers"] == "ok"
    # TTAR records the 3 fabrication attempts (the customize node treats
    # fabrication_guard 3-strikes as a single accumulator bump of 3).
    assert ttar_sink[0]["fabrication_attempts"] == 3


# ─── cover_letter LLM fail surfaces as fallback, not crash ─────────────


async def test_prepare_application_cover_fallback_keeps_form_running(monkeypatch, ttar_sink):
    async def fake_parse_jd(url, user_id, persist=True, http_client=None):
        return _stub_parsed_jd()

    async def fake_customize(**kwargs):
        return {
            "ok": True,
            "tailored": BASE_RESUME,
            "version": 2,
            "resume_id": str(uuid4()),
            "diff": {},
        }

    async def fake_cover_fallback(**kwargs):
        return appprep.CoverLetter(
            subject="Application for X — Alice",
            body="Dear Hiring Team,\n\nGeneric fallback.\n\nBest,\nAlice",
            tone="direct",
            fallback=True,  # <- LLM unavailable
            fabricated_entities=[],
        )

    async def fake_form(**kwargs):
        return [
            appprep.FormFieldAnswer(
                id="why_us",
                answer="I like building stuff.",
                skip=False,
                reason=None,
                confidence=0.6,
            )
        ]

    monkeypatch.setattr(jm, "parse_jd_from_url", fake_parse_jd)
    monkeypatch.setattr(ra, "customize", fake_customize)
    monkeypatch.setattr(appprep, "generate_cover_letter", fake_cover_fallback)
    monkeypatch.setattr(appprep, "generate_form_answers", fake_form)

    result = await workflows.run_prepare_application(
        user_id=uuid4(),
        jd_url="https://boards.greenhouse.io/synthetic/jobs/4071234",
        base_resume_id=uuid4(),
        base_resume_content=BASE_RESUME,
        base_resume_version=1,
        form_fields=[{"id": "why_us", "label": "Why us?", "type": "textarea"}],
    )

    assert result["stage_status"]["cover_letter"] == "fallback"
    assert result["stage_status"]["form_answers"] == "ok"
    # status remains review because parse_jd + customize succeeded and we have
    # a cover letter (even fallback content) — user can still ship the app.
    assert result["status"] == "review"
    assert ttar_sink[0]["success"] is True


# ─── form_answers sensitive field forced skip ──────────────────────────


async def test_prepare_application_sensitive_field_is_skipped(monkeypatch, ttar_sink):
    """No LLM, no PG — runs the real appprep.generate_form_answers locally."""

    async def fake_parse_jd(url, user_id, persist=True, http_client=None):
        return _stub_parsed_jd()

    async def fake_customize(**kwargs):
        return {
            "ok": True,
            "tailored": BASE_RESUME,
            "version": 2,
            "resume_id": str(uuid4()),
            "diff": {},
        }

    async def fake_cover(**kwargs):
        return appprep.CoverLetter(
            subject="...",
            body="Dear...\nBest, Alice",
            tone="warm",
            fallback=False,
            fabricated_entities=[],
        )

    monkeypatch.setattr(jm, "parse_jd_from_url", fake_parse_jd)
    monkeypatch.setattr(ra, "customize", fake_customize)
    monkeypatch.setattr(appprep, "generate_cover_letter", fake_cover)
    # form_answers is NOT stubbed — we hit the real function. With no LLM key,
    # ask_llm branch returns no_llm_key skip, so only the sensitive-field
    # local skip is interesting here.

    fields = [
        {"id": "race-question", "label": "Race / Ethnicity (US EEO)", "type": "select"},
        {"id": "first_name", "label": "First Name", "type": "text"},
    ]

    result = await workflows.run_prepare_application(
        user_id=uuid4(),
        jd_url="https://boards.greenhouse.io/synthetic/jobs/4071234",
        base_resume_id=uuid4(),
        base_resume_content=BASE_RESUME,
        base_resume_version=1,
        form_fields=fields,
    )

    answers = {a["id"]: a for a in result["form_answers"]}
    assert answers["race-question"]["skip"] is True
    assert answers["race-question"]["reason"] == "sensitive_field_user_decides"
    # first_name is not sensitive, but no LLM key → also skipped with no_llm_key.
    assert answers["first_name"]["skip"] is True
    # In a 2-field form with both skipped, form_answers is "fallback".
    assert result["stage_status"]["form_answers"] == "fallback"
