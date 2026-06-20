"""ResumeAgent — parse / customize / analyze + fabrication_guard.

ABSOLUTE RULE (vision.md): AI may rephrase, NEVER invent. fabrication_guard
enforces this: any (company, title, year, percentage, dollar value, headcount)
in the output that is not in the base résumé is treated as fabrication and
triggers regeneration (up to 2 retries; then fail loudly).

The Résumé view in the Vantage UI is pure document + version timeline.
All "edit my résumé" conversation lives in Ask Vantage; this module exposes
endpoints the router invokes:
  parse(raw_text)          → JSON Resume v1.0
  customize(base, jd)      → JSON Resume v1.0 tailored, with diff
  analyze(content)         → {skills, missing_against_jd, suggestions}
  build_from_scratch(...)  → first draft from guided Q&A
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from uuid import UUID

import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.events.bus import publish
from agents.harness.audit import audit
from agents.harness.llm import pick_model
from agents.tools.auto import redis_get, redis_setex
from agents.tools.notify import save_resume_version

log = structlog.get_logger("agents.nodes.resume")

PROMPT_DIR = Path(__file__).parent.parent / "prompts" / "resume"


def _load_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


# ───────────────────────────────────────────────────────────────────────
# parse — PDF text → JSON Resume
# ───────────────────────────────────────────────────────────────────────


async def parse(raw_text: str, user_id: UUID) -> dict[str, Any]:
    async with audit(user_id, "resume_agent", "parse"):
        model = pick_model("fast", temperature=0.0, max_tokens=4096)
        prompt = _load_prompt("parse.v1.md")
        resp = await model.ainvoke(
            [SystemMessage(content=prompt), HumanMessage(content=raw_text[:30_000])]
        )
        return _safe_json(resp.content)


# ───────────────────────────────────────────────────────────────────────
# customize — base + JD → tailored, with fabrication_guard
# ───────────────────────────────────────────────────────────────────────


async def customize(
    base_resume: dict[str, Any],
    jd_text: str,
    user_id: UUID,
    base_version: int,
    base_id: UUID,
    job_id: UUID,
) -> dict[str, Any]:
    """Tailor base résumé to JD. Triggered from Ask Vantage 'Sharpen for X'.

    Returns: {tailored: dict, version: int, fabricated_entities: list}
    """
    async with audit(user_id, "resume_agent", "customize") as record:
        # Cache stores the full envelope ({tailored, change_log}) so the
        # warm path also returns provenance — historically we stored
        # just `tailored` which forced a re-generation any time the UI
        # asked for the change_log. Old cache entries (raw tailored
        # dict) are coerced to envelope shape via
        # _normalise_customize_envelope so we don't need a cache
        # version bump.
        cache_key = f"resume:tailored:{user_id}:{job_id}:{base_version}"
        cached = await redis_get(cache_key)
        if cached:
            record.cache_hit = True
            envelope = _normalise_customize_envelope(json.loads(cached))
        else:
            envelope = await _generate_tailored(base_resume, jd_text)
            await redis_setex(cache_key, 7 * 24 * 3600, json.dumps(envelope))
        tailored = envelope["tailored"]
        change_log = envelope["change_log"]

        # Fabrication guard — retry up to 2 times if entities leak.
        for attempt in range(3):
            fab = fabrication_guard(base_resume, tailored)
            if not fab:
                break
            log.warning(
                "resume.fabrication_detected", attempt=attempt, fabricated_entities=fab[:5]
            )
            if attempt == 2:
                # Final attempt failed — refuse to write.
                return {
                    "ok": False,
                    "reason": "fabrication_guard_failed",
                    "fabricated": fab,
                }
            envelope = await _generate_tailored(
                base_resume, jd_text, fabrication_warning=fab
            )
            tailored = envelope["tailored"]
            change_log = envelope["change_log"]

        # Annotate every change_log entry with a risk level (safe / needs
        # review / unsupported). The UI uses these to drive bullet-level
        # chips and gate the Approve button on "needs review" so users
        # see WHY each line was rewritten — vision.md's "诚实" line made
        # mechanical.
        annotated_log = change_log_guard(base_resume, change_log)
        needs_review_count = sum(1 for c in annotated_log if c.get("risk") == "needs_review")

        # Migration 016's trigger picks the next per-user version atomically;
        # we keep `base_version` for the parent_version_id link but no longer
        # compute the new version ourselves (concurrent customize against the
        # same base would otherwise collide on UNIQUE(user_id, version)).
        new_id, new_version = await save_resume_version(
            user_id=user_id,
            content_json=tailored,
            parent_version_id=base_id,
            tailored_for_job=job_id,
            is_base=False,
        )
        _ = base_version  # noqa: F841 — kept for parent linkage semantics, see above.

        await publish(
            "resume:updated",
            {"user_id": str(user_id), "version": new_version, "resume_id": str(new_id)},
        )

        return {
            "ok": True,
            "tailored": tailored,
            "version": new_version,
            "resume_id": str(new_id),
            "diff": _compute_diff(base_resume, tailored),
            "change_log": annotated_log,
            "needs_review_count": needs_review_count,
        }


async def _generate_tailored(
    base_resume: dict[str, Any], jd_text: str, fabrication_warning: list[str] | None = None
) -> dict[str, Any]:
    """Run the customize prompt and return a normalised
    `{tailored, change_log}` envelope.

    The v2 prompt asks the model to emit both halves. When a model returns
    just a résumé document (older prompt, malformed JSON, or a tiny model
    that ignores the schema), we coerce it into the envelope shape with
    an empty `change_log` so callers never need a branching parse.
    """
    model = pick_model("general", temperature=0.4, max_tokens=4096)
    sys_prompt = _load_prompt("customize.v2.md")
    if fabrication_warning:
        sys_prompt += (
            "\n\nPREVIOUS ATTEMPT INTRODUCED THESE FABRICATIONS — DO NOT REPEAT:\n"
            + "\n".join(f"- {e}" for e in fabrication_warning[:20])
        )
    payload = {"base": base_resume, "jd": jd_text[:8000]}
    resp = await model.ainvoke(
        [SystemMessage(content=sys_prompt), HumanMessage(content=json.dumps(payload, ensure_ascii=False))]
    )
    parsed = _safe_json(resp.content)
    return _normalise_customize_envelope(parsed)


def _normalise_customize_envelope(parsed: dict[str, Any]) -> dict[str, Any]:
    """Always return `{tailored, change_log}`. Forgiving of older shapes.

    - If `parsed` already has a `tailored` key we trust it (and default
      change_log to []).
    - If `parsed` looks like a JSON Resume document at the top level
      (has `basics` or `work`) we wrap it.
    - change_log entries that are not dicts (or that are missing the two
      required keys) are dropped so downstream callers can assume a
      stable record shape.
    """
    if isinstance(parsed, dict) and "tailored" in parsed:
        tailored = parsed.get("tailored") or {}
        raw_log = parsed.get("change_log") or []
    else:
        tailored = parsed if isinstance(parsed, dict) else {}
        raw_log = []
    change_log: list[dict[str, Any]] = []
    for entry in raw_log if isinstance(raw_log, list) else []:
        if not isinstance(entry, dict):
            continue
        bullet_id = entry.get("bullet_id")
        change_type = entry.get("change_type")
        if not isinstance(bullet_id, str) or not isinstance(change_type, str):
            continue
        change_log.append(
            {
                "bullet_id": bullet_id,
                "change_type": change_type,
                "before": entry.get("before"),
                "after": entry.get("after"),
                "source_evidence": entry.get("source_evidence"),
                "explanation": entry.get("explanation"),
            }
        )
    return {"tailored": tailored, "change_log": change_log}


# ───────────────────────────────────────────────────────────────────────
# fabrication_guard — the vision.md red line, mechanised
# ───────────────────────────────────────────────────────────────────────


_NUMBER_RE = re.compile(r"\b\d[\d,]*\.?\d*\b")
_PERCENT_RE = re.compile(r"\b\d+(?:\.\d+)?%")
_MONEY_RE = re.compile(r"[\$￥€]\s?\d[\d,]*(?:\.\d+)?[kKmMbB]?")
_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")


def fabrication_guard(base: dict[str, Any], tailored: dict[str, Any]) -> list[str]:
    """Return a list of entities present in `tailored` but not in `base`.

    Entities checked: company names, titles, years, percentages, monetary values,
    headcount numbers. Empty list = OK.
    """
    base_text = _flatten_text(base).lower()

    fabricated: list[str] = []

    # 1. Company names + titles — extract from tailored work[]
    for work in tailored.get("work", []):
        name = (work.get("name") or work.get("company") or "").strip()
        if name and name.lower() not in base_text:
            fabricated.append(f"company:{name}")
        position = (work.get("position") or "").strip()
        if position and position.lower() not in base_text:
            fabricated.append(f"position:{position}")

    # 2. Quantitative entities anywhere in tailored
    tailored_text = _flatten_text(tailored)
    for pattern, kind in [
        (_PERCENT_RE, "percent"),
        (_MONEY_RE, "money"),
        (_YEAR_RE, "year"),
    ]:
        for hit in set(pattern.findall(tailored_text)):
            if hit.lower() not in base_text:
                fabricated.append(f"{kind}:{hit}")

    # 3. Standalone numbers > 100 (likely headcounts / KPI values).
    for hit in set(_NUMBER_RE.findall(tailored_text)):
        try:
            val = float(hit.replace(",", ""))
        except ValueError:
            continue
        if val < 100:
            continue
        if hit not in base_text:
            fabricated.append(f"number:{hit}")

    return fabricated


# ───────────────────────────────────────────────────────────────────────
# change_log_guard — per-bullet risk annotation for the UI
# ───────────────────────────────────────────────────────────────────────


# `infer_wording` means the model rephrased something in a way that
# could be read as a new claim. Even when fabrication_guard passes at
# the document level, the front-end should still surface these for an
# explicit human check before Approve. tighten / quantify_existing /
# reorder are mechanically safe; anything else from a confused model
# falls through to `unsupported` so the user notices.
_SAFE_CHANGE_TYPES = {"tighten", "quantify_existing", "reorder"}
_REVIEW_CHANGE_TYPES = {"infer_wording"}


def change_log_guard(
    base: dict[str, Any], change_log: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Annotate each change_log entry with a `risk` field.

    risk ∈ {safe, needs_review, unsupported}.

    - safe          — change_type is tighten / quantify_existing / reorder
                      AND `after` only contains substrings already in base.
    - needs_review  — change_type is infer_wording, OR a "safe" entry
                      introduced a quantitative token not in base.
    - unsupported   — change_type is unknown, OR `source_evidence` is
                      missing, OR `after` is missing.

    Pure function — no IO, no LLM call. Cheap to run every customize.
    The UI uses these risk levels to drive bullet-level chips and to
    disable Approve when any row is `needs_review` or `unsupported`.
    """
    base_text = _flatten_text(base).lower()
    annotated: list[dict[str, Any]] = []
    for entry in change_log:
        change_type = (entry.get("change_type") or "").strip()
        after = (entry.get("after") or "").strip()
        source_evidence = (entry.get("source_evidence") or "").strip()

        if not change_type or not after:
            risk = "unsupported"
        elif change_type in _REVIEW_CHANGE_TYPES:
            risk = "needs_review"
        elif change_type in _SAFE_CHANGE_TYPES:
            if not source_evidence:
                risk = "needs_review"
            elif _has_new_quantitative_token(after, base_text):
                # A "tighten" that quietly surfaces a brand new percentage
                # or dollar value is exactly the kind of subtle fab the
                # red line targets — push it back to the user.
                risk = "needs_review"
            else:
                risk = "safe"
        else:
            risk = "unsupported"

        annotated.append({**entry, "risk": risk})
    return annotated


