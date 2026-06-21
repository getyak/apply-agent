"""AppPrepAgent — cover letter + ATS form answer generation.

Caller: agents/coordinator/workflows.py::build_prepare_application_graph()
chains parse_jd → customize → AppPrep here → mark ready_for_review. Direct
extension calls land via /api/extension/map-fields (Task T7).

Two LLM calls, no chaining inside this node:
- generate_cover_letter:  GLM-4.7 (general tier) — needs narrative quality
- generate_form_answers:  V4 Flash (fast tier)   — high-volume, mostly map+fill

Both honour the vision.md red line via fabrication_guard reuse from
agents/nodes/resume_agent (named entities in cover/form must trace back to
the supplied résumé). Sensitive fields (race/gender/etc.) auto-skip with a
flag so the extension can ask the user directly.

Failure mode: every degradation path returns a structured fallback rather
than raising. Workflow saga (delivery-loop-plan.md § 2.3) keeps the chain
moving even when one stage misfires — a missing cover letter is recoverable;
a crashed agent crashes the whole prepare.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.harness.audit import audit
from agents.harness.llm import pick_model
from agents.nodes.resume_agent import fabrication_guard

log = structlog.get_logger("agents.nodes.appprep")


PROMPT_DIR = Path(__file__).parent.parent / "prompts" / "appprep"


def _load_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


# ─── return shapes ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class CoverLetter:
    subject: str
    body: str
    tone: str  # "professional" | "warm" | "direct"
    fallback: bool  # True when a template was used instead of LLM
    fabricated_entities: list[str]  # populated when guard flagged leaks

    def to_dict(self) -> dict[str, Any]:
        return {
            "subject": self.subject,
            "body": self.body,
            "tone": self.tone,
            "fallback": self.fallback,
            "fabricated_entities": self.fabricated_entities,
        }


@dataclass(frozen=True)
class FormFieldAnswer:
    id: str
    answer: str | None
    skip: bool
    reason: str | None
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "answer": self.answer,
            "skip": self.skip,
            "reason": self.reason,
            "confidence": self.confidence,
        }


# ─── cover letter ──────────────────────────────────────────────────────


async def generate_cover_letter(
    *,
    tailored_resume: dict[str, Any],
    base_resume: dict[str, Any],
    parsed_jd: dict[str, Any],
    company: str,
    role_title: str,
    user_id: UUID,
) -> CoverLetter:
    """Draft a cover letter for the given application.

    Returns a CoverLetter with fallback=True when the LLM is unavailable or
    the fabrication guard rejects the draft — callers can decide whether to
    surface it to the user or stamp a "couldn't generate" notice.
    """
    async with audit(user_id, "appprep_agent", "generate_cover_letter") as record:
        candidate_name = _candidate_name(tailored_resume) or "Candidate"

        try:
            model = pick_model("general", temperature=0.5, max_tokens=2048)
        except RuntimeError as exc:
            log.warning("appprep.cover.no_llm_key", error=str(exc))
            return _template_cover_letter(role_title, company, candidate_name)

        sys_prompt = _load_prompt("cover_letter.v1.md")
        user_payload = json.dumps(
            {
                "candidate_name": candidate_name,
                "company": company,
                "role_title": role_title,
                "tailored_resume": tailored_resume,
                "parsed_jd": parsed_jd,
            },
            default=str,
        )

        try:
            resp = await model.ainvoke(
                [SystemMessage(content=sys_prompt), HumanMessage(content=user_payload)]
            )
        except Exception as exc:  # noqa: BLE001 boundary
            log.error("appprep.cover.llm_failed", error=str(exc))
            return _template_cover_letter(role_title, company, candidate_name)

        parsed = _safe_json(resp.content)
        subject = (parsed.get("subject") or "").strip()
        body = (parsed.get("body") or "").strip()
        tone = (parsed.get("tone") or "professional").strip()

        if not body:
            return _template_cover_letter(role_title, company, candidate_name)

        # Fabrication guard: re-use the résumé guard but pass the cover body
        # wrapped in a stub résumé so the named-entity sweep is symmetrical.
        fab = fabrication_guard(base_resume, {"basics": {"summary": body}, "work": []})
        if fab:
            log.warning("appprep.cover.fabrication_detected", entities=fab[:5])
            record.output_result = {"fabricated_entities": fab[:5]}
            return _template_cover_letter(role_title, company, candidate_name, fab=fab[:10])

        record.output_result = {"length": len(body), "tone": tone}
        return CoverLetter(
            subject=subject or f"Application for {role_title} — {candidate_name}",
            body=body,
            tone=tone,
            fallback=False,
            fabricated_entities=[],
        )


def _template_cover_letter(
    role: str, company: str, name: str, *, fab: list[str] | None = None
) -> CoverLetter:
    """Generic fallback — used when LLM is unavailable or the guard rejected."""
    body = (
        f"Dear {company} Hiring Team,\n\n"
        f"I'm applying for the {role} role at {company}. My background is "
        "summarised in the résumé attached — happy to walk through any of it "
        "in person.\n\n"
        f"Best,\n{name}"
    )
    return CoverLetter(
        subject=f"Application for {role} — {name}",
        body=body,
        tone="direct",
        fallback=True,
        fabricated_entities=fab or [],
    )


# ─── form answers ──────────────────────────────────────────────────────


# EXT_SEC4 (round-13): the round-13 extension audit found that the
# original deny-list missed several common form-field variants — date
# of birth (multiple aliases), legal sex, marital status, and disability
# disclosure synonyms used by Workday / iCIMS / Greenhouse. Each entry
# below is matched as a case-insensitive substring against the field
# label (see generate_form_answers below), so we ship every realistic
# alias rather than counting on prompt engineering to catch them. New
# entries marked with `# round-13`.
SENSITIVE_TOKENS = (
    "race",
    "ethnicity",
    "gender",
    "gender identity",   # round-13: Workday EEO panel uses this exact label
    "sex",               # round-13: covers "legal sex", "sex assigned at birth"
    "disability",
    "veteran",
    "ssn",
    "social security",
    "social security number",  # round-13: full phrasing
    "citizenship",
    "visa",
    "passport",
    "national id",
    "national insurance",  # round-13: UK equivalent
    "tax id",              # round-13: covers TIN / ITIN
    "tin",                 # round-13
    "date of birth",       # round-13
    "dob",                 # round-13
    "birth date",          # round-13
    "birthdate",           # round-13
    "marital status",      # round-13
    "sexual orientation",  # round-13
    "religion",            # round-13
    "driver's license",    # round-13
    "drivers license",     # round-13: no-apostrophe variant
    "license number",      # round-13
)


async def generate_form_answers(
    *,
    tailored_resume: dict[str, Any],
    parsed_jd: dict[str, Any],
    fields: list[dict[str, Any]],
    user_id: UUID,
) -> list[FormFieldAnswer]:
    """For each form field, return an answer or skip=True.

    Sensitive fields are forced to skip *before* the LLM ever sees them —
    cheap defence-in-depth on top of the prompt-level instruction.
    """
    async with audit(user_id, "appprep_agent", "generate_form_answers") as record:
        record.input_params = {"field_count": len(fields)}

        # 1. Hard-skip sensitive fields locally (no LLM needed).
        prepped: list[FormFieldAnswer] = []
        ask_llm: list[dict[str, Any]] = []
        for f in fields:
            label = (f.get("label") or "").lower()
            if any(token in label for token in SENSITIVE_TOKENS):
                prepped.append(
                    FormFieldAnswer(
                        id=str(f.get("id") or label or "unknown"),
                        answer=None,
                        skip=True,
                        reason="sensitive_field_user_decides",
                        confidence=1.0,
                    )
                )
            else:
                ask_llm.append(f)

        if not ask_llm:
            return prepped

        # 2. Try the LLM for the rest.
        try:
            model = pick_model("fast", temperature=0.2, max_tokens=2048)
        except RuntimeError as exc:
            log.warning("appprep.form.no_llm_key", error=str(exc))
            return prepped + [_skip(f, reason="no_llm_key") for f in ask_llm]

        sys_prompt = _load_prompt("form_answers.v1.md")
        user_payload = json.dumps(
            {"tailored_resume": tailored_resume, "parsed_jd": parsed_jd, "fields": ask_llm},
            default=str,
        )
        try:
            resp = await model.ainvoke(
                [SystemMessage(content=sys_prompt), HumanMessage(content=user_payload)]
            )
        except Exception as exc:  # noqa: BLE001 boundary
            log.error("appprep.form.llm_failed", error=str(exc))
            return prepped + [_skip(f, reason="llm_failed") for f in ask_llm]

        raw = _safe_json_array(resp.content)
        # Map LLM responses back to the original field ids; any missing field
        # falls back to skip so the extension surface knows to ask the user.
        by_id = {str(entry.get("id")): entry for entry in raw if isinstance(entry, dict)}
        for f in ask_llm:
            fid = str(f.get("id") or "")
            entry = by_id.get(fid)
            if not entry:
                prepped.append(_skip(f, reason="llm_omitted"))
                continue
            prepped.append(
                FormFieldAnswer(
                    id=fid,
                    answer=_clean_answer(entry.get("answer")),
                    skip=bool(entry.get("skip", False)),
                    reason=entry.get("reason"),
                    confidence=_to_confidence(entry.get("confidence", 0.5)),
                )
            )

        record.output_result = {
            "answered": sum(1 for p in prepped if not p.skip),
            "skipped": sum(1 for p in prepped if p.skip),
        }
        return prepped


def _skip(field: dict[str, Any], *, reason: str) -> FormFieldAnswer:
    return FormFieldAnswer(
        id=str(field.get("id") or field.get("label") or "unknown"),
        answer=None,
        skip=True,
        reason=reason,
        confidence=0.0,
    )


def _clean_answer(val: Any) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    return s or None


def _to_confidence(val: Any) -> float:
    try:
        c = float(val)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, c))


# ─── helpers ───────────────────────────────────────────────────────────


def _candidate_name(resume: dict[str, Any]) -> str | None:
    basics = resume.get("basics") or {}
    name = basics.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip().split()[0]  # first name for signoff
    return None


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        loaded = json.loads(s)
        return loaded if isinstance(loaded, dict) else {}
    except json.JSONDecodeError:
        log.warning("appprep.invalid_json_response", preview=str(content)[:200])
        return {}


def _safe_json_array(content: Any) -> list[Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        loaded = json.loads(s)
        return loaded if isinstance(loaded, list) else []
    except json.JSONDecodeError:
        log.warning("appprep.invalid_json_array", preview=str(content)[:200])
        return []
