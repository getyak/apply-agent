"""Tests for the dual-track optimize logic (design §4.3, §6.1, §7.1).

Dependency-free: assign_bullet_ids / _validate_suggestions /
_apply_suggestions_to_parsed / _find_bullet are pure functions. The LLM and DB
paths (optimize_general / apply_suggestions / propose_bullet_edit) are covered
by integration tests, not here.
"""
from __future__ import annotations

from agents.nodes.resume_agent import (
    _apply_suggestions_to_parsed,
    _find_bullet,
    _validate_suggestions,
    assign_bullet_ids,
)

BASE = {
    "basics": {"summary": "Engineer with 5 years building APIs."},
    "work": [
        {
            "name": "Acme",
            "position": "Senior Engineer",
            "highlights": [
                "Worked on platform migration that cut p95 latency by 40%.",
                "Helped mentor 7 engineers over 18 months.",
            ],
        }
    ],
}


def test_assign_bullet_ids_one_per_highlight() -> None:
    index = assign_bullet_ids(BASE)
    assert len(index) == 2
    for sid, entry in index.items():
        assert sid.startswith("b_")
        assert entry["path"].startswith("work.0.highlights.")
        assert "text_hash" in entry and "anchor_text" in entry


def test_assign_bullet_ids_stable_ids_are_unique() -> None:
    index = assign_bullet_ids(BASE)
    assert len(set(index.keys())) == len(index)


def test_find_bullet_resolves_by_path() -> None:
    index = assign_bullet_ids(BASE)
    first_id = next(iter(index))
    text = _find_bullet(BASE, index, first_id)
    assert text == BASE["work"][0]["highlights"][0]


def test_find_bullet_fuzzy_fallback_when_reshuffled() -> None:
    index = assign_bullet_ids(BASE)
    first_id = next(iter(index))
    # Simulate the LLM swapping highlight order: path now points elsewhere,
    # anchor_text fuzzy match must still resolve it.
    reshuffled = {
        "work": [
            {
                "highlights": [
                    BASE["work"][0]["highlights"][1],
                    BASE["work"][0]["highlights"][0],
                ]
            }
        ]
    }
    text = _find_bullet(reshuffled, index, first_id)
    assert text == BASE["work"][0]["highlights"][0]


def test_validate_suggestions_marks_safe() -> None:
    raw = {
        "suggestions": [
            {
                "bullet_stable_id": "b_x",
                "section": "work",
                "change_type": "tighten",
                "before_text": "Worked on platform migration that cut p95 latency by 40%.",
                "after_text": "Led platform migration cutting p95 latency by 40%.",
                "rationale": "active voice",
            }
        ]
    }
    out = _validate_suggestions(BASE, raw)
    assert len(out) == 1
    # 40% already appears in base → no new quantitative token → safe.
    assert out[0]["risk_level"] == "safe"


def test_validate_suggestions_flags_new_number_as_review() -> None:
    raw = {
        "suggestions": [
            {
                "change_type": "quantify_existing",
                "before_text": "Helped mentor 7 engineers over 18 months.",
                "after_text": "Mentored 250 engineers over 18 months.",
            }
        ]
    }
    out = _validate_suggestions(BASE, raw)
    # 250 is not in base → must be needs_review, never silently safe.
    assert out[0]["risk_level"] == "needs_review"


def test_validate_suggestions_infer_wording_is_review() -> None:
    raw = {
        "suggestions": [
            {
                "change_type": "infer_wording",
                "before_text": "Worked on platform migration that cut p95 latency by 40%.",
                "after_text": "Owned the platform migration that cut p95 latency by 40%.",
            }
        ]
    }
    out = _validate_suggestions(BASE, raw)
    assert out[0]["risk_level"] == "needs_review"


def test_validate_suggestions_drops_incomplete() -> None:
    raw = {"suggestions": [{"change_type": "tighten", "after_text": ""}, "not a dict"]}
    assert _validate_suggestions(BASE, raw) == []


def test_apply_suggestions_does_not_mutate_input() -> None:
    suggestions = [
        {
            "section": "work",
            "before_text": "Worked on platform migration that cut p95 latency by 40%.",
            "after_text": "Led platform migration cutting p95 latency by 40%.",
        }
    ]
    out = _apply_suggestions_to_parsed(BASE, suggestions)
    # Input untouched (immutability principle §3.2)
    assert BASE["work"][0]["highlights"][0].startswith("Worked on")
    # Output has the new text
    assert out["work"][0]["highlights"][0].startswith("Led platform")


def test_apply_suggestions_summary_section() -> None:
    suggestions = [
        {
            "section": "summary",
            "before_text": "Engineer with 5 years building APIs.",
            "after_text": "API engineer, 5 years.",
        }
    ]
    out = _apply_suggestions_to_parsed(BASE, suggestions)
    assert out["basics"]["summary"] == "API engineer, 5 years."
