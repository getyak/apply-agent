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

import hashlib
import json
import re
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.events.bus import publish
from agents.harness.audit import audit
from agents.harness.llm import pick_model
from agents.nodes import resume_store
from agents.tools.auto import redis_get, redis_setex
from agents.tools.notify import save_resume_version

log = structlog.get_logger("agents.nodes.resume")

PROMPT_DIR = Path(__file__).parent.parent / "prompts" / "resume"


def _load_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


def intake(base_resume_id: UUID, user_id: UUID):  # type: ignore[no-untyped-def]
    """Re-export of the Resume Intake Agent action (design §12).

    Lives in resume_intake.py to keep this file under the 800-line ceiling.
    Imported lazily to avoid a circular import (resume_intake imports this
    module for the shared fabrication / optimize helpers). Returns the
    coroutine so callers ``await resume_agent.intake(...)`` unchanged.
    """
    from agents.nodes.resume_intake import intake as _intake

    return _intake(base_resume_id, user_id)


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
        # P1-5: also emit resume:tailored so the dock-nudge consumer can
        # plant a follow-up suggestion ("now prepare a submission packet?").
        # Distinct topic from generic "updated" because we want this specific
        # signal to trigger downstream actions only on tailoring (not on
        # base edits or proofreader sweeps).
        await publish(
            "resume:tailored",
            {
                "user_id": str(user_id),
                "version": new_version,
                "resume_id": str(new_id),
                "job_id": str(job_id),
            },
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


def _tokenize(text: str) -> set[str]:
    """Lowercase + extract word tokens (≥ 3 chars) for set-overlap checks."""
    return {w for w in re.findall(r"[A-Za-z][A-Za-z0-9+#.\-]{2,}", text.lower())}


def fabrication_guard(base: dict[str, Any], tailored: dict[str, Any]) -> list[str]:
    """Return a list of entities present in `tailored` but not in `base`.

    P2-2 upgrade: company/title checks switched from naive substring
    membership (false-positive on "Stripe" vs "Stripe Capital", false-
    negative on "Anthropic" vs "anthropic.com") to *token-set* overlap.
    A company is considered grounded when ALL its content tokens are
    present in the base's token set. Quantitative entities (year, %,
    money, number > 100) still use exact substring as the conservative
    fall-back — those need verbatim presence.

    Entities checked: company names, titles, years, percentages, monetary
    values, headcount numbers. Empty list = OK.
    """
    base_text = _flatten_text(base).lower()
    base_tokens = _tokenize(base_text)

    fabricated: list[str] = []

    # 1. Company names + titles — token-set check.
    for work in tailored.get("work", []):
        name = (work.get("name") or work.get("company") or "").strip()
        if name:
            name_tokens = _tokenize(name)
            if name_tokens and not name_tokens.issubset(base_tokens):
                fabricated.append(f"company:{name}")
        position = (work.get("position") or "").strip()
        if position:
            pos_tokens = _tokenize(position)
            if pos_tokens and not pos_tokens.issubset(base_tokens):
                fabricated.append(f"position:{position}")

    # 2. Quantitative entities anywhere in tailored — these MUST appear
    #    verbatim in the base. Token overlap is too loose for numbers
    #    (5% and 50% would both pass against "5").
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
# bullet stable IDs — the physical basis of vibe (design §4.3)
# ───────────────────────────────────────────────────────────────────────


def assign_bullet_ids(parsed_resume: dict[str, Any]) -> dict[str, Any]:
    """Pin a stable id to every work[].highlights[] entry.

    Returns the bullet_index map { "<stable_id>": {path, text_hash,
    anchor_text} }. IDs are assigned once (on the original) and carried
    forward by optimized / tailored versions so a bullet can be tracked across
    rewrites even when the LLM reshuffles the array order.
    """
    index: dict[str, Any] = {}
    for i, work in enumerate(parsed_resume.get("work", []) or []):
        highlights = work.get("highlights", []) or []
        for j, highlight in enumerate(highlights):
            text = highlight if isinstance(highlight, str) else str(highlight)
            stable_id = f"b_{uuid4().hex[:8]}"
            index[stable_id] = {
                "path": f"work.{i}.highlights.{j}",
                "text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16],
                "anchor_text": text[:64],
            }
    return index


def _find_bullet(parsed: dict[str, Any], bullet_index: dict[str, Any], stable_id: str) -> str | None:
    """Resolve a stable_id back to current bullet text.

    Tries the recorded path first; falls back to anchor_text fuzzy match if the
    LLM reshuffled the array (design §10 Q3). Returns None if unresolvable.
    """
    entry = (bullet_index or {}).get(stable_id)
    if not entry:
        return None
    expected_hash = entry.get("text_hash")
    path = entry.get("path", "")
    m = re.match(r"work\.(\d+)\.highlights\.(\d+)", path)
    if m:
        wi, hi = int(m.group(1)), int(m.group(2))
        try:
            cur = parsed["work"][wi]["highlights"][hi]
            cur = cur if isinstance(cur, str) else str(cur)
            # The path is only trustworthy if the text there still hashes to
            # what we recorded. If the LLM reshuffled highlights, the slot now
            # holds a DIFFERENT bullet — fall through to the fuzzy anchor match
            # rather than silently returning the wrong line (design §10 Q3).
            if not expected_hash or _hash16(cur) == expected_hash:
                return cur
        except (KeyError, IndexError, TypeError):
            pass
    # fuzzy fallback on anchor_text
    anchor = (entry.get("anchor_text") or "").strip().lower()
    if anchor:
        for work in parsed.get("work", []) or []:
            for h in work.get("highlights", []) or []:
                ht = h if isinstance(h, str) else str(h)
                if ht.strip().lower().startswith(anchor[:32]):
                    return ht
    return None


def _hash16(text: str) -> str:
    """16-char sha256 prefix — mirrors assign_bullet_ids's text_hash."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# ───────────────────────────────────────────────────────────────────────
# propose_similar_bullets — context-flywheel reproposal (design §6.4 / §9 P2-9)
# ───────────────────────────────────────────────────────────────────────


async def propose_similar_bullets(
    source_resume_id: UUID, user_id: UUID, change_type: str | None = None
) -> dict[str, Any]:
    """After a user accepts a suggestion, look for OTHER bullets that could take
    the same kind of improvement and propose them (status='proposed', never
    auto-applied — the user opted into one change, not a sweep).

    Skips bullets that already have a proposed/accepted suggestion so we never
    re-nag about the same line. Returns {ok, proposed: [...]}.
    """
    async with audit(user_id, "resume_agent", "propose_similar_bullets"):
        row = await resume_store.get_resume(source_resume_id, user_id)
        if not row:
            return {"ok": False, "reason": "resume_not_found"}
        parsed = resume_store.unwrap_parsed(row["content"])
        if not parsed.get("work"):
            return {"ok": True, "proposed": []}
        bullet_index = row.get("bullet_index") or assign_bullet_ids(parsed)

        # Bullets we've already touched — don't re-propose against them.
        existing = await resume_store.list_suggestions(user_id, source_resume_id)
        seen_before = {
            (s.get("before_text") or "").strip()
            for s in existing
            if s.get("status") in ("proposed", "accepted")
        }

        raw = await _run_optimize_general(parsed, bullet_index)
        candidates = _validate_suggestions(parsed, raw)
        fresh = [
            s
            for s in candidates
            if s["before_text"].strip() not in seen_before
            and (change_type is None or s["change_type"] == change_type)
        ]
        if not fresh:
            return {"ok": True, "proposed": []}
        stored = await resume_store.insert_suggestions(
            user_id, source_resume_id, fresh, proposed_by="flywheel"
        )
        return {"ok": True, "proposed": stored}


# ───────────────────────────────────────────────────────────────────────
# optimize_general — no-JD best-practice pass → suggestion stack (design §6.1)
# ───────────────────────────────────────────────────────────────────────


async def optimize_general(base_resume_id: UUID, user_id: UUID) -> dict[str, Any]:
    """Generic optimization (no JD). Produces bullet-level *suggestions*, not a
    full replacement document. Auto-applies the 'safe' ones into an optimized
    sibling; leaves 'needs_review' / 'unsupported' as proposed for HITL.

    Returns {ok, suggestions, optimized_resume_id?, optimized_version?}.
    """
    async with audit(user_id, "resume_agent", "optimize_general"):
        row = await resume_store.get_resume(base_resume_id, user_id)
        if not row:
            return {"ok": False, "reason": "resume_not_found"}
        parsed = resume_store.unwrap_parsed(row["content"])
        if not parsed.get("work"):
            return {"ok": True, "suggestions": [], "reason": "nothing_to_optimize"}

        # Ensure the source has a bullet_index (originals predating 017 won't).
        bullet_index = row.get("bullet_index") or assign_bullet_ids(parsed)
        if not row.get("bullet_index"):
            await resume_store.set_bullet_index(base_resume_id, user_id, bullet_index)

        raw = await _run_optimize_general(parsed, bullet_index)
        suggestions = _validate_suggestions(parsed, raw)
        if not suggestions:
            return {"ok": True, "suggestions": []}

        stored = await resume_store.insert_suggestions(
            user_id, base_resume_id, suggestions, proposed_by="optimize_general"
        )

        # Auto-apply 'safe' suggestions into an optimized sibling (design §6.2).
        safe = [s for s in stored if s["risk_level"] == "safe"]
        optimized_id = optimized_version = None
        if safe:
            applied = _apply_suggestions_to_parsed(parsed, safe)
            fab = fabrication_guard(parsed, applied)
            if not fab:  # never auto-write a fabrication
                optimized_id, optimized_version = await save_resume_version(
                    user_id=user_id,
                    content_json=applied,
                    parent_version_id=base_resume_id,
                    tailored_for_job=None,
                    is_base=False,
                    track="optimized",
                    bullet_index=bullet_index,
                )
                for s in safe:
                    await resume_store.set_suggestion_status(
                        UUID(s["id"]), user_id, "accepted", decided_via="auto"
                    )
                await publish(
                    "resume:updated",
                    {"user_id": str(user_id), "version": optimized_version,
                     "resume_id": str(optimized_id)},
                )

        return {
            "ok": True,
            "suggestions": stored,
            "optimized_resume_id": str(optimized_id) if optimized_id else None,
            "optimized_version": optimized_version,
        }


async def _run_optimize_general(
    parsed: dict[str, Any], bullet_index: dict[str, Any]
) -> dict[str, Any]:
    model = pick_model("general", temperature=0.3, max_tokens=4096)
    prompt = _load_prompt("optimize_general.v1.md")
    payload = {"resume": parsed, "bullet_index": bullet_index}
    resp = await model.ainvoke(
        [SystemMessage(content=prompt),
         HumanMessage(content=json.dumps(payload, ensure_ascii=False)[:24_000])]
    )
    return _safe_json(resp.content)


def _validate_suggestions(
    parsed: dict[str, Any], raw: dict[str, Any]
) -> list[dict[str, Any]]:
    """Coerce + risk-annotate model output into clean suggestion records.

    Reuses change_log_guard's vocabulary: a 'safe' change_type whose after_text
    introduces no new quantitative token (vs the whole base résumé) stays safe;
    anything else is pushed to needs_review / unsupported. This is the
    fabrication red line applied per-bullet (design §7.1).
    """
    base_text = _flatten_text(parsed).lower()
    items = raw.get("suggestions") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        change_type = (entry.get("change_type") or "").strip()
        before = (entry.get("before_text") or "").strip()
        after = (entry.get("after_text") or "").strip()
        if not change_type or not after or not before:
            continue
        if change_type in _REVIEW_CHANGE_TYPES:
            risk = "needs_review"
        elif change_type in _SAFE_CHANGE_TYPES:
            risk = "needs_review" if _has_new_quantitative_token(after, base_text) else "safe"
        else:
            risk = "unsupported"
        out.append({
            "bullet_stable_id": entry.get("bullet_stable_id"),
            "section": entry.get("section") or "work",
            "change_type": change_type,
            "before_text": before,
            "after_text": after,
            "rationale": entry.get("rationale"),
            "risk_level": risk,
        })
    return out


def _apply_suggestions_to_parsed(
    parsed: dict[str, Any], suggestions: list[dict[str, Any]]
) -> dict[str, Any]:
    """Return a new parsed résumé with each suggestion's after_text swapped in.

    Immutability-friendly: deep-copies, never mutates the input. Matches a
    bullet by exact before_text within work[].highlights[]; unmatched
    suggestions are skipped (the safe set should always match).
    """
    new = json.loads(json.dumps(parsed))  # cheap deep copy
    by_before = {s["before_text"].strip(): s["after_text"] for s in suggestions}
    for work in new.get("work", []) or []:
        highlights = work.get("highlights", []) or []
        for idx, h in enumerate(highlights):
            ht = h if isinstance(h, str) else str(h)
            repl = by_before.get(ht.strip())
            if repl is not None:
                highlights[idx] = repl
    # summary-level suggestions (no bullet match) — apply to basics.summary
    for s in suggestions:
        if (s.get("section") == "summary"
                and new.get("basics", {}).get("summary", "").strip() == s["before_text"].strip()):
            new["basics"]["summary"] = s["after_text"]
    return new


# ───────────────────────────────────────────────────────────────────────
# apply_suggestions — materialize accepted suggestions into a version (§6.1)
# ───────────────────────────────────────────────────────────────────────


async def apply_suggestions(
    suggestion_ids: list[UUID], user_id: UUID, target_track: str = "optimized"
) -> dict[str, Any]:
    """Materialize a set of suggestions into a new optimized version and mark
    them accepted. Idempotent-ish: re-applying already-accepted suggestions
    just produces another version (the UI guards against double-clicks)."""
    async with audit(user_id, "resume_agent", "apply_suggestions"):
        recs = []
        source_id: UUID | None = None
        for sid in suggestion_ids:
            rec = await resume_store.get_suggestion(sid, user_id)
            if rec:
                recs.append(rec)
                source_id = UUID(rec["source_resume_id"])
        if not recs or source_id is None:
            return {"ok": False, "reason": "no_valid_suggestions"}

        base = await resume_store.get_resume(source_id, user_id)
        if not base:
            return {"ok": False, "reason": "source_resume_not_found"}
        parsed = resume_store.unwrap_parsed(base["content"])
        applied = _apply_suggestions_to_parsed(parsed, recs)

        fab = fabrication_guard(parsed, applied)
        if fab:
            return {"ok": False, "reason": "fabrication_guard_failed", "fabricated": fab}

        new_id, new_version = await save_resume_version(
            user_id=user_id,
            content_json=applied,
            parent_version_id=source_id,
            tailored_for_job=None,
            is_base=False,
            track=target_track,
            bullet_index=base.get("bullet_index"),
        )
        for rec in recs:
            await resume_store.set_suggestion_status(
                UUID(rec["id"]), user_id, "accepted", decided_via="studio_panel"
            )
        await publish(
            "resume:updated",
            {"user_id": str(user_id), "version": new_version, "resume_id": str(new_id)},
        )
        # Context-flywheel trigger (design §6.4 / §9 P2-9): each acceptance is a
        # signal. Emit one event per accepted suggestion so the trend consumer
        # can re-propose similar bullets ("you just made this active-voice — want
        # the other 5 like it?"). Fire-and-forget; never block the write.
        for rec in recs:
            await publish(
                "resume:suggestion_accepted",
                {
                    "user_id": str(user_id),
                    "source_resume_id": str(source_id),
                    "change_type": rec.get("change_type"),
                    "bullet_stable_id": rec.get("bullet_stable_id"),
                },
            )
        return {"ok": True, "resume_id": str(new_id), "version": new_version}


# ───────────────────────────────────────────────────────────────────────
# propose_bullet_edit — vibe chat on ONE bullet (design §6.1, §6.3)
# ───────────────────────────────────────────────────────────────────────


async def propose_bullet_edit(
    resume_id: UUID, bullet_stable_id: str, instruction: str, user_id: UUID
) -> dict[str, Any]:
    """Revise one bullet from a natural-language instruction. Returns ONE
    proposed suggestion (or ok=False if the bullet can't be resolved / the
    edit would fabricate)."""
    async with audit(user_id, "resume_agent", "propose_bullet_edit"):
        row = await resume_store.get_resume(resume_id, user_id)
        if not row:
            return {"ok": False, "reason": "resume_not_found"}
        parsed = resume_store.unwrap_parsed(row["content"])
        bullet_index = row.get("bullet_index") or {}
        bullet_text = _find_bullet(parsed, bullet_index, bullet_stable_id)
        if bullet_text is None:
            return {"ok": False, "reason": "bullet_not_found"}

        model = pick_model("fast", temperature=0.3, max_tokens=1024)
        prompt = _load_prompt("propose_bullet_edit.v1.md")
        payload = {
            "bullet_text": bullet_text,
            "instruction": instruction,
            "resume_context": _flatten_text(parsed)[:4000],
        }
        resp = await model.ainvoke(
            [SystemMessage(content=prompt),
             HumanMessage(content=json.dumps(payload, ensure_ascii=False))]
        )
        edit = _safe_json(resp.content)
        after = (edit.get("after_text") or "").strip()
        if not after:
            return {"ok": False, "reason": "no_edit", "note": edit.get("note")}

        # Per-bullet fabrication check: no new quantitative token vs base.
        base_text = _flatten_text(parsed).lower()
        if _has_new_quantitative_token(after, base_text):
            risk = "needs_review"
        else:
            change_type = (edit.get("change_type") or "tighten").strip()
            risk = "safe" if change_type in _SAFE_CHANGE_TYPES else "needs_review"

        suggestion = {
            "bullet_stable_id": bullet_stable_id,
            "section": "work",
            "change_type": (edit.get("change_type") or "tighten").strip(),
            "before_text": bullet_text,
            "after_text": after,
            "rationale": edit.get("rationale"),
            "risk_level": risk,
        }
        stored = await resume_store.insert_suggestions(
            user_id, resume_id, [suggestion], proposed_by="vibe_chat"
        )
        return {"ok": True, "suggestion": stored[0] if stored else suggestion,
                "note": edit.get("note")}


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
