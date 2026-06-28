"""Tests for change_log_guard — the per-bullet risk annotator added in P2.3.

We keep these tests dependency-free (no DB, no LLM); change_log_guard is a
pure function so the contract above resume_agent stays cheap to verify.
"""

from __future__ import annotations

from agents.nodes.resume_agent import change_log_guard

# Minimal base résumé covering the strings we expect to find. The leaves are
# what `_flatten_text` joins into the lowercased haystack.
BASE = {
    "basics": {"summary": "Engineer with 5 years building APIs."},
    "work": [
        {
            "name": "Acme",
            "position": "Senior Engineer",
            "highlights": [
                "Led platform migration cutting p95 latency by 40%.",
                "Mentored 7 engineers over 18 months.",
            ],
        }
    ],
}


def test_safe_change_passes() -> None:
    log = [
        {
            "bullet_id": "work[0].highlights[0]",
            "change_type": "tighten",
            "before": "Led platform migration cutting p95 latency by 40%.",
            "after": "Led migration; p95 dropped 40%.",
            "source_evidence": "work[0].highlights[0]",
            "explanation": "Shorter, same fact.",
        }
    ]
    [annotated] = change_log_guard(BASE, log)
    assert annotated["risk"] == "safe"


def test_infer_wording_flagged_for_review() -> None:
    log = [
        {
            "bullet_id": "basics.summary",
            "change_type": "infer_wording",
            "before": "Engineer with 5 years building APIs.",
            "after": "Engineer with 5 years architecting distributed systems.",
            "source_evidence": "basics.summary",
            "explanation": "Generalised API to distributed systems.",
        }
    ]
    [annotated] = change_log_guard(BASE, log)
    assert annotated["risk"] == "needs_review"


def test_safe_with_new_percentage_demoted_to_needs_review() -> None:
    """A 'tighten' that smuggles in a new percentage must NOT pass as safe."""
    log = [
        {
            "bullet_id": "work[0].highlights[0]",
            "change_type": "tighten",
            "before": "Led platform migration cutting p95 latency by 40%.",
            "after": "Led migration; p95 dropped 73%.",
            "source_evidence": "work[0].highlights[0]",
            "explanation": "Shorter.",
        }
    ]
    [annotated] = change_log_guard(BASE, log)
    assert annotated["risk"] == "needs_review"


def test_missing_evidence_demotes_safe_to_needs_review() -> None:
    log = [
        {
            "bullet_id": "work[0].highlights[0]",
            "change_type": "tighten",
            "before": "x",
            "after": "y",
            "source_evidence": "",
            "explanation": "",
        }
    ]
    [annotated] = change_log_guard(BASE, log)
    assert annotated["risk"] == "needs_review"


def test_unknown_change_type_unsupported() -> None:
    log = [
        {
            "bullet_id": "work[0].highlights[1]",
            "change_type": "rewrite_in_first_person",
            "before": "Mentored 7 engineers over 18 months.",
            "after": "I mentored 7 engineers.",
            "source_evidence": "work[0].highlights[1]",
            "explanation": "",
        }
    ]
    [annotated] = change_log_guard(BASE, log)
    assert annotated["risk"] == "unsupported"


def test_missing_after_unsupported() -> None:
    log = [
        {
            "bullet_id": "basics.summary",
            "change_type": "tighten",
            "before": "Engineer with 5 years building APIs.",
            "after": "",
            "source_evidence": "basics.summary",
            "explanation": "",
        }
    ]
    [annotated] = change_log_guard(BASE, log)
    assert annotated["risk"] == "unsupported"