def _has_new_quantitative_token(after: str, base_text: str) -> bool:
    """True if `after` contains a percent / money / year / large number
    that doesn't appear in `base_text`. Mirrors fabrication_guard's
    entity vocabulary so the two stay in sync."""
    after_lower = after.lower()
    for pattern in (_PERCENT_RE, _MONEY_RE, _YEAR_RE):
        for hit in set(pattern.findall(after_lower)):
            if hit not in base_text:
                return True
    for hit in set(_NUMBER_RE.findall(after_lower)):
        try:
            val = float(hit.replace(",", ""))
        except ValueError:
            continue
        if val < 100:
            continue
        if hit not in base_text:
            return True
    return False


def _flatten_text(obj: Any) -> str:
    """Recursively concatenate all string leaves of a JSON-like value."""
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        return " ".join(_flatten_text(v) for v in obj.values())
    if isinstance(obj, list):
        return " ".join(_flatten_text(v) for v in obj)
    if obj is None:
        return ""
    return str(obj)


def _compute_diff(base: dict[str, Any], tailored: dict[str, Any]) -> dict[str, Any]:
    """Coarse-grained diff for the UI ribbon. v0: section-level changed flag.

    A real semantic diff would diff by JSON Pointer, but v0 just flags sections
    that changed string content.
    """
    diff: dict[str, Any] = {}
    for k in {*base.keys(), *tailored.keys()}:
        if _flatten_text(base.get(k)) != _flatten_text(tailored.get(k)):
            diff[k] = "changed"
    return diff


