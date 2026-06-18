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
import os
import re
from pathlib import Path
from typing import Any
from uuid import UUID

import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.events.bus import publish
from agents.harness.audit import audit
from agents.harness.llm import cost_cents, pick_model
from agents.tools.auto import pg_query, redis_get, redis_setex
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
        cache_key = f"resume:tailored:{user_id}:{job_id}:{base_version}"
        cached = await redis_get(cache_key)
        if cached:
            record.cache_hit = True
            tailored = json.loads(cached)
        else:
            tailored = await _generate_tailored(base_resume, jd_text)
            await redis_setex(cache_key, 7 * 24 * 3600, json.dumps(tailored))

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
            tailored = await _generate_tailored(base_resume, jd_text, fabrication_warning=fab)

        # Persist as v_{n+1}.
        new_version = base_version + 1
        new_id = await save_resume_version(
            user_id=user_id,
            version=new_version,
            content_json=tailored,
            parent_version_id=base_id,
            tailored_for_job=job_id,
            is_base=False,
        )

        await publish(
            "resume:updated", {"user_id": str(user_id), "version": new_version, "resume_id": str(new_id)}
        )

        return {
            "ok": True,
            "tailored": tailored,
            "version": new_version,
            "resume_id": str(new_id),
            "diff": _compute_diff(base_resume, tailored),
        }


async def _generate_tailored(
    base_resume: dict[str, Any], jd_text: str, fabrication_warning: list[str] | None = None
) -> dict[str, Any]:
    model = pick_model("general", temperature=0.4, max_tokens=4096)
    sys_prompt = _load_prompt("customize.v1.md")
    if fabrication_warning:
        sys_prompt += (
            "\n\nPREVIOUS ATTEMPT INTRODUCED THESE FABRICATIONS — DO NOT REPEAT:\n"
            + "\n".join(f"- {e}" for e in fabrication_warning[:20])
        )
    payload = {"base": base_resume, "jd": jd_text[:8000]}
    resp = await model.ainvoke(
        [SystemMessage(content=sys_prompt), HumanMessage(content=json.dumps(payload, ensure_ascii=False))]
    )
    return _safe_json(resp.content)


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

        # Save as v1 base.
        new_id = await save_resume_version(
            user_id=user_id,
            version=1,
            content_json=draft,
            parent_version_id=None,
            tailored_for_job=None,
            is_base=True,
        )
        return {"draft": draft, "resume_id": str(new_id), "version": 1}


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
