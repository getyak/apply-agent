"""Hourly-loop E2E probe — drives the "prepare an application package" story
and scores it against the 8-item rubric in .loop-state/round-<ts>.md.

Hermetic by design: no docker, no PG, no Redis, no OpenRouter. Uses the
FastAPI TestClient + the same stubs the existing hermetic suite uses so we
can drive the full Coordinator workflow + HITL boundary + cost guard + error
envelope + trace_id middleware + i18n without standing up infra.

Run from anywhere — but the agents package must be importable. Easiest:
    cd /home/user/apply-agent/agents
    uv run --extra dev -- python ../scripts/loop_probe_prepare_application.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from pathlib import Path
from uuid import uuid4

# Make the agents package importable when run as a script.
HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "agents"))

import os  # noqa: E402

os.environ.pop("RELAY_PG_DSN", None)
os.environ.pop("DATABASE_URL", None)

from agents.api import server as srv  # noqa: E402
from agents.api.deps import current_user  # noqa: E402
from agents.harness.cost_tracker import CallUsage, open_tally  # noqa: E402
from agents.harness.guards import Budget, BudgetExhausted, post_model_hook  # noqa: E402
from agents.nodes import appprep_agent as appprep  # noqa: E402
from agents.nodes import jobmatch_agent as jm  # noqa: E402
from agents.nodes import resume_agent as ra  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402

# ─── shared fixtures ────────────────────────────────────────────────────


def _make_parsed_jd():
    return jm.ParsedJD(
        job_id=uuid4(),
        source="greenhouse",
        external_id="probe-4071234",
        company="Synthetic Labs",
        role_title="Senior Software Engineer, Platform",
        jd_text="Looking for a senior backend engineer fluent in TypeScript / Postgres.",
        parsed={
            "skills": ["TypeScript", "PostgreSQL"],
            "level": "senior",
            "must_haves": ["5+ years backend"],
            "responsibilities": ["Own backend services"],
            "tech_stack": ["TypeScript", "PostgreSQL"],
            "salary_min": 180000,
            "salary_max": 230000,
            "salary_currency": "USD",
            "locations": ["San Francisco, CA"],
            "remote": "hybrid",
            "nice_to_haves": ["Go"],
        },
        url="https://boards.greenhouse.io/synthetic/jobs/probe-4071234",
    )


BASE_RESUME = {
    "basics": {"name": "Alice Engineer", "email": "alice@example.com"},
    "work": [
        {
            "company": "Synthetic Labs",
            "position": "Engineer",
            "startDate": "2020",
            "endDate": "2024",
        },
    ],
    "skills": [{"name": "TypeScript"}, {"name": "PostgreSQL"}],
}


def _install_stubs(seq: list) -> list[dict]:
    """Stub the 4 stages so prepare_application runs without LLM / PG."""
    from agents.harness import ttar as ttar_mod

    captured: list[dict] = []

    async def fake_parse_jd(url, user_id, persist=True, http_client=None):
        return _make_parsed_jd()

    async def fake_customize(*, base_resume, jd_text, user_id, base_version, base_id, job_id):
        return {
            "ok": True,
            "tailored": {**base_resume, "summary": "Tailored for Synthetic Labs"},
            "version": base_version + 1,
            "resume_id": str(uuid4()),
            "diff": {},
        }

    async def fake_cover(**kwargs):
        return appprep.CoverLetter(
            subject="Re: SSE @ Synthetic Labs",
            body="Dear Synthetic Labs team, …",
            tone="warm",
            fallback=False,
            fabricated_entities=[],
        )

    async def fake_form(**kwargs):
        fields = kwargs.get("fields") or []
        out = []
        for f in fields:
            label = (f.get("label") or f.get("id") or "field").lower()
            if any(t in label for t in ("password", "ssn", "credit_card")):
                out.append(
                    appprep.FormFieldAnswer(
                        id=str(f.get("id") or label), answer=None, skip=True,
                        reason="sensitive_field_user_decides", confidence=1.0,
                    )
                )
            else:
                out.append(
                    appprep.FormFieldAnswer(
                        id=str(f.get("id") or label), answer=f"value_for_{label}",
                        skip=False, reason=None, confidence=0.9,
                    )
                )
        return out

    async def stub_persist(record):
        captured.append(record.to_jsonb())

    seq.append(("jm.parse_jd_from_url", jm.parse_jd_from_url))
    jm.parse_jd_from_url = fake_parse_jd
    seq.append(("ra.customize", ra.customize))
    ra.customize = fake_customize
    seq.append(("appprep.generate_cover_letter", appprep.generate_cover_letter))
    appprep.generate_cover_letter = fake_cover
    seq.append(("appprep.generate_form_answers", appprep.generate_form_answers))
    appprep.generate_form_answers = fake_form
    seq.append(("ttar._persist", ttar_mod._persist))
    ttar_mod._persist = stub_persist
    return captured


def _restore_stubs(seq: list) -> None:
    from agents.harness import ttar as ttar_mod
    for name, original in seq:
        if name == "jm.parse_jd_from_url":
            jm.parse_jd_from_url = original
        elif name == "ra.customize":
            ra.customize = original
        elif name == "appprep.generate_cover_letter":
            appprep.generate_cover_letter = original
        elif name == "appprep.generate_form_answers":
            appprep.generate_form_answers = original
        elif name == "ttar._persist":
            ttar_mod._persist = original


# ─── score functions — each returns (points, max, label, evidence) ────


async def score_1_story_completes():
    """20 pt — prepare_application end-to-end via TestClient."""
    user_id = uuid4()

    async def fake_user_dep():
        return user_id

    srv.app.dependency_overrides[current_user] = fake_user_dep
    seq: list = []
    try:
        _install_stubs(seq)
        client = TestClient(srv.app)
        resp = client.post(
            "/applications/prepare",
            headers={"X-Relay-User-Id": str(user_id)},
            json={
                "jd_url": "https://boards.greenhouse.io/synthetic/jobs/probe-4071234",
                "base_resume_id": str(uuid4()),
                "base_resume_content": BASE_RESUME,
                "base_resume_version": 1,
                "form_fields": [
                    {"id": "full_name", "label": "Full Name", "type": "text"},
                    {"id": "email", "label": "Email", "type": "email"},
                ],
            },
        )
        ok = resp.status_code == 200
        data = resp.json() if ok else {}
        right = (
            ok
            and data.get("status") == "review"
            and data.get("cover_letter") is not None
            and isinstance(data.get("form_answers"), list)
            and data.get("company") == "Synthetic Labs"
        )
        if right:
            return (20, 20, "story-completes",
                    f"POST /applications/prepare → 200, status=review, "
                    f"company={data.get('company')}, "
                    f"cover_chars={len((data.get('cover_letter') or {}).get('body') or '')}, "
                    f"form_answers={len(data.get('form_answers') or [])}")
        return (0, 20, "story-completes",
                f"status={resp.status_code} body={resp.text[:300]}")
    finally:
        _restore_stubs(seq)
        srv.app.dependency_overrides.clear()


async def score_2_hitl_pauses_resumes():
    """15 pt — graph that hits @requires_approval interrupts; Command(resume) reaches inner fn."""
    from typing import TypedDict

    from agents.tools.approve import submit_application
    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.constants import END
    from langgraph.graph import StateGraph
    from langgraph.types import Command

    class S(TypedDict, total=False):
        result: dict
        ran: bool

    async def node(state: S):
        # submit_application is decorated with @requires_approval, which wraps
        # the async fn in a sync wrapper that returns a coroutine — so we await.
        out = submit_application(uuid4(), {"name": "Alice", "email": "alice@example.com"})
        if asyncio.iscoroutine(out):
            out = await out
        return {"result": out, "ran": True}

    g = StateGraph(S)
    g.add_node("submit", node)
    g.set_entry_point("submit")
    g.add_edge("submit", END)
    graph = g.compile(checkpointer=MemorySaver())

    cfg = {"configurable": {"thread_id": "probe-hitl"}}

    # First invoke — should pause at interrupt(), NOT run the inner fn.
    out1 = await graph.ainvoke({}, config=cfg)
    interrupt_payload = (out1 or {}).get("__interrupt__")
    paused = bool(interrupt_payload)
    if not paused:
        return (0, 15, "hitl-interrupt",
                f"graph completed without interrupt; got {out1!r}")

    # Now resume with an approval → inner fn runs.
    out2 = await graph.ainvoke(Command(resume={"type": "approve"}), config=cfg)
    final_result = (out2 or {}).get("result") or {}
    if final_result.get("status") == "marked_submitted":
        return (15, 15, "hitl-interrupt",
                f"interrupt fired (payload action={(interrupt_payload[0].value.get('action') if interrupt_payload else 'n/a')!r}); "
                f"Command(resume=approve) drove inner fn to "
                f"status=marked_submitted")
    # Half credit: interrupt fired but resume didn't reach inner fn cleanly
    return (10, 15, "hitl-interrupt",
            f"interrupted but resume produced unexpected final: {out2!r}")


async def score_3_no_fabrication():
    """15 pt — fabrication_guard catches invented entities in customize output."""
    from agents.nodes.resume_agent import fabrication_guard

    base = {
        "basics": {"name": "Alice Engineer"},
        "work": [{"company": "Synthetic Labs", "position": "Engineer", "startDate": "2020"}],
        "skills": [{"name": "TypeScript"}],
    }
    tailored_clean = {
        "basics": {"name": "Alice Engineer"},
        "work": [
            {"company": "Synthetic Labs", "position": "Engineer", "startDate": "2020"},
        ],
        "skills": [{"name": "TypeScript"}, {"name": "PostgreSQL"}],
    }
    tailored_dirty = {
        "basics": {"name": "Alice Engineer"},
        "work": [
            {"company": "Synthetic Labs", "position": "Engineer", "startDate": "2020"},
            {"company": "Stripe Capital", "position": "VP Engineering", "startDate": "2018"},
        ],
        "skills": [{"name": "TypeScript"}, {"name": "PostgreSQL"}],
    }

    clean_violations = fabrication_guard(base, tailored_clean)
    dirty_violations = fabrication_guard(base, tailored_dirty)

    if not clean_violations and dirty_violations:
        return (15, 15, "fabrication-guard",
                f"clean=0 violations; dirty={len(dirty_violations)} "
                f"e.g. {dirty_violations[0]!r}")
    return (0, 15, "fabrication-guard",
            f"clean_violations={clean_violations}, dirty_violations={dirty_violations}")


async def score_4_cost_guard_trips():
    """10 pt — actually triggering BudgetExhausted at cost-limit cents."""
    with open_tally() as tally:
        tally.add(CallUsage("deepseek/deepseek-v4-pro", 100_000, 50_000, 99.99))
        state = {
            "messages": [AIMessage(content="reply")],
            "total_tokens": 0,
            "total_cost_cents": 0.0,
            "_budget": Budget(cost_limit_cents=0.5),
        }
        try:
            post_model_hook(state)
            return (0, 10, "cost-guard", "post_model_hook did not raise on cost overrun")
        except BudgetExhausted as exc:
            return (10, 10, "cost-guard",
                    f"BudgetExhausted raised: {exc} (cost_limit=0.5¢ probe, "
                    f"actual_session_cents=99.99)")


async def score_5_error_envelope():
    """10 pt — agents-side envelope conforms to v2 schema.

    Drive an HTTPException via the auth dep (current_user with no header)
    rather than a 404, since Starlette emits its own 404 before our handler.
    """
    # Don't override current_user — let it raise 401.
    srv.app.dependency_overrides.pop(current_user, None)
    client = TestClient(srv.app)
    sample_tid = "01234567-89ab-cdef-0123-456789abcdef"
    resp = client.post(
        "/applications/prepare",
        headers={"X-Trace-Id": sample_tid},
        json={
            "jd_url": "https://example.com/x",
            "base_resume_id": str(uuid4()),
            "base_resume_content": {},
            "base_resume_version": 1,
        },
    )
    if resp.status_code != 401:
        return (0, 10, "error-envelope",
                f"expected 401 from missing user header, got {resp.status_code}: {resp.text[:200]}")
    env = resp.json().get("error") or {}
    required = ("code", "message", "traceId", "traceCode", "timestamp")
    missing = [k for k in required if k not in env]
    score = 10
    notes = []
    if missing:
        score = 0
        notes.append(f"missing v2 fields: {missing}")
    if env.get("traceId") != sample_tid:
        score = max(0, score - 5)
        notes.append(f"traceId not echoed: sent {sample_tid}, got {env.get('traceId')}")
    if not (env.get("traceCode") or "").startswith("R-"):
        score = max(0, score - 3)
        notes.append(f"traceCode bad format: {env.get('traceCode')}")
    if env.get("code") != "AUTH_REQUIRED":
        score = max(0, score - 2)
        notes.append(f"code expected AUTH_REQUIRED, got {env.get('code')}")
    if notes:
        return (score, 10, "error-envelope", "; ".join(notes) + f" | got: {env}")
    return (10, 10, "error-envelope",
            f"OK: code={env.get('code')}, traceCode={env.get('traceCode')}, "
            f"messageKey={env.get('messageKey')}")


async def score_6_locale():
    """10 pt — X-Relay-Locale: normalize_locale + language_directive produce
    distinct directives for en vs zh-CN, with graceful fallback on garbage.
    """
    from agents.harness.locale import (
        language_directive,
        normalize_locale,
        resolve_locale,
    )
    en = normalize_locale("en")
    zh = normalize_locale("zh-CN")
    bad = normalize_locale("zz-XX")
    en_dir = language_directive("en", "Hello")
    zh_dir = language_directive("zh-CN", "你好")
    resolved_en = resolve_locale("en", "")
    resolved_zh = resolve_locale("zh-CN", "")
    score = 0
    notes = []
    if en == "en":
        score += 2
    else:
        notes.append(f"normalize('en')={en!r}")
    if zh and "zh" in zh.lower():
        score += 2
    else:
        notes.append(f"normalize('zh-CN')={zh!r}")
    if bad is None or bad == "en":
        score += 2
    else:
        notes.append(f"normalize('zz-XX')={bad!r}")
    if en_dir and isinstance(en_dir, str):
        score += 2
    else:
        notes.append(f"language_directive('en')={en_dir!r}")
    if zh_dir and zh_dir != en_dir:
        score += 2
    else:
        notes.append("zh directive == en directive (no language switch)")
    evidence = (
        f"en→{en}, zh-CN→{zh}, fallback={bad}; "
        f"resolved en={resolved_en}, zh={resolved_zh}; "
        f"en_directive_first40={(en_dir or '')[:40]!r}; "
        f"zh_directive_first40={(zh_dir or '')[:40]!r}"
    )
    if notes:
        evidence += " | issues: " + "; ".join(notes)
    return (score, 10, "i18n-locale", evidence)


async def score_7_trace_continuity():
    """10 pt — agents middleware honours inbound trace_id and emits it on response."""
    srv.app.dependency_overrides.pop(current_user, None)
    client = TestClient(srv.app)
    sample_tid = "01234567-89ab-cdef-0123-456789abcdef"
    resp = client.get("/healthz", headers={"X-Trace-Id": sample_tid})
    echoed = resp.headers.get("X-Trace-Id") or resp.headers.get("x-trace-id")
    if echoed != sample_tid:
        return (0, 10, "trace-continuity",
                f"trace not echoed: sent={sample_tid}, got={echoed}")
    # Now also verify it survives an error path (401) and is the SAME trace.
    err_resp = client.post(
        "/applications/prepare",
        headers={"X-Trace-Id": sample_tid},
        json={
            "jd_url": "https://example.com/x",
            "base_resume_id": str(uuid4()),
            "base_resume_content": {},
            "base_resume_version": 1,
        },
    )
    err_env = (err_resp.json().get("error") or {})
    err_tid_header = err_resp.headers.get("X-Trace-Id") or err_resp.headers.get("x-trace-id")
    if err_env.get("traceId") == sample_tid == err_tid_header:
        return (10, 10, "trace-continuity",
                f"inbound trace echoed on success(/healthz) AND error(401) "
                f"in both header and body. trace={sample_tid}")
    return (5, 10, "trace-continuity",
            f"trace echoed on success but error path diverged: "
            f"err_header={err_tid_header}, err_envelope.traceId={err_env.get('traceId')}")


async def score_8_idempotency():
    """10 pt — re-running prepare_application with same application_id doesn't double-create."""
    user_id = uuid4()

    async def fake_user_dep():
        return user_id

    srv.app.dependency_overrides[current_user] = fake_user_dep
    seq: list = []
    try:
        captured = _install_stubs(seq)
        client = TestClient(srv.app)
        app_id = str(uuid4())
        body = {
            "jd_url": "https://boards.greenhouse.io/synthetic/jobs/probe-4071234",
            "base_resume_id": str(uuid4()),
            "base_resume_content": BASE_RESUME,
            "base_resume_version": 1,
            "form_fields": [{"id": "full_name", "label": "Full Name", "type": "text"}],
            "application_id": app_id,
        }
        r1 = client.post("/applications/prepare", json=body)
        r2 = client.post("/applications/prepare", json=body)
        if r1.status_code != 200 or r2.status_code != 200:
            return (0, 10, "idempotency",
                    f"r1={r1.status_code} r2={r2.status_code}")
        a1 = r1.json().get("application_id")
        a2 = r2.json().get("application_id")
        if a1 == a2 == app_id:
            # Bonus check: both retries produced TTAR records — show that retry
            # is not silently dropped (which would be the wrong kind of
            # idempotency).
            return (10, 10, "idempotency",
                    f"both retries returned application_id={a1} (stable, no double-create) "
                    f"with {len(captured)} TTAR records persisted "
                    f"(2 expected — prepare is not memoized)")
        return (5, 10, "idempotency",
                f"different ids: r1={a1}, r2={a2}, expected={app_id}")
    finally:
        _restore_stubs(seq)
        srv.app.dependency_overrides.clear()


