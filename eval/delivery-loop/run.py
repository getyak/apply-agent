"""TTAR gate runner.

Reads eval/delivery-loop/golden.yaml, executes the full prepare_application
workflow for every case (hermetic — JD fixtures + LLM stubs + no PG), and
asserts the thresholds documented in
docs/architecture/delivery-loop-plan.md § 1.

Exit code is non-zero when any threshold is breached, so CI can gate on it
without parsing the JSON report.

The report is written to /tmp/ttar-report.json so the eval.yml workflow can
attach it as an artifact and the post-comment job can render a table.

Usage:
    uv run --project agents python eval/delivery-loop/run.py
"""
from __future__ import annotations

import asyncio
import json
import os
import statistics
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
AGENTS_DIR = REPO_ROOT / "agents"
FIXTURE_DIR = AGENTS_DIR / "tests" / "fixtures" / "jd"
GOLDEN = Path(__file__).parent / "golden.yaml"
REPORT_PATH = Path(os.environ.get("TTAR_REPORT_PATH", "/tmp/ttar-report.json"))

# Make `agents` importable when run from repo root.
sys.path.insert(0, str(AGENTS_DIR))

import yaml  # type: ignore[import-untyped]  # noqa: E402

from agents.coordinator import workflows  # noqa: E402
from agents.harness import ttar as ttar_mod  # noqa: E402
from agents.nodes import appprep_agent as appprep  # noqa: E402
from agents.nodes import jobmatch_agent as jm  # noqa: E402
from agents.nodes import resume_agent as ra  # noqa: E402

# ── Synthetic résumé used by every case (no real PII) ─────────────────
BASE_RESUME = {
    "basics": {"name": "Alice Engineer", "email": "alice@example.com"},
    "work": [
        {
            "company": "Synthetic Labs",
            "position": "Engineer",
            "startDate": "2020",
            "endDate": "2024",
        }
    ],
    "skills": [{"name": "TypeScript"}, {"name": "PostgreSQL"}],
}


@dataclass
class CaseResult:
    case_id: str
    jd_url: str
    success: bool
    parse_jd_ok: bool
    fabrication_attempts: int
    latency_ms: int
    stage_status: dict
    status: str
    last_error: str | None
    expected_status: str
    expected_status_matched: bool


def _stub_llm(monkeypatch_target):
    """Replace every LLM-touching call with a deterministic, cost-free stub."""
    from uuid import uuid4

    async def fake_customize(*, base_resume, jd_text, user_id, base_version, base_id, job_id):
        return {
            "ok": True,
            "tailored": {**base_resume, "summary": "Tailored stub"},
            "version": base_version + 1,
            "resume_id": str(uuid4()),
            "diff": {},
        }

    async def fake_cover(**kwargs):
        return appprep.CoverLetter(
            subject="Application — Alice",
            body="Dear Hiring Team,\n\nStub body.\n\nBest,\nAlice",
            tone="warm",
            fallback=False,
            fabricated_entities=[],
        )

    async def fake_form(**kwargs):
        return []  # no form fields configured for the golden cases

    monkeypatch_target.setattr(ra, "customize", fake_customize)
    monkeypatch_target.setattr(appprep, "generate_cover_letter", fake_cover)
    monkeypatch_target.setattr(appprep, "generate_form_answers", fake_form)

    # Drop the LLM call inside jobmatch.parse_jd — return canned parsed JD
    # so we never reach OpenRouter. We still want the fixture fetcher to run
    # because it exercises the ATS-detection + shape-parsing code paths.
    async def fake_llm_parse_jd(jd_text, company, role_title, source):
        return {
            "skills": ["TypeScript", "PostgreSQL"],
            "level": "senior",
            "salary_min": None,
            "salary_max": None,
            "salary_currency": None,
            "locations": [],
            "remote": "unspecified",
            "must_haves": [],
            "nice_to_haves": [],
            "responsibilities": [],
            "tech_stack": [],
        }

    monkeypatch_target.setattr(jm, "_llm_parse_jd", fake_llm_parse_jd)


def _stub_network(monkeypatch_target):
    """Anything that escapes the fixture path raises JDFetchError."""

    async def boom_get(url, client):
        raise jm.JDFetchError(f"network blocked in ttar-gate: {url}")

    monkeypatch_target.setattr(jm, "_http_get", boom_get)


def _stub_ttar_persist(monkeypatch_target, sink: list[dict]):
    async def stub(record):
        sink.append(record.to_jsonb())

    monkeypatch_target.setattr(ttar_mod, "_persist", stub)


async def _run_case(case: dict) -> CaseResult:
    from uuid import uuid4

    expected_status = case.get("expect_status", "review")

    result = await workflows.run_prepare_application(
        user_id=uuid4(),
        jd_url=case["jd_url"],
        base_resume_id=uuid4(),
        base_resume_content=BASE_RESUME,
        base_resume_version=1,
        form_fields=[],
    )

    stage_status = result.get("stage_status") or {}
    parse_jd_ok = stage_status.get("parse_jd") == "ok"

    return CaseResult(
        case_id=case["id"],
        jd_url=case["jd_url"],
        success=(result["status"] == expected_status),
        parse_jd_ok=parse_jd_ok,
        fabrication_attempts=0,  # populated below from ttar sink
        latency_ms=0,             # populated below from ttar sink
        stage_status=stage_status,
        status=result["status"],
        last_error=result.get("last_error"),
        expected_status=expected_status,
        expected_status_matched=(result["status"] == expected_status),
    )


