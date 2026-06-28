"""Resume Intake Agent — parse + four-way validation (design §12).

`intake` is a SUPERSET of `resume_agent.parse`, not a sixth agent. It wraps the
existing parse with four validators and emits the results as *suggestions*
(`proposed_by="intake"`) — it NEVER mutates the immutable original (§7.2 trigger
backs this; this module only ever inserts into resume_suggestions).

The four validators (§12.2):
  ① structure_check — rule-first; are the required sections present?
  ② proofread       — LLM flags typos/grammar/tense, marks (does NOT auto-fix)
  ③ normalize       — rule-first + LLM fallback; dates / skill names / tense
  ④ quality_diag    — reuses optimize_general's weak-bullet diagnosis

Kept out of resume_agent.py (already ~864 lines, near the 800-line ceiling) so
neither file grows unbounded. resume_agent.py re-exports `intake` for callers
that import the agent module directly.

All LLM-calling steps run their model invocation inside a tiny `_run_*` helper
so unit tests can monkeypatch the single seam. Every rewrite suggestion is
passed through resume_agent.fabrication_guard's per-bullet vocabulary
(`_has_new_quantitative_token`) before it can be marked `safe`.
"""

from __future__ import annotations

import json
import re
from typing import Any
from uuid import UUID

import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.harness.audit import audit
from agents.harness.llm import pick_model
from agents.nodes import resume_agent, resume_store

log = structlog.get_logger("agents.nodes.resume_intake")

_load_prompt = resume_agent._load_prompt
_safe_json = resume_agent._safe_json
_flatten_text = resume_agent._flatten_text


# ───────────────────────────────────────────────────────────────────────
# ① structure_check — rule-based required-section diagnosis (§12.2)
# ───────────────────────────────────────────────────────────────────────


def structure_check(parsed: dict[str, Any]) -> dict[str, Any]:
    """Diagnose required-section gaps. Pure rules, no LLM.

    Required, per design §12.2: basics.name, basics.email, work, skills,
    education. Returns a DIAGNOSTIC dict (not suggestions):

        {"complete": bool, "missing": ["basics.email", "work", ...]}

    `missing` keys are dotted so the UI can address them precisely. This is the
    "can it be used at all" gate — §12.4 runs it in the fast (sync) segment.
    """
    basics = parsed.get("basics") if isinstance(parsed.get("basics"), dict) else {}
    missing: list[str] = []

    name = (basics.get("name") or "").strip()
    if not name:
        missing.append("basics.name")
    email = (basics.get("email") or "").strip()
    if not email:
        missing.append("basics.email")

    if not _non_empty_list(parsed.get("work")):
        missing.append("work")
    if not _has_any_skill(parsed.get("skills")):
        missing.append("skills")
    if not _non_empty_list(parsed.get("education")):
        missing.append("education")

    return {"complete": not missing, "missing": missing}