async def main():
    scorers = [
        score_1_story_completes,
        score_2_hitl_pauses_resumes,
        score_3_no_fabrication,
        score_4_cost_guard_trips,
        score_5_error_envelope,
        score_6_locale,
        score_7_trace_continuity,
        score_8_idempotency,
    ]
    rows = []
    total = 0
    cap = 0
    for fn in scorers:
        try:
            pts, mx, label, ev = await fn()
        except Exception as exc:  # noqa: BLE001
            pts, mx, label, ev = 0, 100, fn.__name__, f"EXCEPTION: {type(exc).__name__}: {exc}"
            traceback.print_exc()
        rows.append((pts, mx, label, ev))
        total += pts
        cap += mx

    print()
    print("=" * 80)
    print(f"  hourly-loop probe · prepare-application · score {total}/{cap}")
    print("=" * 80)
    for pts, mx, label, ev in rows:
        marker = "✓" if pts == mx else ("·" if pts > 0 else "x")
        print(f"  {marker}  {pts:>3}/{mx:<3}  {label:<22}  {ev[:150]}")
    print()
    print(
        json.dumps(
            {
                "total": total,
                "cap": cap,
                "rows": [
                    {"pts": p, "max": mx, "label": lab, "evidence": ev}
                    for p, mx, lab, ev in rows
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
