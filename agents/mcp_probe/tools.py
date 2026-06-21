"""MCP tool implementations — thin wrappers over Relay capabilities.

Probe scope (see docs/architecture/agent-marketplace-deferred.md § 4.2):
- 0 changes to jobmatch_agent / resume_agent (we IMPORT, not modify)
- no auth layer (probe trusts local stdio transport)
- no @requires_approval level tools (no submit_form, no send_email)
- reuses PG 5433 / Redis 6380 when RELAY_MCP_PROBE_FAKE is unset

Tool surface:
    search_jobs(query, user_id?)              → {"jobs": [...]}
    tailor_resume(base_resume_id, jd_id, user_id) → {"tailored":..., "fabricated":[...]}

E2E mode (RELAY_MCP_PROBE_FAKE=1):
    Tools run against in-memory fixtures so the probe can be exercised in CI
    without PG / Redis / OpenRouter. The fabrication_guard from resume_agent
    is still invoked on the fake path — that's the whole point of running it.
"""
from __future__ import annotations

import os
from typing import Any
from uuid import UUID

# Lazy imports inside functions keep `import agents.mcp_probe.tools` cheap
# and side-effect free (smoke test asserts this).


# ─── fake fixtures (RELAY_MCP_PROBE_FAKE=1) ──────────────────────────────

_FAKE_JOBS: list[dict[str, Any]] = [
    {
        "id": "00000000-0000-0000-0000-000000000a01",
        "company": "Stripe",
        "role_title": "Senior Backend Engineer",
        "url": "https://example.test/stripe/jobs/a01",
        "parsed": {"skills": ["Python", "PostgreSQL", "Distributed Systems"]},
    },
    {
        "id": "00000000-0000-0000-0000-000000000a02",
        "company": "Linear",
        "role_title": "Backend Engineer (Infra)",
        "url": "https://example.test/linear/jobs/a02",
        "parsed": {"skills": ["TypeScript", "PostgreSQL", "GraphQL"]},
    },
    {
        "id": "00000000-0000-0000-0000-000000000a03",
        "company": "Anthropic",
        "role_title": "Frontend Engineer",
        "url": "https://example.test/anthropic/jobs/a03",
        "parsed": {"skills": ["React", "TypeScript", "Accessibility"]},
    },
]

_FAKE_BASE_RESUME: dict[str, Any] = {
    "basics": {"name": "Alex Doe", "email": "alex@example.test"},
    "work": [
        {
            "name": "Acme Corp",
            "position": "Senior Backend Engineer",
            "startDate": "2021-01",
            "endDate": "2024-06",
            "highlights": [
                "Owned the billing service migration from MySQL to PostgreSQL.",
                "Led an on-call rotation of 6 engineers covering a 99.95% SLO.",
            ],
        }
    ],
    "skills": [{"name": "Python"}, {"name": "PostgreSQL"}, {"name": "Distributed Systems"}],
}


def _is_fake_mode() -> bool:
    return os.environ.get("RELAY_MCP_PROBE_FAKE") == "1"


# ─── search_jobs ─────────────────────────────────────────────────────────


async def search_jobs(query: str, user_id: str | None = None) -> dict[str, Any]:
    """Search canonicalized jobs by free-text title / skill query.

    Real mode: SELECT id, company, role_title, url, parsed FROM jobs
               WHERE role_title ILIKE %s OR parsed::text ILIKE %s LIMIT 20.
    Fake mode (RELAY_MCP_PROBE_FAKE=1): returns matches from _FAKE_JOBS.

    Args:
        query: free-text, matched against role_title and parsed.skills.
        user_id: reserved for future scoring; ignored in the probe.

    Returns:
        {"jobs": [{"id","company","role_title","url","skills"}, ...]}
    """
    _ = user_id  # reserved for future per-user scoring
    needle = query.strip().lower()
    if not needle:
        return {"jobs": []}

    if _is_fake_mode():
        rows = [
            {
                "id": j["id"],
                "company": j["company"],
                "role_title": j["role_title"],
                "url": j["url"],
                "skills": j["parsed"].get("skills", []),
            }
            for j in _FAKE_JOBS
            if needle in j["role_title"].lower()
            or any(needle in s.lower() for s in j["parsed"].get("skills", []))
        ]
        return {"jobs": rows[:20]}

    return await _search_jobs_real(needle)


