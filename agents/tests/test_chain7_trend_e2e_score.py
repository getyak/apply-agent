"""Chain 7 (TrendAgent · daily snapshot) e2e scorecard.

Why this exists
----------------
Chain 7 is the market-intelligence leg of the product (docs/product-spec.md
§ 6). It drives the **real Greenhouse HTTP feed** and the **real OpenRouter
parse** (``deepseek/deepseek-v4-flash``, spec-aligned per
docs/architecture/agent-harness.md § LLM 模型分层) end-to-end through
``trend_agent.today_snapshot`` — no mocks. The unit-level parsing/aggregation
logic is covered hermetically in ``test_trend_agent.py``; this file proves the
whole ETL lands real data and produces the "if you learn X, +Y roles" hook.

To keep cost + latency bounded, the scorecard scans TWO live boards and caps
the sample at 12 JDs (~$0.003/run). ``persist=False`` so it never writes to the
trend_snapshots table (schema fidelity is asserted structurally against the
mig-020 columns instead).

7-dim rubric (per run, 100 pts)
  - completion            20  today_snapshot ran end-to-end, no exception
  - data-source-realness  20  Greenhouse HTTP returned ≥1 real job (real
                              company name present in sources + total_jobs ≥ 1)
  - schema-fidelity       10  snapshot.to_dict() carries exactly the mig-020
                              trend_snapshots columns
  - top-skills-sanity     10  ≤20 skills, each count ≥ 1, sorted desc
  - actionable-insight    15  ≥1 "if you learn X" string for a skill the
                              user's résumé lacks
  - trace-propagation     15  bound trace_id reaches the audit boundary
  - envelope-shape        10  insight rows carry {skill, count, unlock_roles,
                              message}; skill rows carry {skill, count, trend_pct_7d}

Pass: every dimension green → total = 100. We assert per-dimension so a
regression names itself.

Runnable: cd agents && uv run pytest tests/test_chain7_trend_e2e_score.py -v -s
"""

from __future__ import annotations

import asyncio
import atexit
import os
from pathlib import Path
from uuid import uuid4

# ── env leak-guard (same discipline as chain5) ──────────────────────────────
_LEAK_GUARD_KEYS = (
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "RELAY_PG_DSN",
    "RELAY_TREND_FIXTURE_DIR",
)
_SNAPSHOT = {k: os.environ.get(k) for k in _LEAK_GUARD_KEYS}


def _restore() -> None:
    for k, v in _SNAPSHOT.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


atexit.register(_restore)

# Drop SOCKS proxy (clash/v2ray) so httpx reaches OpenRouter + Greenhouse
# directly — same rationale as chain5's header comment.
for _sock_key in ("all_proxy", "ALL_PROXY"):
    os.environ.pop(_sock_key, None)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

import pytest  # noqa: E402
import structlog  # noqa: E402

from agents.harness import audit as audit_mod  # noqa: E402
from agents.nodes import trend_agent as ta  # noqa: E402

_HAS_KEY = bool(os.environ.get("OPENROUTER_API_KEY"))
pytestmark = pytest.mark.skipif(
    not _HAS_KEY,
    reason="chain7 needs a real OPENROUTER_API_KEY (root .env) — it drives the live LLM + feed",
)

# Two live boards, 12-JD cap → ~$0.003/run. stripe + airbnb are big, always-on
# Greenhouse boards, so the "real data" assertion is robust.
_BOARDS = ("stripe", "airbnb")
_MAX_JOBS = 12

# A candidate résumé whose skills deliberately MISS common eng-market skills
# (Kubernetes, TypeScript, Go, …) so the "learn X → +Y roles" insight always
# has something to say — the point of the hook.
_USER_SKILLS = ["Microsoft Excel", "Salesforce", "Copywriting"]

# mig-020 trend_snapshots columns that to_dict() must surface.
_SNAPSHOT_KEYS = (
    "snapshot_date",
    "total_jobs",
    "new_jobs_today",
    "sources",
    "skills",
    "top_roles",
    "salary_stats",
    "remote_ratio",
    "insights",
)


def _install_trace_capture(monkeypatch) -> dict:
    """Capture the bound trace_id at the audit persistence boundary."""
    captured: dict = {}

    async def fake_insert(record):
        ctx = structlog.contextvars.get_contextvars()
        captured["trace_id"] = ctx.get("trace_id")
        captured["agent_type"] = record.agent_type
        captured["action"] = record.action
        captured["status"] = record.status

    monkeypatch.setattr(audit_mod, "_insert", fake_insert)
    return captured