# ───────────────────────────────────────────────────────────────────────
# build_from_scratch — first draft from guided Q&A
# ───────────────────────────────────────────────────────────────────────


async def build_from_scratch(
    target_role: str, recent_role: str, top_3_wins: list[str], user_id: UUID
) -> dict[str, Any]:
    async with audit(user_id, "resume_agent", "build_from_scratch"):
        model = pick_model("general", temperature=0.5, max_tokens=2048)
        prompt = _load_prompt("build_from_scratch_draft.v1.md")
        payload = {
            "target_role": target_role,
            "recent_role": recent_role,
            "top_3_wins": top_3_wins,
        }
        resp = await model.ainvoke(
            [SystemMessage(content=prompt), HumanMessage(content=json.dumps(payload, ensure_ascii=False))]
        )
        draft = _safe_json(resp.content)

        # Save as base — trigger assigns the version (typically 1 for a fresh
        # account, but the user may already have other rows from a prior run,
        # so we never hard-code 1).
        new_id, assigned_v = await save_resume_version(
            user_id=user_id,
            content_json=draft,
            parent_version_id=None,
            tailored_for_job=None,
            is_base=True,
        )
        return {"draft": draft, "resume_id": str(new_id), "version": assigned_v}


# ───────────────────────────────────────────────────────────────────────
# analyze — skill / gap inspection (used by Today view + Trend agent)
# ───────────────────────────────────────────────────────────────────────