async def _search_jobs_real(needle: str) -> dict[str, Any]:
    """Live PG path — only imported when not in fake mode."""
    import json

    import psycopg  # type: ignore

    dsn = os.environ.get(
        "RELAY_PG_DSN",
        "postgresql://relay:relay@localhost:5433/relay",
    )
    pattern = f"%{needle}%"
    async with await psycopg.AsyncConnection.connect(dsn) as conn:  # type: ignore[arg-type]
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, company, role_title, url, parsed
                FROM jobs
                WHERE role_title ILIKE %s
                   OR parsed::text ILIKE %s
                ORDER BY posted_date DESC NULLS LAST
                LIMIT 20
                """,
                (pattern, pattern),
            )
            rows = await cur.fetchall()
    out: list[dict[str, Any]] = []
    for jid, company, role, url, parsed in rows:
        parsed_obj = parsed if isinstance(parsed, dict) else json.loads(parsed or "{}")
        out.append(
            {
                "id": str(jid),
                "company": company,
                "role_title": role,
                "url": url,
                "skills": parsed_obj.get("skills", []),
            }
        )
    return {"jobs": out}


# ─── tailor_resume ───────────────────────────────────────────────────────


async def tailor_resume(
    base_resume_id: str, jd_id: str, user_id: str
) -> dict[str, Any]:
    """Tailor a base résumé for a JD, with fabrication_guard always on.

    Fake mode produces a deterministic "tailored" résumé by reversing the
    base highlights — guaranteed to pass fabrication_guard (same entities).
    Real mode delegates to resume_agent.customize, which runs the guard up
    to 3 attempts and writes a new version row.

    Returns:
        ok=True:  {"ok": True, "tailored": <JSON Resume>, "fabricated": [],
                   "version": int, "via": "fake"|"real", ...}
        ok=False: {"ok": False, "reason": "fabrication_guard_failed"|...,
                   "fabricated": [...], "via": "fake"|"real"}
    """
    if _is_fake_mode():
        return _tailor_resume_fake(base_resume_id, jd_id, user_id)
    return await _tailor_resume_real(base_resume_id, jd_id, user_id)


def _tailor_resume_fake(base_resume_id: str, jd_id: str, user_id: str) -> dict[str, Any]:
    """Deterministic fake — must still pass fabrication_guard.

    We import fabrication_guard from the real module so the e2e proves the
    probe never bypasses the vision.md red line, even on the fake path.
    """
    from agents.nodes.resume_agent import fabrication_guard

    base = _FAKE_BASE_RESUME
    # Tailored = same entities, highlights reversed. fabrication_guard MUST pass.
    tailored = {
        "basics": dict(base["basics"]),
        "work": [
            {**w, "highlights": list(reversed(w.get("highlights", [])))}
            for w in base["work"]
        ],
        "skills": list(base["skills"]),
    }
    fab = fabrication_guard(base, tailored)
    if fab:
        return {
            "ok": False,
            "reason": "fabrication_guard_failed",
            "fabricated": fab,
            "via": "fake",
            "base_resume_id": base_resume_id,
            "jd_id": jd_id,
            "user_id": user_id,
        }
    return {
        "ok": True,
        "tailored": tailored,
        "fabricated": [],
        "version": 0,
        "via": "fake",
        "base_resume_id": base_resume_id,
        "jd_id": jd_id,
        "user_id": user_id,
    }


async def _tailor_resume_real(
    base_resume_id: str, jd_id: str, user_id: str
) -> dict[str, Any]:
    """Live path — loads base + JD from PG, calls resume_agent.customize."""
    import json

    import psycopg  # type: ignore

    from agents.nodes import resume_agent

    dsn = os.environ.get(
        "RELAY_PG_DSN",
        "postgresql://relay:relay@localhost:5433/relay",
    )
    async with await psycopg.AsyncConnection.connect(dsn) as conn:  # type: ignore[arg-type]
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT content, version FROM resumes WHERE id = %s",
                (base_resume_id,),
            )
            row = await cur.fetchone()
            if not row:
                return {"ok": False, "reason": "base_resume_not_found", "via": "real"}
            content, version = row
            base_resume = content if isinstance(content, dict) else json.loads(content)

            await cur.execute(
                "SELECT jd_text FROM jobs WHERE id = %s",
                (jd_id,),
            )
            row = await cur.fetchone()
            if not row:
                return {"ok": False, "reason": "jd_not_found", "via": "real"}
            (jd_text,) = row

    result = await resume_agent.customize(
        base_resume=base_resume,
        jd_text=jd_text,
        user_id=UUID(user_id),
        base_version=int(version),
        base_id=UUID(base_resume_id),
        job_id=UUID(jd_id),
    )
    result["via"] = "real"
    return result
