"""TrendAgent — the 5th agent: daily market ETL over public ATS feeds.

Caller: agents/coordinator/dock_tools.py ``trends_today`` calls
``today_snapshot()`` to answer the dock's "what's the market doing?" intent.
A daily cron would call the same entry (docs/architecture/agent-architecture.md
§ Agent 5) — for the MVP the dock triggers it on demand.

Pipeline (docs/product-spec.md § 6):
  1. Fetch N public Greenhouse boards (``?content=true`` returns the full JD in
     the board-list call, so it's one HTTP request per company).
  2. Sample up to ``max_jobs`` JDs and run V4 Flash over each to extract
     ``{skills, role, level, remote, salary_min, salary_max}``.
  3. Aggregate: top skills by count (with a 7-day trend % vs the prior
     snapshot), top role families, salary + remote stats.
  4. Persist one row into ``trend_snapshots`` (UPSERT on date) + per-skill rows
     into ``skill_trends``.
  5. Build actionable "if you learn X, +Y roles" insights by diffing the
     trending skills against the user's résumé skills (docs/vision.md hook).

Cost: ``max_jobs`` × ~$0.0002/JD on V4 Flash ≈ $0.01 for the default 50.

Hermetic mode: set ``RELAY_TREND_FIXTURE_DIR`` to read
``greenhouse_{company}.json`` off disk instead of hitting the network, so eval
gates can run offline. Schema reference:
infra/postgres/migrations/020_trend_snapshots.up.sql.
"""

from __future__ import annotations

import json
import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.harness.audit import audit, redact_exception_text
from agents.harness.llm import pick_model

log = structlog.get_logger("agents.nodes.trend")

PROMPT_DIR = Path(__file__).parent.parent / "prompts" / "trend"
FIXTURE_DIR_ENV = "RELAY_TREND_FIXTURE_DIR"
_PG_DSN_ENV_VARS = ("RELAY_PG_DSN", "DATABASE_URL", "POSTGRES_URL")

# Public Greenhouse boards confirmed live (2026-07). All expose the
# ?content=true board-list endpoint that ships the full JD inline.
DEFAULT_BOARDS: tuple[str, ...] = ("stripe", "airbnb", "coinbase", "figma", "databricks")

_JD_MAX_BYTES = 25 * 1024 * 1024  # board-list JSON with content can be large
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[\t \xa0]+")

_LEVELS = {"junior", "mid", "senior", "staff", "principal", "exec", "intern", "unspecified"}
_REMOTE = {"onsite", "hybrid", "remote", "unspecified"}


# ─── public surface ────────────────────────────────────────────────────


@dataclass
class TrendSnapshot:
    """Return shape from today_snapshot (dock / cron facing)."""

    snapshot_date: date
    total_jobs: int
    new_jobs_today: int
    sources: list[str]
    skills: list[dict[str, Any]]  # [{skill, count, trend_pct_7d}] desc by count
    top_roles: list[dict[str, Any]]  # [{role, count}]
    salary_stats: dict[str, Any]
    remote_ratio: float | None
    insights: list[dict[str, Any]]  # [{skill, count, unlock_roles, message}]

    def to_dict(self) -> dict[str, Any]:
        return {
            "snapshot_date": self.snapshot_date.isoformat(),
            "total_jobs": self.total_jobs,
            "new_jobs_today": self.new_jobs_today,
            "sources": self.sources,
            "skills": self.skills,
            "top_roles": self.top_roles,
            "salary_stats": self.salary_stats,
            "remote_ratio": self.remote_ratio,
            "insights": self.insights,
        }


class TrendFetchError(RuntimeError):
    """Raised when no board returned any usable jobs."""


