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
from uuid import UUID

import structlog

log = structlog.get_logger("agents.coordinator.user_brief")

# Caps to keep the system block under ~1500 chars in the common case.
_RESUME_HEADLINE_CHARS = 200
_APP_ROWS = 3
_WEAK_POINTS = 5
_PREFERENCES_CHARS = 400


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
        "reference it naturally when the user's request connects.)\n\n"
        + "\n\n".join(sections)
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
    content = r.get("content") or {}
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (ValueError, TypeError):
            content = {}

    basics = content.get("basics", {}) if isinstance(content, dict) else {}
    label = basics.get("label") or basics.get("name") or "(unnamed candidate)"
    summary = (basics.get("summary") or "").strip()
    summary = summary[:_RESUME_HEADLINE_CHARS]

    track = r.get("track") or ("base" if r.get("is_base") else "tailored")
    version = r.get("version")
    line = f"- Active résumé: {label} (v{version}, track={track})"
    if summary:
        line += f"\n  Summary: {summary}"
    return "### Résumé\n" + line


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