def _score(snap, envelope: dict, trace_id: str, captured: dict) -> dict:
    score: dict = {}

    # 1. completion (20)
    ok = snap is not None and isinstance(envelope, dict)
    score["completion"] = (20 if ok else 0, 20, ok, f"snapshot returned={snap is not None}")

    # 2. data-source-realness (20) — real Greenhouse HTTP returned ≥1 job and
    #    the boards we asked for are the sources reported back.
    sources_ok = set(snap.sources) == set(_BOARDS)
    real_jobs = snap.total_jobs >= 1
    real_ok = sources_ok and real_jobs
    score["data_realness"] = (
        20 if real_ok else 0,
        20,
        real_ok,
        f"total_jobs={snap.total_jobs} sources={snap.sources}",
    )

    # 3. schema-fidelity (10) — to_dict carries exactly the mig-020 columns.
    keys_ok = set(envelope.keys()) == set(_SNAPSHOT_KEYS)
    score["schema_fidelity"] = (
        10 if keys_ok else 0,
        10,
        keys_ok,
        f"keys={sorted(envelope)}",
    )

    # 4. top-skills-sanity (10) — ≤20, each count ≥1, sorted desc by count.
    skills = snap.skills
    counts = [s.get("count", 0) for s in skills]
    skills_ok = (
        0 < len(skills) <= 20
        and all(isinstance(s.get("skill"), str) and s["skill"].strip() for s in skills)
        and all(c >= 1 for c in counts)
        and counts == sorted(counts, reverse=True)
    )
    score["top_skills"] = (
        10 if skills_ok else 0,
        10,
        skills_ok,
        f"n={len(skills)} top3={[(s['skill'], s['count']) for s in skills[:3]]}",
    )

    # 5. actionable-insight (15) — ≥1 "if you learn X" for a skill the user lacks.
    have = {s.lower() for s in _USER_SKILLS}
    insights = snap.insights
    has_hook = bool(insights) and all(
        i["skill"].lower() not in have and i["message"].startswith("if you learn ")
        for i in insights
    )
    lead = insights[0]["message"] if insights else None
    score["actionable"] = (
        15 if has_hook else 0,
        15,
        has_hook,
        f"lead_insight={lead!r}",
    )

    # 6. trace-propagation (15) — bound trace_id reached the audit boundary.
    trace_ok = captured.get("trace_id") == trace_id and captured.get("agent_type") == "trend_agent"
    score["trace"] = (
        15 if trace_ok else 0,
        15,
        trace_ok,
        f"audit trace_id={captured.get('trace_id')!r} (sent {trace_id!r})",
    )

    # 7. envelope-shape (10) — insight + skill rows carry the stable contract.
    insight_rows_ok = all({"skill", "count", "unlock_roles", "message"} <= set(i) for i in insights)
    skill_rows_ok = all({"skill", "count", "trend_pct_7d"} <= set(s) for s in skills)
    env_ok = bool(insights) and insight_rows_ok and skill_rows_ok
    score["envelope"] = (
        10 if env_ok else 0,
        10,
        env_ok,
        f"insight_rows_ok={insight_rows_ok} skill_rows_ok={skill_rows_ok}",
    )

    return score


def _print_card(score: dict) -> int:
    total = sum(v[0] for v in score.values())
    bar = "█" * (total // 5)
    print(f"\n[chain7 e2e] trend_daily_snapshot          {total:>3}/100  {bar}")
    for dim, (got, mx, ok, note) in score.items():
        mark = "✓" if ok else "✗"
        print(f"             {mark} {dim:<16} {got:>2}/{mx:<2}  {note}")
    return total


def test_chain7_trend_e2e_score(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)  # persist=False; keep audit hermetic
    monkeypatch.delenv("RELAY_TREND_FIXTURE_DIR", raising=False)  # force the real feed

    captured = _install_trace_capture(monkeypatch)
    trace_id = str(uuid4())
    user_id = uuid4()

    async def run():
        with structlog.contextvars.bound_contextvars(trace_id=trace_id):
            snap = await ta.today_snapshot(
                user_id,
                boards=_BOARDS,
                max_jobs=_MAX_JOBS,
                persist=False,
                user_skills=_USER_SKILLS,
            )
            # v4-flash occasionally returns an empty completion for a JD (the
            # known empty-response hiccup, task #29). Across a 12-JD sample a
            # single empty row barely dents aggregation, but if the whole run
            # came back skill-less it's a transport flake, not honest data —
            # retry the whole snapshot once.
            attempts = 0
            while attempts < 2 and not snap.skills:
                attempts += 1
                snap = await ta.today_snapshot(
                    user_id,
                    boards=_BOARDS,
                    max_jobs=_MAX_JOBS,
                    persist=False,
                    user_skills=_USER_SKILLS,
                )
        return snap

    snap = asyncio.run(run())
    envelope = snap.to_dict()
    score = _score(snap, envelope, trace_id, captured)
    total = _print_card(score)

    # Surface one concrete "learn X → +Y roles" string in the run log.
    if snap.insights:
        print(f"\n[chain7 e2e] EXAMPLE HOOK → {snap.insights[0]['message']!r}")

    for dim, (_got, _mx, ok, note) in score.items():
        assert ok, f"dim={dim}: {note}"
    assert total >= 99, f"expected ≥99/100, got {total}"


def test_chain7_score_banner():
    print(
        "\n"
        + "═" * 72
        + "\n"
        + " Chain 7 · TrendAgent · daily snapshot · e2e scorecard\n"
        + " 20 completion · 20 data-realness · 10 schema · 10 top-skills ·\n"
        + " 15 actionable · 15 trace · 10 envelope = 100/100\n"
        + "═" * 72
    )
