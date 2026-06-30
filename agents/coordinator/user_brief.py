"""User brief — assembles a per-turn context block injected into the dock prompt.

Closes the P1-2 finding: the dock LLM had no idea who it was talking to.
Every turn started fresh — no memory of which résumé the user is iterating
on, which jobs they recently applied to, which interview weak points are
hot. So the model couldn't say "based on your last Stripe app…" because
it didn't know there WAS a last Stripe app.

This module produces ONE SystemMessage worth of compact, structured text
that ``ask_stream`` injects via ``extra_system_blocks`` before each
dock_turn. The block is regenerated per turn — cheap (one PG round-trip
across three small queries, all with LIMIT clauses) and avoids stale
context surviving across many turns.

Contents (in priority order):
  1. Active résumé summary — most-recent base + current branch headline
  2. Recent applications (last 3) — company, role, status, date
  3. Interview weak points — most-recent session's flagged items
  4. Career preferences — target roles, locations (from users.preferences)

Each section is "best-effort": if a query fails or returns nothing, the
section is omitted (not faked). The whole helper degrades to an empty
brief if RELAY_PG_DSN is absent, so unit tests stay hermetic.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import structlog

log = structlog.get_logger("agents.coordinator.user_brief")

# Caps to keep the system block under ~1500 chars in the common case.
_RESUME_HEADLINE_CHARS = 200
_APP_ROWS = 3
_WEAK_POINTS = 5
_PREFERENCES_CHARS = 400

# Résumé-body cap (D2): we now embed the top of the user's actual résumé
# (work + education + skills + projects) into the brief so the dock LLM can
# answer "看一下我的简历 / introduce me / analyze my résumé" directly,
# without needing a tool call. The cap keeps a typical résumé at ~1.5 KB of
# additional system context — heavy enough to be useful, light enough that
# the brief stays well under the dock model's 8K input budget.
_RESUME_BODY_BUDGET_CHARS = 1800
_RESUME_WORK_ENTRIES = 5
_RESUME_WORK_HIGHLIGHTS = 3
_RESUME_EDUCATION_ENTRIES = 3
_RESUME_SKILL_NAMES = 16
_RESUME_PROJECT_ENTRIES = 3
_RESUME_LINE_CHARS = 160


async def build_user_brief(user_id: UUID) -> str:
    """Return a compact user-context block for the dock system prompt.

    Returns an empty string when there's nothing useful to say (new user,
    no PG, all queries failed). The caller (``ask_stream``) passes it as
    an extra_system_block; an empty string is fine — extras filter empties.
    """
    sections: list[str] = []

    resume_section = await _resume_section(user_id)
    if resume_section:
        sections.append(resume_section)

    apps_section = await _apps_section(user_id)
    if apps_section:
        sections.append(apps_section)

    weak_section = await _weak_points_section(user_id)
    if weak_section:
        sections.append(weak_section)

    prefs_section = await _preferences_section(user_id)
    if prefs_section:
        sections.append(prefs_section)

    if not sections:
        return ""

    return (
        "## What you remember about this user\n\n"
        "(This is read-only context. Don't paraphrase it back verbatim — "
        "reference it naturally when the user's request connects.)\n\n" + "\n\n".join(sections)
    )


# ─────────────────────────────────────────────────────────────────────
# Section builders — each is independent and absorbs its own failures.
# ─────────────────────────────────────────────────────────────────────


async def _resume_section(user_id: UUID) -> str:
    from agents.tools.auto import pg_query

    # NB: `resumes` only has `created_at` (no updated_at / deleted_at — see
    # infra/postgres/migrations/004_resumes.sql + 017_dual_track). Soft-delete
    # lives at the file layer (`user_files.deleted_at`), not on the résumé row.
    try:
        rows = await pg_query(
            """
            SELECT id, version, content, track, is_base, created_at
            FROM resumes
            WHERE user_id = %s
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (str(user_id),),
        )
    except Exception as exc:  # noqa: BLE001 — degrade silently
        log.warning("user_brief.resume_query_failed", error=str(exc))
        return ""

    if not rows:
        return ""
    r = rows[0]
    content = _coerce_json_resume(r.get("content"))

    basics = content.get("basics", {}) if isinstance(content, dict) else {}
    label = basics.get("label") or basics.get("name") or "(unnamed candidate)"
    summary = (basics.get("summary") or "").strip()
    summary = summary[:_RESUME_HEADLINE_CHARS]

    track = r.get("track") or ("base" if r.get("is_base") else "tailored")
    version = r.get("version")

    lines: list[str] = ["### Résumé"]
    lines.append(f"- Active résumé: {label} (v{version}, track={track})")
    if summary:
        lines.append(f"  Summary: {summary}")

    # Body sections (D2): work / education / skills / projects. Each section
    # is appended only if the total brief résumé block is still under
    # _RESUME_BODY_BUDGET_CHARS — we stop adding lines (not whole sections)
    # the moment we'd blow the cap, so the agent always gets *something*
    # rather than going over budget. The exact ordering reflects what a
    # human reader cares about most when answering "show me my résumé":
    # what jobs they've held, then where they studied, then concrete skills,
    # then projects.
    used = sum(len(line) for line in lines)

    def remaining() -> int:
        return _RESUME_BODY_BUDGET_CHARS - used

    def push(text: str) -> bool:
        nonlocal used
        if not text:
            return True
        if len(text) + 1 > remaining():
            return False
        lines.append(text)
        used += len(text) + 1
        return True

    work_lines = _format_work(content)
    if work_lines:
        if not push("**Experience**"):
            return "\n".join(lines)
        for ln in work_lines:
            if not push(ln):
                break

    edu_lines = _format_education(content)
    if edu_lines:
        if not push("**Education**"):
            return "\n".join(lines)
        for ln in edu_lines:
            if not push(ln):
                break

    skill_line = _format_skills(content)
    if skill_line:
        push(f"**Skills**: {skill_line}")

    project_lines = _format_projects(content)
    if project_lines:
        if not push("**Projects**"):
            return "\n".join(lines)
        for ln in project_lines:
            if not push(ln):
                break

    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────