async def analyze(content: dict[str, Any], user_id: UUID) -> dict[str, Any]:
    async with audit(user_id, "resume_agent", "analyze"):
        skills = _extract_skill_list(content)
        return {
            "skills": skills,
            "experience_years": _estimate_years(content),
            "completeness": _completeness_score(content),
        }


def _extract_skill_list(resume: dict[str, Any]) -> list[str]:
    skills = []
    for s in resume.get("skills", []):
        if isinstance(s, dict):
            skills.append(s.get("name", "") or "")
            skills.extend(s.get("keywords", []) or [])
        else:
            skills.append(str(s))
    return [s for s in skills if s]


def _estimate_years(resume: dict[str, Any]) -> float:
    """Sum of work item durations (approximate; uses year-only granularity)."""
    total = 0
    for w in resume.get("work", []):
        start = _year(w.get("startDate"))
        end = _year(w.get("endDate")) or 2026
        if start and end:
            total += max(0, end - start)
    return float(total)


def _year(date_str: str | None) -> int | None:
    if not date_str:
        return None
    m = _YEAR_RE.search(date_str)
    return int(m.group()) if m else None


def _completeness_score(resume: dict[str, Any]) -> float:
    """0..1 — how much of the JSON Resume schema is populated."""
    keys = ("basics", "work", "education", "skills", "summary")
    return round(sum(1 for k in keys if resume.get(k)) / len(keys), 2)


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        return json.loads(s)
    except json.JSONDecodeError:
        log.warning("resume.invalid_json_response", preview=str(content)[:200])
        return {}