async def today_snapshot(
    user_id: UUID,
    *,
    boards: tuple[str, ...] | None = None,
    max_jobs: int = 50,
    persist: bool = True,
    user_skills: list[str] | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> TrendSnapshot:
    """Run the daily ETL and return today's market snapshot.

    Args:
        user_id: caller; recorded on the audit row and used to read résumé
                 skills for personalised insights when ``user_skills`` is None.
        boards: Greenhouse company slugs to scan (defaults to DEFAULT_BOARDS).
        max_jobs: cap on JDs sampled across all boards (cost control).
        persist: when False, skips the DB writes (eval gates that don't want
                 to pollute trend_snapshots).
        user_skills: explicit skill list for the personalisation diff; when
                     None we read the user's résumé skills from PG.
        http_client: optional injection for hermetic tests.

    Raises:
        TrendFetchError when every board fetch failed / returned no jobs.
    """
    board_list = boards or DEFAULT_BOARDS
    async with audit(user_id, "trend_agent", "today_snapshot") as record:
        record.input_params = {"boards": list(board_list), "max_jobs": max_jobs}

        raw_jobs = await _fetch_boards(board_list, max_jobs, http_client=http_client)
        if not raw_jobs:
            raise TrendFetchError(f"no jobs from any of {board_list}")

        parsed = await _parse_all(raw_jobs)
        snapshot = _aggregate(parsed, raw_jobs, sources=list(board_list))

        # Personalised "learn X → +Y roles" — diff trending skills vs résumé.
        skills_for_diff = user_skills
        if skills_for_diff is None:
            skills_for_diff = await _read_user_skills(user_id)
        snapshot.insights = _build_insights(parsed, snapshot, user_skills=skills_for_diff)

        record.output_result = {
            "total_jobs": snapshot.total_jobs,
            "sources": snapshot.sources,
            "top_skill": snapshot.skills[0]["skill"] if snapshot.skills else None,
            "insight_count": len(snapshot.insights),
        }

        if persist:
            await _persist_snapshot(snapshot)

        return snapshot


# ─── fetch ─────────────────────────────────────────────────────────────


@dataclass
class _RawJob:
    company: str
    external_id: str
    title: str
    jd_text: str
    location: str
    posted_recent: bool  # updated within the last day → counts as "new today"


async def _fetch_boards(
    boards: tuple[str, ...],
    max_jobs: int,
    *,
    http_client: httpx.AsyncClient | None,
) -> list[_RawJob]:
    """Pull each board's JDs, round-robin across boards up to max_jobs.

    Round-robin (rather than draining board 1 before board 2) keeps the
    sample balanced across companies even when max_jobs < total.
    """
    per_board: list[list[_RawJob]] = []
    for company in boards:
        try:
            jobs = await _fetch_one_board(company, http_client=http_client)
            per_board.append(jobs)
            log.info("trend.board_fetched", company=company, jobs=len(jobs))
        except Exception as exc:  # noqa: BLE001 — one dead board must not kill the run
            log.warning(
                "trend.board_failed", company=company, error=redact_exception_text(str(exc))
            )
            per_board.append([])

    sampled: list[_RawJob] = []
    idx = 0
    while len(sampled) < max_jobs and any(idx < len(b) for b in per_board):
        for board_jobs in per_board:
            if idx < len(board_jobs):
                sampled.append(board_jobs[idx])
                if len(sampled) >= max_jobs:
                    break
        idx += 1
    return sampled


async def _fetch_one_board(company: str, *, http_client: httpx.AsyncClient | None) -> list[_RawJob]:
    fixture = _load_fixture(company)
    body = fixture if fixture is not None else await _http_get_board(company, http_client)
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise TrendFetchError(f"{company}: board list not json: {exc}") from exc
    return [_shape_job(company, j) for j in (data.get("jobs") or []) if j.get("content")]


def _shape_job(company: str, j: dict[str, Any]) -> _RawJob:
    loc = j.get("location") or {}
    return _RawJob(
        company=company,
        external_id=str(j.get("id") or j.get("internal_job_id") or ""),
        title=(j.get("title") or "Untitled Role").strip(),
        jd_text=_strip_html(j.get("content") or ""),
        location=(loc.get("name") if isinstance(loc, dict) else "") or "",
        posted_recent=_is_recent(j.get("updated_at")),
    )


def _is_recent(updated_at: Any) -> bool:
    """True if the job was updated within ~1 day of the snapshot date."""
    if not isinstance(updated_at, str):
        return False
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", updated_at)
    if not m:
        return False
    try:
        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return False
    return (date.today() - d) <= timedelta(days=1)


def _load_fixture(company: str) -> bytes | None:
    fixture_dir = os.environ.get(FIXTURE_DIR_ENV)
    if not fixture_dir:
        return None
    candidate = Path(fixture_dir) / f"greenhouse_{company}.json"
    if candidate.is_file():
        log.info("trend.fixture_hit", company=company)
        return candidate.read_bytes()
    return None


async def _http_get_board(company: str, client: httpx.AsyncClient | None) -> bytes:
    url = f"https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true"
    timeout = httpx.Timeout(20.0, connect=5.0)
    headers = {"User-Agent": "Vantage/0.1 (+https://relay.example/agent)"}
    if client is not None:
        resp = await client.get(url, timeout=timeout, headers=headers)
    else:
        async with httpx.AsyncClient(follow_redirects=True) as fresh:
            resp = await fresh.get(url, timeout=timeout, headers=headers)
    if resp.status_code >= 400:
        raise TrendFetchError(f"{url} → HTTP {resp.status_code}")
    body = resp.content
    if len(body) > _JD_MAX_BYTES:
        raise TrendFetchError(f"refusing {url}: body {len(body)} > {_JD_MAX_BYTES} bytes")
    return body


def _strip_html(html: str) -> str:
    # Greenhouse JD content is HTML-escaped in the JSON; unescape the common
    # entities before tag-stripping so the LLM reads real text, not &lt;p&gt;.
    for ent, ch in (("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"')):
        html = html.replace(ent, ch)
    no_tags = _TAG_RE.sub(" ", html)
    lines = [_WS_RE.sub(" ", line).strip() for line in no_tags.splitlines()]
    return "\n".join(line for line in lines if line)


# ─── LLM parse ─────────────────────────────────────────────────────────


@dataclass
class _ParsedJob:
    company: str
    role: str
    skills: list[str]
    level: str
    remote: str
    salary_min: int | None
    salary_max: int | None


def _load_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


async def _parse_all(raw_jobs: list[_RawJob]) -> list[_ParsedJob]:
    try:
        model = pick_model("fast", temperature=0.0, max_tokens=1024, reasoning_effort=None)
    except RuntimeError as exc:
        log.warning("trend.no_llm_key", error=redact_exception_text(str(exc)))
        return [_fallback_parsed(j) for j in raw_jobs]

    sys_prompt = _load_prompt("extract_skills.v1.md")
    out: list[_ParsedJob] = []
    for job in raw_jobs:
        out.append(await _parse_one(model, sys_prompt, job))
    return out


async def _parse_one(model: Any, sys_prompt: str, job: _RawJob) -> _ParsedJob:
    if not job.jd_text.strip():
        return _fallback_parsed(job)
    user_payload = (
        f"Company: {job.company}\nTitle: {job.title}\n\n--- JD TEXT ---\n{job.jd_text[:12_000]}"
    )
    try:
        resp = await model.ainvoke(
            [SystemMessage(content=sys_prompt), HumanMessage(content=user_payload)]
        )
    except Exception as exc:  # noqa: BLE001 — degrade rather than fail the whole ETL
        log.warning("trend.llm_failed", company=job.company, error=redact_exception_text(str(exc)))
        return _fallback_parsed(job)
    return _normalize_parsed(_safe_json(resp.content), job)


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        return json.loads(s)
    except json.JSONDecodeError:
        log.warning("trend.invalid_json", preview=str(content)[:200])
        return {}


def _fallback_parsed(job: _RawJob) -> _ParsedJob:
    """No-LLM path — still contributes a role family from the title so the
    aggregation isn't empty when OPENROUTER_API_KEY is missing."""
    return _ParsedJob(
        company=job.company,
        role=_role_from_title(job.title),
        skills=[],
        level="unspecified",
        remote="unspecified",
        salary_min=None,
        salary_max=None,
    )


def _role_from_title(title: str) -> str:
    """Cheap role-family normaliser used as the LLM fallback."""
    t = re.sub(r"[,(].*$", "", title).strip()
    t = re.sub(
        r"\b(senior|staff|principal|lead|junior|sr\.?|jr\.?|i{1,3}|iv|v)\b",
        "",
        t,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", t).strip() or "Unspecified"


def _sanitize_salary(val: Any) -> int | None:
    if val is None:
        return None
    try:
        n = int(val)
    except (TypeError, ValueError):
        return None
    if n < 0 or n > 5_000_000:
        return None
    return n


def _normalize_parsed(parsed: Any, job: _RawJob) -> _ParsedJob:
    # ``parsed`` comes straight from json.loads (via _safe_json) so it can be
    # any JSON type, not just a dict — the guard below is a real runtime check.
    if not isinstance(parsed, dict):
        return _fallback_parsed(job)
    skills_raw = parsed.get("skills")
    skills = (
        [str(s).strip() for s in skills_raw if str(s).strip()]
        if isinstance(skills_raw, list)
        else []
    )
    role = str(parsed.get("role") or "").strip() or _role_from_title(job.title)
    level = str(parsed.get("level") or "unspecified").strip().lower()
    if level not in _LEVELS:
        level = "unspecified"
    remote = str(parsed.get("remote") or "unspecified").strip().lower()
    if remote not in _REMOTE:
        remote = "unspecified"
    smin = _sanitize_salary(parsed.get("salary_min"))
    smax = _sanitize_salary(parsed.get("salary_max"))
    if smin is not None and smax is not None and smin > smax:
        smin, smax = smax, smin
    return _ParsedJob(
        company=job.company,
        role=role,
        skills=_dedup_skills(skills),
        level=level,
        remote=remote,
        salary_min=smin,
        salary_max=smax,
    )


def _dedup_skills(skills: list[str]) -> list[str]:
    """Case-insensitive dedup preserving first-seen canonical casing."""
    seen: dict[str, str] = {}
    for s in skills:
        key = s.lower()
        if key not in seen:
            seen[key] = s
    return list(seen.values())


# ─── aggregate ─────────────────────────────────────────────────────────


def _aggregate(
    parsed: list[_ParsedJob],
    raw_jobs: list[_RawJob],
    *,
    sources: list[str],
    top_n: int = 20,
) -> TrendSnapshot:
    skill_counter: Counter[str] = Counter()
    canonical_case: dict[str, str] = {}
    for job in parsed:
        for s in job.skills:
            key = s.lower()
            skill_counter[key] += 1
            canonical_case.setdefault(key, s)

    top_skills = [
        {"skill": canonical_case[key], "count": count, "trend_pct_7d": None}
        for key, count in skill_counter.most_common(top_n)
    ]

    role_counter: Counter[str] = Counter(
        j.role for j in parsed if j.role and j.role.lower() != "unspecified"
    )
    top_roles = [{"role": role, "count": count} for role, count in role_counter.most_common(10)]

    salaries = [
        (j.salary_min + j.salary_max) // 2
        for j in parsed
        if j.salary_min is not None and j.salary_max is not None
    ]
    salary_stats: dict[str, Any] = {}
    if salaries:
        salaries.sort()
        salary_stats = {
            "min": salaries[0],
            "max": salaries[-1],
            "median": salaries[len(salaries) // 2],
            "currency": "USD",
            "n": len(salaries),
        }

    remote_hits = sum(1 for j in parsed if j.remote in ("remote", "hybrid"))
    remote_ratio = round(remote_hits / len(parsed), 3) if parsed else None
    new_today = sum(1 for r in raw_jobs if r.posted_recent)

    return TrendSnapshot(
        snapshot_date=date.today(),
        total_jobs=len(parsed),
        new_jobs_today=new_today,
        sources=sources,
        skills=top_skills,
        top_roles=top_roles,
        salary_stats=salary_stats,
        remote_ratio=remote_ratio,
        insights=[],  # filled by _build_insights
    )


# ─── insights (the "learn X → +Y roles" hook) ──────────────────────────


def _build_insights(
    parsed: list[_ParsedJob],
    snapshot: TrendSnapshot,
    *,
    user_skills: list[str],
    max_insights: int = 3,
) -> list[dict[str, Any]]:
    """Diff trending skills against the user's skills.

    For each top trending skill the user LACKS, count how many sampled jobs
    require it — that's the "+Y roles you'd unlock" number. Phrased exactly as
    docs/vision.md's hook so the dock can surface it verbatim.
    """
    have = {s.lower() for s in user_skills}
    jobs_with_skill: dict[str, int] = defaultdict(int)
    for job in parsed:
        for s in {sk.lower() for sk in job.skills}:
            jobs_with_skill[s] += 1

    insights: list[dict[str, Any]] = []
    for entry in snapshot.skills:
        skill = entry["skill"]
        if skill.lower() in have:
            continue
        unlock = jobs_with_skill.get(skill.lower(), entry["count"])
        insights.append(
            {
                "skill": skill,
                "count": entry["count"],
                "unlock_roles": unlock,
                "message": f"if you learn {skill}, +{unlock} roles",
            }
        )
        if len(insights) >= max_insights:
            break
    return insights


async def _read_user_skills(user_id: UUID) -> list[str]:
    """Pull the user's résumé skills for the personalisation diff.

    Best-effort: returns [] when PG is unreachable or there's no résumé (the
    insights then simply surface the raw trending skills, which is still a
    useful "market is hiring for X" signal).
    """
    dsn = _resolve_pg_dsn()
    if not dsn:
        return []
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError:
        return []
    sql = """
        SELECT content
        FROM resumes
        WHERE user_id = %s
        ORDER BY CASE WHEN track = 'original' THEN 0 WHEN is_base THEN 1 ELSE 2 END,
                 created_at DESC
        LIMIT 1
    """
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql, (str(user_id),))
                row = await cur.fetchone()
    except Exception as exc:  # noqa: BLE001 boundary
        log.warning("trend.read_skills_failed", error=redact_exception_text(str(exc)))
        return []
    if not row:
        return []
    return _skills_from_resume(row.get("content"))


def _skills_from_resume(content: Any) -> list[str]:
    """Extract flat skill names from a JSON Resume ``skills`` block."""
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            return []
    if not isinstance(content, dict):
        return []
    out: list[str] = []
    for block in content.get("skills") or []:
        if isinstance(block, dict):
            name = block.get("name")
            if isinstance(name, str) and name.strip():
                out.append(name.strip())
            for kw in block.get("keywords") or []:
                if isinstance(kw, str) and kw.strip():
                    out.append(kw.strip())
        elif isinstance(block, str) and block.strip():
            out.append(block.strip())
    return out


# ─── persist ───────────────────────────────────────────────────────────


def _resolve_pg_dsn() -> str | None:
    for name in _PG_DSN_ENV_VARS:
        v = os.environ.get(name)
        if v:
            return v
    return None


async def _persist_snapshot(snapshot: TrendSnapshot) -> UUID | None:
    """UPSERT the snapshot + per-skill trend rows. Returns snapshot id.

    Computes each top skill's 7-day trend % against the prior snapshot's
    counts before writing, so the persisted ``skills`` block carries the
    delta the dock renders.
    """
    dsn = _resolve_pg_dsn()
    if not dsn:
        log.info("trend.skipped_persist_no_dsn", total_jobs=snapshot.total_jobs)
        return None
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError:
        log.error("trend.psycopg_missing")
        return None

    try:
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            prior = await _load_prior_skill_counts(conn, dict_row, snapshot.snapshot_date)
            _apply_trend_pct(snapshot, prior)
            snap_id = await _upsert_snapshot_row(conn, snapshot)
            await _upsert_skill_rows(conn, snapshot)
            await conn.commit()
        return snap_id
    except Exception as exc:  # noqa: BLE001 boundary
        log.error("trend.persist_failed", error=redact_exception_text(str(exc)))
        return None


async def _load_prior_skill_counts(conn: Any, dict_row: Any, today: date) -> dict[str, int]:
    """Most-recent per-skill counts strictly before ``today``."""
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            """
            SELECT skill, count
            FROM skill_trends
            WHERE snapshot_date = (
                SELECT max(snapshot_date) FROM skill_trends WHERE snapshot_date < %s
            )
            """,
            (today,),
        )
        rows = await cur.fetchall()
    return {r["skill"].lower(): int(r["count"]) for r in rows}


def _apply_trend_pct(snapshot: TrendSnapshot, prior: dict[str, int]) -> None:
    for entry in snapshot.skills:
        before = prior.get(entry["skill"].lower())
        if before and before > 0:
            entry["trend_pct_7d"] = round((entry["count"] - before) / before * 100, 2)
        else:
            entry["trend_pct_7d"] = None


async def _upsert_snapshot_row(conn: Any, snapshot: TrendSnapshot) -> UUID:
    sql = """
        INSERT INTO trend_snapshots (
            id, snapshot_date, total_jobs, new_jobs_today, sources,
            skills, top_roles, salary_stats, remote_ratio, insights
        ) VALUES (%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s::jsonb)
        ON CONFLICT (snapshot_date) DO UPDATE
           SET total_jobs     = EXCLUDED.total_jobs,
               new_jobs_today = EXCLUDED.new_jobs_today,
               sources        = EXCLUDED.sources,
               skills         = EXCLUDED.skills,
               top_roles      = EXCLUDED.top_roles,
               salary_stats   = EXCLUDED.salary_stats,
               remote_ratio   = EXCLUDED.remote_ratio,
               insights       = EXCLUDED.insights
        RETURNING id
    """
    new_id = uuid4()
    params = (
        str(new_id),
        snapshot.snapshot_date,
        snapshot.total_jobs,
        snapshot.new_jobs_today,
        json.dumps(snapshot.sources),
        json.dumps(snapshot.skills),
        json.dumps(snapshot.top_roles),
        json.dumps(snapshot.salary_stats),
        snapshot.remote_ratio,
        json.dumps(snapshot.insights),
    )
    async with conn.cursor() as cur:
        await cur.execute(sql, params)
        row = await cur.fetchone()
    return row[0] if row else new_id


async def _upsert_skill_rows(conn: Any, snapshot: TrendSnapshot) -> None:
    sql = """
        INSERT INTO skill_trends (id, skill, snapshot_date, count, trend_pct_7d)
        VALUES (%s,%s,%s,%s,%s)
        ON CONFLICT (skill, snapshot_date) DO UPDATE
           SET count = EXCLUDED.count, trend_pct_7d = EXCLUDED.trend_pct_7d
    """
    async with conn.cursor() as cur:
        for entry in snapshot.skills:
            await cur.execute(
                sql,
                (
                    str(uuid4()),
                    entry["skill"],
                    snapshot.snapshot_date,
                    entry["count"],
                    entry.get("trend_pct_7d"),
                ),
            )