# Résumé content helpers
# ─────────────────────────────────────────────────────────────────────

def _coerce_json_resume(raw: Any) -> dict[str, Any]:
    """Accept the two known shapes and return a plain JSON Resume dict.

    Storage in ``resumes.content`` is heterogeneous:
      - new uploads: ``{raw, parsed: <JSON Resume>, markdown, parsedAt, warnings}``
      - synthesised / tailored: plain JSON Resume at the root
      - legacy / fixtures: occasionally a JSON-encoded string of either of
        the above.
    We always work in the "plain" shape downstream, so unwrap once here.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    if not isinstance(raw, dict):
        return {}
    # ``parsed`` wrapper from the uploader. Prefer the parsed payload when
    # both ``parsed`` and ``basics`` are present (the parser always promotes
    # basics under parsed; a root-level basics is the plain shape).
    parsed = raw.get("parsed")
    if isinstance(parsed, dict) and "basics" not in raw:
        return parsed
    return raw


def _clip(text: Any, cap: int = _RESUME_LINE_CHARS) -> str:
    s = (str(text) if text is not None else "").strip()
    if not s:
        return ""
    s = " ".join(s.split())
    return s[: cap - 1] + "…" if len(s) > cap else s


def _year(iso_date: Any) -> str:
    """Take an ISO date / year and return just the year. ``"Present"`` passes through."""
    if not iso_date:
        return ""
    s = str(iso_date).strip()
    if not s:
        return ""
    if s.lower() in {"present", "current", "now"}:
        return "Present"
    return s[:4]


def _format_work(content: dict[str, Any]) -> list[str]:
    work = content.get("work") if isinstance(content, dict) else None
    if not isinstance(work, list):
        return []
    out: list[str] = []
    for entry in work[:_RESUME_WORK_ENTRIES]:
        if not isinstance(entry, dict):
            continue
        # JSON Resume's `name` is the company; some uploaders use `company`.
        company = entry.get("name") or entry.get("company") or "(unknown)"
        position = entry.get("position") or entry.get("title") or "(role)"
        start = _year(entry.get("startDate"))
        end = _year(entry.get("endDate")) or "Present"
        dates = f"{start}–{end}" if start else end
        head = _clip(f"- {position} @ {company} ({dates})")
        if head:
            out.append(head)
        highlights = entry.get("highlights")
        if isinstance(highlights, list):
            for h in highlights[:_RESUME_WORK_HIGHLIGHTS]:
                bullet = _clip(h)
                if bullet:
                    out.append(f"    • {bullet}")
        elif isinstance(entry.get("summary"), str):
            bullet = _clip(entry["summary"])
            if bullet:
                out.append(f"    • {bullet}")
    return out


def _format_education(content: dict[str, Any]) -> list[str]:
    edu = content.get("education") if isinstance(content, dict) else None
    if not isinstance(edu, list):
        return []
    out: list[str] = []
    for entry in edu[:_RESUME_EDUCATION_ENTRIES]:
        if not isinstance(entry, dict):
            continue
        institution = entry.get("institution") or entry.get("school") or "(unknown)"
        # JSON Resume calls this `studyType` (BS/MS), `area` is the major.
        study = entry.get("studyType") or entry.get("degree") or ""
        area = entry.get("area") or entry.get("major") or ""
        start = _year(entry.get("startDate"))
        end = _year(entry.get("endDate")) or "Present"
        dates = f"{start}–{end}" if start else end
        bits = [b for b in (study, area) if b]
        head = f"- {institution} — {' '.join(bits)} ({dates})" if bits else f"- {institution} ({dates})"
        clipped = _clip(head)
        if clipped:
            out.append(clipped)
    return out


def _format_skills(content: dict[str, Any]) -> str:
    skills = content.get("skills") if isinstance(content, dict) else None
    if not isinstance(skills, list):
        return ""
    names: list[str] = []
    for s in skills:
        if isinstance(s, dict):
            n = s.get("name")
        else:
            n = s
        if isinstance(n, str) and n.strip():
            names.append(n.strip())
        if len(names) >= _RESUME_SKILL_NAMES:
            break
    return ", ".join(names)


def _format_projects(content: dict[str, Any]) -> list[str]:
    projects = content.get("projects") if isinstance(content, dict) else None
    if not isinstance(projects, list):
        return []
    out: list[str] = []
    for p in projects[:_RESUME_PROJECT_ENTRIES]:
        if not isinstance(p, dict):
            continue
        name = p.get("name") or "(unnamed project)"
        desc = p.get("description") or p.get("summary") or ""
        head = f"- {name}" + (f" — {desc}" if desc else "")
        clipped = _clip(head)
        if clipped:
            out.append(clipped)
    return out


async def _apps_section(user_id: UUID) -> str:
    from agents.tools.auto import pg_query

    try:
        rows = await pg_query(
            """
            SELECT a.id, a.status, a.submitted_at, a.outcome,
                   j.company, j.role_title
            FROM application_drafts a
            LEFT JOIN jobs j ON j.id = a.job_id
            WHERE a.user_id = %s
            ORDER BY COALESCE(a.submitted_at, a.created_at) DESC
            LIMIT %s
            """,
            (str(user_id), _APP_ROWS),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("user_brief.apps_query_failed", error=str(exc))
        return ""
    if not rows:
        return ""

    lines = ["### Recent applications"]
    for r in rows:
        company = r.get("company") or "(unknown company)"
        role = r.get("role_title") or "(unknown role)"
        status = r.get("status") or "draft"
        outcome = r.get("outcome")
        when = r.get("submitted_at")
        bits = [f"{company} — {role}", f"status={status}"]
        if outcome:
            bits.append(f"outcome={outcome}")
        if when:
            if hasattr(when, "year"):
                bits.append(f"date={when:%Y-%m-%d}")
            else:
                bits.append(f"date={when}")
        lines.append("- " + " · ".join(bits))
    return "\n".join(lines)


async def _weak_points_section(user_id: UUID) -> str:
    from agents.tools.auto import pg_query

    try:
        rows = await pg_query(
            """
            SELECT weak_points, completed_at
            FROM interview_sessions
            WHERE user_id = %s
              AND weak_points IS NOT NULL
            ORDER BY COALESCE(completed_at, created_at) DESC
            LIMIT 1
            """,
            (str(user_id),),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("user_brief.weak_query_failed", error=str(exc))
        return ""
    if not rows:
        return ""

    weak = rows[0].get("weak_points") or []
    if isinstance(weak, str):
        try:
            weak = json.loads(weak)
        except (ValueError, TypeError):
            weak = []
    if not isinstance(weak, list) or not weak:
        return ""

    items: list[str] = []
    for w in weak[:_WEAK_POINTS]:
        if not isinstance(w, dict):
            continue
        skill = w.get("skill") or w.get("topic") or "(unspecified)"
        conf = w.get("confidence")
        if isinstance(conf, (int, float)):
            items.append(f"- {skill} (confidence {conf:.0%})")
        else:
            items.append(f"- {skill}")
    if not items:
        return ""
    return "### Interview weak points (most recent session)\n" + "\n".join(items)


async def _preferences_section(user_id: UUID) -> str:
    from agents.tools.auto import pg_query

    try:
        rows = await pg_query(
            "SELECT preferences FROM users WHERE id = %s",
            (str(user_id),),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("user_brief.prefs_query_failed", error=str(exc))
        return ""
    if not rows:
        return ""

    prefs = rows[0].get("preferences") or {}
    if isinstance(prefs, str):
        try:
            prefs = json.loads(prefs)
        except (ValueError, TypeError):
            prefs = {}
    if not isinstance(prefs, dict) or not prefs:
        return ""

    bits: list[str] = []
    target_roles = prefs.get("target_roles")
    if isinstance(target_roles, list) and target_roles:
        bits.append("target roles: " + ", ".join(str(t) for t in target_roles[:5]))
    locations = prefs.get("locations")
    if isinstance(locations, list) and locations:
        bits.append("locations: " + ", ".join(str(loc) for loc in locations[:3]))
    if prefs.get("remote") is True:
        bits.append("remote OK")
    skills = prefs.get("skills")
    if isinstance(skills, list) and skills:
        bits.append("core skills: " + ", ".join(str(s) for s in skills[:8]))
    if not bits:
        return ""
    text = " · ".join(bits)
    if len(text) > _PREFERENCES_CHARS:
        text = text[: _PREFERENCES_CHARS - 1] + "…"
    return "### Preferences\n- " + text
