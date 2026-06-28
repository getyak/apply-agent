"""Tests for the Resume Intake Agent (design §12).

structure_check / _rule_normalize / _coerce_intake_suggestions are pure and
tested directly. The LLM-backed validators (proofread / normalize) are tested
by monkeypatching the single ``_run_*`` seam so no provider key is needed. The
DB write in ``intake`` is exercised by stubbing resume_store.

Red lines under test (vision.md / §12.2):
  - proofread never flags tech-stack abbreviations as typos
  - proofread/normalize fixes that introduce a NEW number are dropped, not safe
  - normalize unifies date format to YYYY–YYYY
  - every persisted finding carries proposed_by='intake'
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from agents.nodes import resume_intake

BASE = {
    "basics": {"name": "Jordan Lee", "email": "jordan@example.com"},
    "work": [
        {
            "name": "Acme",
            "position": "Senior Engineer",
            "startDate": "2021",
            "highlights": [
                "Worked on platform migration that cut p95 latency by 40%.",
                "Mentored 7 engineers.",
            ],
        }
    ],
    "skills": [{"name": "js", "keywords": ["postgres"]}],
    "education": [{"institution": "State University"}],
}


# ── ① structure_check ─────────────────────────────────────────────────


def test_structure_check_complete() -> None:
    out = resume_intake.structure_check(BASE)
    assert out["complete"] is True
    assert out["missing"] == []


def test_structure_check_detects_missing_contact_and_sections() -> None:
    thin = {"basics": {"name": "Jordan"}, "work": [], "skills": []}
    out = resume_intake.structure_check(thin)
    assert out["complete"] is False
    assert "basics.email" in out["missing"]
    assert "work" in out["missing"]
    assert "skills" in out["missing"]
    assert "education" in out["missing"]
    # name present → not flagged
    assert "basics.name" not in out["missing"]


def test_structure_check_string_skills_count() -> None:
    out = resume_intake.structure_check({**BASE, "skills": ["Python", "Go"]})
    assert "skills" not in out["missing"]


# ── ② proofread ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_proofread_flags_typo_as_needs_review(monkeypatch) -> None:
    async def fake_run(parsed):
        return {
            "suggestions": [
                {
                    "section": "work",
                    "before_text": "Worked on platfrom migration.",
                    "after_text": "Worked on platform migration.",
                    "rationale": "platfrom → platform",
                }
            ]
        }

    monkeypatch.setattr(resume_intake, "_run_proofread", fake_run)
    out = await resume_intake.proofread(
        {**BASE, "work": [{"highlights": ["Worked on platfrom migration."]}]}
    )
    assert len(out) == 1
    assert out[0]["risk_level"] == "needs_review"
    assert out[0]["change_type"] == "infer_wording"


@pytest.mark.asyncio
async def test_proofread_does_not_misfire_on_tech_abbreviations(monkeypatch) -> None:
    """A well-behaved model returns nothing for k8s/PostgreSQL/gRPC; intake must
    not invent flags either. Empty model output → empty suggestion list."""

    async def fake_run(parsed):
        return {"suggestions": []}

    parsed = {
        **BASE,
        "work": [{"highlights": ["Ran k8s clusters with gRPC + PostgreSQL on the CUBXXW stack."]}],
    }
    monkeypatch.setattr(resume_intake, "_run_proofread", fake_run)
    out = await resume_intake.proofread(parsed)
    assert out == []


@pytest.mark.asyncio
async def test_proofread_drops_fabricating_fix(monkeypatch) -> None:
    """A 'typo fix' that smuggles in a brand-new number is a fabrication — it is
    dropped entirely, never surfaced even as needs_review (§12.2 red line)."""

    async def fake_run(parsed):
        return {
            "suggestions": [
                {
                    "section": "work",
                    "before_text": "Mentored engineers.",
                    "after_text": "Mentored 250 engineers.",  # 250 not in base
                    "rationale": "added count",
                }
            ]
        }

    monkeypatch.setattr(resume_intake, "_run_proofread", fake_run)
    out = await resume_intake.proofread(BASE)
    assert out == []


# ── ③ normalize ───────────────────────────────────────────────────────


def test_rule_normalize_canonicalizes_skill() -> None:
    out = resume_intake._rule_normalize(BASE)
    # js → JavaScript, all safe
    js = [s for s in out if s["before_text"] == "js"]
    assert len(js) == 1
    assert js[0]["after_text"] == "JavaScript"
    assert js[0]["risk_level"] == "safe"
    assert js[0]["change_type"] == "normalize_skill"


def test_rule_normalize_date_range_to_en_dash() -> None:
    parsed = {"work": [{"date": "2021 - 2024", "highlights": []}]}
    out = resume_intake._rule_normalize(parsed)
    dates = [s for s in out if s["change_type"] == "normalize_date"]
    assert len(dates) == 1
    assert dates[0]["after_text"] == "2021–2024"
    assert dates[0]["risk_level"] == "safe"


def test_rule_normalize_date_present_lowercased() -> None:
    parsed = {"work": [{"period": "2022 to Present", "highlights": []}]}
    out = resume_intake._rule_normalize(parsed)
    dates = [s for s in out if s["change_type"] == "normalize_date"]
    assert dates[0]["after_text"] == "2022–present"


@pytest.mark.asyncio
async def test_normalize_merges_rule_and_llm_without_dupes(monkeypatch) -> None:
    async def fake_run(parsed):
        # LLM re-proposes the same skill (should be deduped) + a fresh one.
        return {
            "suggestions": [
                {
                    "section": "skills",
                    "change_type": "normalize_skill",
                    "before_text": "js",
                    "after_text": "JavaScript",
                },
                {
                    "section": "work",
                    "change_type": "normalize_tense",
                    "before_text": "Leading the team.",
                    "after_text": "Led the team.",
                },
            ]
        }

    monkeypatch.setattr(resume_intake, "_run_normalize", fake_run)
    out = await resume_intake.normalize(BASE)
    js = [s for s in out if s["before_text"] == "js"]
    assert len(js) == 1  # rule wins, LLM dupe dropped
    tense = [s for s in out if s["before_text"] == "Leading the team."]
    assert len(tense) == 1
    assert tense[0]["risk_level"] == "safe"  # normalize_* → safe


# ── _coerce_intake_suggestions edge cases ────────────────────────────


def test_coerce_drops_malformed_entries() -> None:
    raw = {"suggestions": ["not a dict", {"before_text": "x"}, {"after_text": "y"}]}
    assert resume_intake._coerce_intake_suggestions(BASE, raw, "infer_wording", True) == []


def test_coerce_infer_wording_forced_review_even_without_force() -> None:
    raw = {
        "suggestions": [
            {
                "change_type": "infer_wording",
                "before_text": "Worked on platform migration that cut p95 latency by 40%.",
                "after_text": "Owned platform migration that cut p95 latency by 40%.",
            }
        ]
    }
    out = resume_intake._coerce_intake_suggestions(BASE, raw, "normalize_skill", False)
    assert out[0]["risk_level"] == "needs_review"


# ── intake orchestration ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_intake_persists_with_proposed_by_intake(monkeypatch) -> None:
    rid = uuid4()
    uid = uuid4()
    captured: dict = {}

    async def fake_get_resume(resume_id, user_id):
        return {
            "id": str(rid),
            "content": {"parsed": BASE},
            "track": "original",
            "bullet_index": {},
            "version": 1,
        }

    async def fake_proofread(parsed):
        return [
            {
                "bullet_stable_id": None,
                "section": "work",
                "change_type": "infer_wording",
                "before_text": "Worked on platfrom migration.",
                "after_text": "Worked on platform migration.",
                "rationale": "typo",
                "risk_level": "needs_review",
            }
        ]

    async def fake_normalize(parsed):
        return [
            {
                "bullet_stable_id": None,
                "section": "skills",
                "change_type": "normalize_skill",
                "before_text": "js",
                "after_text": "JavaScript",
                "rationale": "canon",
                "risk_level": "safe",
            }
        ]

    async def fake_quality(parsed, bullet_index):
        return []

    async def fake_insert(user_id, source_resume_id, suggestions, proposed_by):
        captured["proposed_by"] = proposed_by
        captured["count"] = len(suggestions)
        return [{**s, "id": str(uuid4()), "status": "proposed"} for s in suggestions]

    monkeypatch.setattr(resume_intake.resume_store, "get_resume", fake_get_resume)
    monkeypatch.setattr(resume_intake.resume_store, "insert_suggestions", fake_insert)
    monkeypatch.setattr(resume_intake, "proofread", fake_proofread)
    monkeypatch.setattr(resume_intake, "normalize", fake_normalize)
    monkeypatch.setattr(resume_intake, "quality_diag", fake_quality)

    out = await resume_intake.intake(rid, uid)
    assert out["ok"] is True
    assert out["structure"]["complete"] is True
    assert captured["proposed_by"] == "intake"
    assert captured["count"] == 2
    assert out["counts"] == {"safe": 1, "needs_review": 1}


@pytest.mark.asyncio
async def test_intake_resume_not_found(monkeypatch) -> None:
    async def fake_get_resume(resume_id, user_id):
        return None

    monkeypatch.setattr(resume_intake.resume_store, "get_resume", fake_get_resume)
    out = await resume_intake.intake(uuid4(), uuid4())
    assert out == {"ok": False, "reason": "resume_not_found"}


@pytest.mark.asyncio
async def test_intake_degrades_when_validator_raises(monkeypatch) -> None:
    """A slow-segment LLM hiccup in one validator must not sink intake (§12.6 Q3)."""
    rid, uid = uuid4(), uuid4()

    async def fake_get_resume(resume_id, user_id):
        return {
            "id": str(rid),
            "content": {"parsed": BASE},
            "track": "original",
            "bullet_index": {},
            "version": 1,
        }

    async def boom(parsed):
        raise RuntimeError("openrouter timeout")

    async def fake_normalize(parsed):
        return []

    async def fake_quality(parsed, bullet_index):
        return []

    async def fake_insert(user_id, source_resume_id, suggestions, proposed_by):
        return []

    monkeypatch.setattr(resume_intake.resume_store, "get_resume", fake_get_resume)
    monkeypatch.setattr(resume_intake.resume_store, "insert_suggestions", fake_insert)
    monkeypatch.setattr(resume_intake, "proofread", boom)
    monkeypatch.setattr(resume_intake, "normalize", fake_normalize)
    monkeypatch.setattr(resume_intake, "quality_diag", fake_quality)

    out = await resume_intake.intake(rid, uid)
    # proofread blew up, but structure + the rest still came back.
    assert out["ok"] is True
    assert out["structure"]["complete"] is True