async def _main_async() -> int:
    if not GOLDEN.is_file():
        print(f"::error::golden.yaml not found at {GOLDEN}")
        return 2
    if not FIXTURE_DIR.is_dir():
        print(f"::error::fixture dir not found at {FIXTURE_DIR}")
        return 2

    os.environ.setdefault("RELAY_JD_FIXTURE_DIR", str(FIXTURE_DIR))
    # Make sure no developer's local PG/Redis leaks in.
    os.environ.pop("RELAY_PG_DSN", None)

    with GOLDEN.open() as f:
        spec = yaml.safe_load(f)

    threshold = spec.get("threshold", {})
    cases = spec.get("cases", [])
    if not cases:
        print("::error::no cases in golden.yaml")
        return 2

    # Use a lightweight monkeypatch — `pytest.MonkeyPatch` works outside pytest.
    import pytest
    mp = pytest.MonkeyPatch()
    ttar_sink: list[dict] = []
    try:
        _stub_llm(mp)
        _stub_network(mp)
        _stub_ttar_persist(mp, ttar_sink)

        results: list[CaseResult] = []
        for case in cases:
            res = await _run_case(case)
            results.append(res)
    finally:
        mp.undo()

    # Attach the TTAR latencies + fabrication_attempts to each case.
    # ttar_sink is in insertion order, one entry per case.
    for case_res, rec in zip(results, ttar_sink):
        case_res.latency_ms = int(rec.get("latency_ms", 0))
        case_res.fabrication_attempts = int(rec.get("fabrication_attempts", 0))

    # ── Aggregate metrics ──────────────────────────────────────────────
    total = len(results)
    status_matched = sum(1 for r in results if r.expected_status_matched)
    parse_jd_ok = sum(1 for r in results if r.parse_jd_ok)
    # Successful = reached "review" status (not "draft" / failed).
    successful = sum(1 for r in results if r.status == "review")
    fabrication_sum = sum(r.fabrication_attempts for r in results)
    fabrication_rate = fabrication_sum / max(total, 1)

    success_rate = successful / total
    # We want parse_jd_success over the cases that *expected* parse to succeed.
    expected_parse_ok = [r for r in results if r.expected_status == "review"]
    parse_jd_success_rate = (
        sum(1 for r in expected_parse_ok if r.parse_jd_ok) / max(len(expected_parse_ok), 1)
    )

    latencies = [r.latency_ms for r in results if r.parse_jd_ok]
    if len(latencies) >= 5:
        p95_latency_ms = int(statistics.quantiles(latencies, n=20)[-1])
    elif latencies:
        p95_latency_ms = max(latencies)
    else:
        p95_latency_ms = 0
    median_latency_ms = int(statistics.median(latencies)) if latencies else 0

    # ── Threshold checks ──────────────────────────────────────────────
    failures: list[str] = []
    if success_rate < threshold.get("success_min", 0.85):
        failures.append(
            f"TTAR-success {success_rate:.2%} < threshold {threshold.get('success_min'):.2%}"
        )
    if fabrication_rate > threshold.get("fabrication_max", 0.0):
        failures.append(
            f"fabrication rate {fabrication_rate} > threshold {threshold.get('fabrication_max')}"
        )
    if parse_jd_success_rate < threshold.get("parse_jd_success_min", 0.9):
        failures.append(
            f"parse_jd success {parse_jd_success_rate:.2%} < threshold {threshold.get('parse_jd_success_min'):.2%}"
        )
    # Expected-status mismatches always fail (these are correctness asserts).
    for r in results:
        if not r.expected_status_matched:
            failures.append(
                f"case {r.case_id}: expected status={r.expected_status} got {r.status}"
            )

    # ── Report ─────────────────────────────────────────────────────────
    report = {
        "summary": {
            "total": total,
            "status_matched": status_matched,
            "parse_jd_ok": parse_jd_ok,
            "successful": successful,
            "success_rate": round(success_rate, 4),
            "parse_jd_success_rate": round(parse_jd_success_rate, 4),
            "fabrication_rate": round(fabrication_rate, 4),
            "median_latency_ms": median_latency_ms,
            "p95_latency_ms": p95_latency_ms,
        },
        "threshold": threshold,
        "failures": failures,
        "cases": [asdict(r) for r in results],
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))

    # Stdout summary for CI logs.
    print("─" * 60)
    print(f"TTAR gate — {total} cases")
    print(f"  success_rate         {success_rate:.2%}  (≥ {threshold.get('success_min'):.0%})")
    print(f"  parse_jd_success     {parse_jd_success_rate:.2%}  (≥ {threshold.get('parse_jd_success_min'):.0%})")
    print(f"  fabrication_rate     {fabrication_rate}  (= {threshold.get('fabrication_max')})")
    print(f"  median_latency_ms    {median_latency_ms}")
    print(f"  p95_latency_ms       {p95_latency_ms}")
    print(f"  report               {REPORT_PATH}")
    print("─" * 60)

    if failures:
        print("\n::error::TTAR gate FAILED")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("TTAR gate PASSED")
    return 0


def main() -> int:
    return asyncio.run(_main_async())


if __name__ == "__main__":
    raise SystemExit(main())