def _non_empty_list(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def _has_any_skill(skills: Any) -> bool:
    """Skills may be a list of strings or of {name, keywords} dicts."""
    if not isinstance(skills, list):
        return False
    for s in skills:
        if isinstance(s, str) and s.strip():
            return True
        if isinstance(s, dict) and ((s.get("name") or "").strip() or s.get("keywords")):
            return True
    return False


# ───────────────────────────────────────────────────────────────────────
# ② proofread — LLM flags mechanical issues, never auto-fixes (§12.2)
# ───────────────────────────────────────────────────────────────────────


async def proofread(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """Flag typos / grammar / tense / punctuation as suggestions.

    Every suggestion is `change_type='infer_wording'`, `risk_level='needs_review'`
    (the candidate confirms — §12.2 ② is never auto-applied), and must clear the
    per-bullet fabrication check: a "fix" that introduces a quantitative token
    not in the source is dropped, not merely flagged. Tech-stack abbreviations,
    product names, and people's names are NOT typos (prompt enforces this; see
    proofread.v1.md).
    """
    raw = await _run_proofread(parsed)
    return _coerce_intake_suggestions(
        parsed,
        raw,
        default_change_type="infer_wording",
        force_review=True,
    )


async def _run_proofread(parsed: dict[str, Any]) -> dict[str, Any]:
    model = pick_model("fast", temperature=0.0, max_tokens=2048)
    prompt = _load_prompt("proofread.v1.md")
    payload = {"resume": parsed}
    resp = await model.ainvoke(
        [
            SystemMessage(content=prompt),
            HumanMessage(content=json.dumps(payload, ensure_ascii=False)[:24_000]),
        ]
    )
    return _safe_json(resp.content)


# ───────────────────────────────────────────────────────────────────────
# ③ normalize — rule-first date/skill/tense normalization + LLM fallback
# ───────────────────────────────────────────────────────────────────────


# Canonical skill names — the deterministic cases. Anything ambiguous is left
# to the LLM fallback (normalize.v1.md). Keyed by lower-cased surface form.
_SKILL_CANON = {
    "js": "JavaScript",
    "javascript": "JavaScript",
    "ts": "TypeScript",
    "typescript": "TypeScript",
    "nodejs": "Node.js",
    "node.js": "Node.js",
    "node": "Node.js",
    "postgres": "PostgreSQL",
    "postgresql": "PostgreSQL",
    "psql": "PostgreSQL",
    "k8s": "Kubernetes",
    "kubernetes": "Kubernetes",
    "golang": "Go",
    "py": "Python",
    "python": "Python",
}

# A date range with an ASCII hyphen / "to" between two years → en-dash form.
_DATE_RANGE_RE = re.compile(
    r"\b((?:19|20)\d{2})\s*(?:-|--|—|to)\s*((?:19|20)\d{2}|present|current|now)\b",
    re.IGNORECASE,
)


async def normalize(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """Date / skill-name / tense normalization. Rules first, LLM as fallback.

    Deterministic, presentation-only fixes (date ranges → `YYYY–YYYY`, skill
    casing → canonical) are `risk_level='safe'`. The LLM fallback handles the
    judgment calls; anything it returns as `infer_wording`, or that introduces a
    new quantitative token, is `needs_review`.
    """
    rule_suggestions = _rule_normalize(parsed)
    seen_before = {s["before_text"].strip() for s in rule_suggestions}

    raw = await _run_normalize(parsed)
    llm_suggestions = _coerce_intake_suggestions(
        parsed,
        raw,
        default_change_type="normalize_skill",
        force_review=False,
    )
    # Rule output wins on overlap — don't double-propose the same line.
    fresh_llm = [s for s in llm_suggestions if s["before_text"].strip() not in seen_before]
    return rule_suggestions + fresh_llm


def _rule_normalize(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministic, presentation-only normalizations → safe suggestions."""
    out: list[dict[str, Any]] = []

    # Skill-name canonicalization (string skills + dict.name).
    for s in parsed.get("skills", []) or []:
        if isinstance(s, str):
            canon = _SKILL_CANON.get(s.strip().lower())
            if canon and canon != s.strip():
                out.append(
                    _safe_suggestion(
                        section="skills",
                        change_type="normalize_skill",
                        before_text=s,
                        after_text=canon,
                        rationale=f"canonical skill name ({s} → {canon})",
                    )
                )
        elif isinstance(s, dict):
            name = (s.get("name") or "").strip()
            canon = _SKILL_CANON.get(name.lower())
            if canon and canon != name:
                out.append(
                    _safe_suggestion(
                        section="skills",
                        change_type="normalize_skill",
                        before_text=name,
                        after_text=canon,
                        rationale=f"canonical skill name ({name} → {canon})",
                    )
                )

    # Date-range normalization on work entries (startDate/endDate or a freeform
    # date string anywhere in the entry's leaf text).
    for w in parsed.get("work", []) or []:
        for raw_text in _date_strings(w):
            normalized = _normalize_date_range(raw_text)
            if normalized and normalized != raw_text:
                out.append(
                    _safe_suggestion(
                        section="work",
                        change_type="normalize_date",
                        before_text=raw_text,
                        after_text=normalized,
                        rationale="unified date-range format (YYYY–YYYY)",
                    )
                )
    return out


def _date_strings(work: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for key in ("date", "dates", "period", "startDate", "endDate"):
        val = work.get(key)
        if isinstance(val, str) and _DATE_RANGE_RE.search(val):
            out.append(val)
    return out


def _normalize_date_range(text: str) -> str | None:
    """`2021 - 2024` / `2021 to present` → `2021–2024` / `2021–present`.

    Only changes the SEPARATOR and the `present`/`current`/`now` token's
    casing — never the years themselves (fabrication red line).
    """
    m = _DATE_RANGE_RE.search(text)
    if not m:
        return None
    start, end = m.group(1), m.group(2).lower()
    end = "present" if end in {"present", "current", "now"} else end
    return _DATE_RANGE_RE.sub(f"{start}–{end}", text, count=1)


async def _run_normalize(parsed: dict[str, Any]) -> dict[str, Any]:
    model = pick_model("fast", temperature=0.0, max_tokens=2048)
    prompt = _load_prompt("normalize.v1.md")
    payload = {"resume": parsed}
    resp = await model.ainvoke(
        [
            SystemMessage(content=prompt),
            HumanMessage(content=json.dumps(payload, ensure_ascii=False)[:24_000]),
        ]
    )
    return _safe_json(resp.content)


# ───────────────────────────────────────────────────────────────────────
# ④ quality_diag — weak-bullet diagnosis, reuses optimize_general (§12.2)
# ───────────────────────────────────────────────────────────────────────


async def quality_diag(
    parsed: dict[str, Any], bullet_index: dict[str, Any]
) -> list[dict[str, Any]]:
    """Weak-bullet improvement suggestions.

    Internally reuses resume_agent's optimize_general logic (the "3 weakest
    spots" engine, design §6.1) so quality_diag and the optimize chip stay in
    lockstep. Output is already risk-annotated by `_validate_suggestions`.
    """
    raw = await resume_agent._run_optimize_general(parsed, bullet_index)
    return resume_agent._validate_suggestions(parsed, raw)


# ───────────────────────────────────────────────────────────────────────
# shared coercion — model output → clean, fabrication-checked suggestions
# ───────────────────────────────────────────────────────────────────────


def _coerce_intake_suggestions(
    parsed: dict[str, Any],
    raw: dict[str, Any],
    default_change_type: str,
    force_review: bool,
) -> list[dict[str, Any]]:
    """Turn an LLM `{suggestions: [...]}` blob into clean intake records.

    Drops malformed entries. Runs the per-bullet fabrication check: a rewrite
    whose `after_text` introduces a quantitative token (percent / money / year /
    big number) absent from the base résumé is DROPPED — intake never sneaks in
    a number the candidate didn't write (§12.2 ②/④ red line). `force_review`
    pins every surviving entry to `needs_review` (used by proofread, which is
    never auto-applied).
    """
    base_text = _flatten_text(parsed).lower()
    items = raw.get("suggestions") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        before = (entry.get("before_text") or "").strip()
        after = (entry.get("after_text") or "").strip()
        if not before or not after:
            continue
        change_type = (entry.get("change_type") or default_change_type).strip()
        introduces_number = resume_agent._has_new_quantitative_token(after, base_text)
        if introduces_number:
            # A proofread/normalize "fix" that surfaces a brand-new number is a
            # fabrication, not a correction — refuse it outright.
            log.info("intake.dropped_fabricating_suggestion", before=before[:64])
            continue
        if force_review or change_type == "infer_wording":
            risk = "needs_review"
        elif change_type.startswith("normalize_"):
            risk = "safe"
        else:
            risk = "needs_review"
        out.append(
            {
                "bullet_stable_id": entry.get("bullet_stable_id"),
                "section": entry.get("section") or "work",
                "change_type": change_type,
                "before_text": before,
                "after_text": after,
                "rationale": entry.get("rationale"),
                "risk_level": risk,
            }
        )
    return out


def _safe_suggestion(
    *, section: str, change_type: str, before_text: str, after_text: str, rationale: str
) -> dict[str, Any]:
    return {
        "bullet_stable_id": None,
        "section": section,
        "change_type": change_type,
        "before_text": before_text,
        "after_text": after_text,
        "rationale": rationale,
        "risk_level": "safe",
    }


# ───────────────────────────────────────────────────────────────────────
# intake — orchestrate parse + four validators, persist as suggestions
# ───────────────────────────────────────────────────────────────────────


async def intake(base_resume_id: UUID, user_id: UUID) -> dict[str, Any]:
    """Validate an already-parsed original résumé and stack the findings as
    suggestions (`proposed_by='intake'`). NEVER mutates the original.

    Returns:
        {
          "ok": bool,
          "structure": {"complete": bool, "missing": [...]},
          "suggestions": [<stored suggestion records>],
          "counts": {"safe": int, "needs_review": int},
        }

    The four validators run independently; a failing LLM step (proofread /
    normalize / quality_diag) is logged and skipped — intake still returns the
    structure diagnosis and whatever other findings succeeded (§12.6 Q3 graceful
    degradation).
    """
    async with audit(user_id, "resume_agent", "intake"):
        row = await resume_store.get_resume(base_resume_id, user_id)
        if not row:
            return {"ok": False, "reason": "resume_not_found"}
        parsed = resume_store.unwrap_parsed(row["content"])

        structure = structure_check(parsed)

        bullet_index = row.get("bullet_index") or resume_agent.assign_bullet_ids(parsed)

        suggestions: list[dict[str, Any]] = []
        suggestions += await _safe_run("proofread", proofread, parsed)
        suggestions += await _safe_run("normalize", normalize, parsed)
        suggestions += await _safe_run("quality_diag", quality_diag, parsed, bullet_index)

        stored: list[dict[str, Any]] = []
        if suggestions:
            stored = await resume_store.insert_suggestions(
                user_id, base_resume_id, suggestions, proposed_by="intake"
            )

        counts = {
            "safe": sum(1 for s in stored if s.get("risk_level") == "safe"),
            "needs_review": sum(1 for s in stored if s.get("risk_level") == "needs_review"),
        }
        return {
            "ok": True,
            "structure": structure,
            "suggestions": stored,
            "counts": counts,
        }


async def _safe_run(label: str, fn: Any, *args: Any) -> list[dict[str, Any]]:
    """Run one validator; on any failure log and return [] (§12.6 Q3).

    A slow-segment LLM hiccup must not sink the whole intake — the structure
    diagnosis and the other validators still come back.
    """
    try:
        result = await fn(*args)
        return result if isinstance(result, list) else []
    except Exception as exc:  # noqa: BLE001 — validator boundary, degrade gracefully
        log.warning("intake.validator_failed", validator=label, error=str(exc))
        return []
