"""InterviewAgent — Mock as pluggable mode (chat2.md § 深度分析).

Mode = { intel × pressure × feedback × loop }.

Four tools implement the four dimensions:
  - fetch_intel        (mode.intel_strategy)
  - ask_question       (mode.pressure_level)
  - translate_feedback (mode.feedback_style)
  - save_to_card       (mode.loop_behavior)

build_mock_graph(mode) wires them into a dynamic StateGraph per session.

PG dependencies (012/013):
  interview_modes  — mode definitions (built-in 4 + user-custom)
  interview_sessions    {mode_id, intel_brief, weak_points}
  interview_questions   {feedback_translation, follow_up_of, is_real}
  interview_question_pool — crowdsourced (vector search by company×role)
"""
from __future__ import annotations

import json
import os
import uuid as _uuid
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import structlog
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.constants import END
from langgraph.graph import StateGraph
from langgraph.types import interrupt

from agents.events.bus import publish
from agents.harness.audit import audit
from agents.harness.checkpointer import get_checkpointer
from agents.harness.guards import attach_budget
from agents.harness.llm import cost_cents, pick_model
from agents.harness.permissions import mark_auto, mark_notify
from agents.harness.state import (
    FeedbackTranslation,
    IntelBrief,
    InterviewMode,
    MockState,
    WeakPoint,
)
from agents.tools.auto import pg_query, redis_get, redis_setex


log = structlog.get_logger("agents.nodes.interview")

PROMPT_DIR = Path(__file__).parent.parent / "prompts" / "interview"


def _load_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


# ───────────────────────────────────────────────────────────────────────
# TOOL 1: fetch_intel — implements mode.intel_strategy
# ───────────────────────────────────────────────────────────────────────


@mark_auto
async def fetch_intel(
    company: str | None,
    role: str | None,
    round_type: str | None,
    mode: InterviewMode,
) -> IntelBrief | None:
    """Pre-session intel brief. Behaviour determined by mode.intel_strategy."""
    strategy = mode["intel_strategy"]
    if strategy == "none":
        return None

    cache_key = f"intel_brief:{company or 'unk'}:{role or 'unk'}:{round_type or 'unk'}:{strategy}"
    cached = await redis_get(cache_key)
    if cached:
        return cast(IntelBrief, json.loads(cached))

    if strategy == "crowdsourced":
        brief = await _intel_from_pool(company, role, round_type)
    elif strategy == "jd_based":
        brief = await _intel_from_jd(company, role, round_type)
    elif strategy == "recruiter_specific":
        # Phase 2: LinkedIn public scrape via browser-use. For MVP, soft-fallback.
        brief = await _intel_from_pool(company, role, round_type)
    else:
        return None

    if brief:
        await redis_setex(cache_key, ttl_seconds=7 * 24 * 3600, value=json.dumps(brief))
    return brief


async def _intel_from_pool(
    company: str | None, role: str | None, round_type: str | None
) -> IntelBrief:
    """Pull frequent questions from interview_question_pool, ranked by report_count.

    No company → empty list (the UI will gracefully fall back to a "generic round"
    message).
    """
    if not company:
        return IntelBrief(
            round_minutes=30,
            interviewer_style="Unknown — no public data on this round.",
            frequent_questions=[],
            jd_real_focus=[],
        )

    rows = await pg_query(
        """
        SELECT question_text, report_count, category, difficulty
        FROM interview_question_pool
        WHERE company = %s
          AND (%s::text IS NULL OR role_category = %s)
          AND (%s::text IS NULL OR stage = %s)
        ORDER BY report_count DESC, last_seen DESC
        LIMIT 5
        """,
        (company, role, role, round_type, round_type),
    )
    if not rows:
        return IntelBrief(
            round_minutes=30,
            interviewer_style=f"No crowdsourced data yet for {company}×{round_type or 'this round'}.",
            frequent_questions=[],
            jd_real_focus=[],
        )

    total = sum(r["report_count"] for r in rows)
    frequent = [
        {
            "q": r["question_text"],
            "probability": round(r["report_count"] / total, 2),
            "trap": _is_trap_question(r["question_text"]),
        }
        for r in rows
    ]
    return IntelBrief(
        round_minutes=25 if round_type == "phone_screen" else 60,
        interviewer_style="Inferred from crowdsourced reports.",
        frequent_questions=frequent,
        jd_real_focus=[],
    )


def _is_trap_question(q: str) -> bool:
    """Heuristic flag for high-stakes questions that often sink candidates."""
    q_lower = q.lower()
    return any(
        marker in q_lower
        for marker in [
            "salary",
            "expectation",
            "weakness",
            "why are you leaving",
            "why our company",
        ]
    )


async def _intel_from_jd(
    company: str | None, role: str | None, round_type: str | None
) -> IntelBrief:
    """LLM-extract real focus from the JD. Uses V4 Flash (cheap, structured)."""
    if not company:
        return IntelBrief(round_minutes=30, interviewer_style="", frequent_questions=[], jd_real_focus=[])

    rows = await pg_query(
        """
        SELECT jd_text FROM jobs
        WHERE company = %s
          AND (%s::text IS NULL OR role_title ILIKE '%%' || %s || '%%')
        ORDER BY posted_date DESC NULLS LAST
        LIMIT 1
        """,
        (company, role, role),
    )
    if not rows:
        return IntelBrief(round_minutes=30, interviewer_style="No JD on file.", frequent_questions=[], jd_real_focus=[])

    jd_text = rows[0]["jd_text"]
    model = pick_model("fast", temperature=0.2, max_tokens=512)
    prompt = _load_prompt("fetch_intel_jd.v1.md")
    response = await model.ainvoke(
        [
            SystemMessage(content=prompt),
            HumanMessage(content=f"JD:\n{jd_text[:8000]}\n\nstage: {round_type or 'unknown'}"),
        ]
    )
    try:
        parsed = json.loads(_strip_codefences(str(response.content)))
        return IntelBrief(
            jd_real_focus=parsed.get("jd_real_focus", []),
            round_minutes=int(parsed.get("round_minutes", 30)),
            interviewer_style=parsed.get("interviewer_style", ""),
            frequent_questions=[],
        )
    except (json.JSONDecodeError, ValueError, KeyError):
        log.warning("intel.jd_parse_failed", company=company)
        return IntelBrief(round_minutes=30, interviewer_style="", frequent_questions=[], jd_real_focus=[])


# ───────────────────────────────────────────────────────────────────────
# TOOL 2: ask_question — implements mode.pressure_level
# ───────────────────────────────────────────────────────────────────────


@mark_auto
async def ask_question(state: MockState) -> dict[str, Any]:
    """Pick the next question. The LLM is asked to honour mode.pressure_level."""
    mode = state["mode"]
    pressure = mode["pressure_level"]

    # Deterministic short-circuit: encourage_only NEVER follows up.
    if pressure == "encourage_only" and state.get("last_was_follow_up", False):
        force_new_topic = True
    else:
        force_new_topic = False

    model = pick_model("general", temperature=0.5, max_tokens=512)
    prompt = _load_prompt("ask_question.v1.md")

    context = {
        "mode_pressure": pressure,
        "last_question": _last_question_text(state),
        "last_answer": state.get("last_answer"),
        "last_was_follow_up": state.get("last_was_follow_up", False) or force_new_topic,
        "stuck_count": state.get("stuck_count", 0),
        "weak_points": [wp["skill"] for wp in state.get("weak_points", [])],
        "intel_frequent": (state.get("intel") or {}).get("frequent_questions", []),
        "company": state.get("company"),
        "role": state.get("role"),
        "round_type": state.get("round_type"),
    }
    response = await model.ainvoke(
        [
            SystemMessage(content=prompt),
            HumanMessage(content=json.dumps(context, ensure_ascii=False)),
        ]
    )
    parsed = _safe_json(response.content)

    new_q_id = _uuid.uuid4()
    # Pricing: V4 general tier — cost feeds guards.post_model_hook.
    used_in = _safe_token_count(response, "input_tokens")
    used_out = _safe_token_count(response, "output_tokens")
    cents = cost_cents("general", used_in, used_out)

    return {
        "last_question_id": new_q_id,
        "last_was_follow_up": bool(parsed.get("is_follow_up", False)),
        "questions_asked": state.get("questions_asked", 0) + 1,
        "_pending_cost_cents": cents,
        "_pending_question": {
            "id": new_q_id,
            "text": parsed.get("question_text", ""),
            "category": parsed.get("category", "behavioral"),
            "follow_up_of": parsed.get("follows_up_on_question_id"),
        },
    }


def _last_question_text(state: MockState) -> str | None:
    q = state.get("_pending_question") if isinstance(state.get("_pending_question"), dict) else None
    return q.get("text") if q else None


# ───────────────────────────────────────────────────────────────────────
# TOOL 3: translate_feedback — implements mode.feedback_style
# ───────────────────────────────────────────────────────────────────────


@mark_auto
async def translate_feedback(
    answer: str,
    question_text: str,
    mode: InterviewMode,
) -> FeedbackTranslation:
    """Three-perspective translation OR rating, depending on mode.feedback_style."""
    style = mode["feedback_style"]
    pressure = mode["pressure_level"]

    stalled = _looks_stalled(answer)

    if style == "one_line_per_answer":
        # Rapid fire: V4 Flash, one line.
        model = pick_model("fast", temperature=0.3, max_tokens=120)
        prompt = (
            "Give ONE LINE of feedback on this answer. Be honest, no praise inflation. "
            "Just say what's strong and what's weak in <= 25 words."
        )
        resp = await model.ainvoke(
            [SystemMessage(content=prompt), HumanMessage(content=f"Q: {question_text}\nA: {answer}")]
        )
        return FeedbackTranslation(
            you_said=answer[:200],
            interviewer_heard=str(resp.content),
            suggested_rephrase="",
            stuck_replay=None,
        )

    if style == "rating_1to5":
        # Compatibility mode (real_prep). Heavy model for accuracy.
        return await _rating_feedback(answer, question_text)

    # three_perspective_translation (default for scene/pressure/warm-up)
    # Use V4 Pro for the interviewer_heard inference (it's the highest-value
    # signal in the product, per chat2.md "抓手 3").
    prompt = _load_prompt("translate_feedback.v1.md")
    is_pressure = pressure == "chained_to_stuck"
    payload = {
        "question": question_text,
        "answer": answer,
        "mode_pressure": pressure,
        "user_stalled": stalled,
    }
    model = pick_model("heavy", temperature=0.4, max_tokens=800)
    resp = await model.ainvoke(
        [SystemMessage(content=prompt), HumanMessage(content=json.dumps(payload, ensure_ascii=False))]
    )
    parsed = _safe_json(resp.content)
    return FeedbackTranslation(
        you_said=parsed.get("you_said", answer[:200]),
        interviewer_heard=parsed.get("interviewer_heard", ""),
        suggested_rephrase=parsed.get("suggested_rephrase", ""),
        stuck_replay=parsed.get("stuck_replay") if is_pressure or stalled else None,
    )


async def _rating_feedback(answer: str, q: str) -> FeedbackTranslation:
    """1-5 rating mode — compatibility path for interview_questions.ai_rating."""
    return FeedbackTranslation(
        you_said=answer[:200],
        interviewer_heard="",
        suggested_rephrase="(rating mode — see ai_rating column)",
        stuck_replay=None,
    )


def _looks_stalled(answer: str) -> bool:
    """Detect a stall to trigger stuck_replay in pressure_drill."""
    if not answer or len(answer.strip()) < 40:
        return True
    lower = answer.lower()
    return any(marker in lower for marker in ["i don't know", "um,", "uh,", "no idea", "not sure how"])


# ───────────────────────────────────────────────────────────────────────
# TOOL 4: save_to_card — implements mode.loop_behavior
# ───────────────────────────────────────────────────────────────────────


@mark_notify
async def save_to_card(
    session_id: UUID,
    user_id: UUID,
    mode: InterviewMode,
    questions: list[dict[str, Any]],
    weak_points: list[WeakPoint],
) -> dict[str, Any]:
    """Persist the session per mode.loop_behavior.

    - standalone: no PG write, return summary only (Warm-up mode)
    - save_to_card: insert all questions + update interview_sessions.weak_points
    - replay_real_interview: same as save_to_card + contribute deidentified Qs to pool
    """
    loop = mode["loop_behavior"]
    if loop == "standalone":
        return {"persisted": False, "card": {"questions": len(questions), "weak_points": weak_points}}

    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        log.warning("save_to_card.no_dsn")
        return {"persisted": False}

    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            # Update session aggregates + weak_points.
            await cur.execute(
                """
                UPDATE interview_sessions
                SET total_questions = %s,
                    weak_points     = %s::jsonb,
                    completed_at    = now()
                WHERE id = %s
                """,
                (len(questions), json.dumps(weak_points, default=str), str(session_id)),
            )

            for i, q in enumerate(questions):
                await cur.execute(
                    """
                    INSERT INTO interview_questions (
                        id, session_id, question_order, question_text, category,
                        user_answer, ai_feedback, feedback_translation,
                        follow_up_of, is_real
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                    """,
                    (
                        str(q.get("id", _uuid.uuid4())),
                        str(session_id),
                        i,
                        q["question_text"],
                        q.get("category", "behavioral"),
                        q.get("user_answer"),
                        (q.get("feedback") or {}).get("suggested_rephrase", ""),
                        json.dumps(q.get("feedback")) if q.get("feedback") else None,
                        str(q["follow_up_of"]) if q.get("follow_up_of") else None,
                        bool(q.get("is_real", False)),
                    ),
                )
        await conn.commit()

    # Publish event for downstream (e.g. surface weak_points in Today view).
    await publish("mock:weak_point_found", {"user_id": str(user_id), "weak_points": weak_points})

    # Replay_real_interview: deidentified contribution to crowdsourced pool.
    if loop == "replay_real_interview":
        await _contribute_to_pool(questions)

    return {"persisted": True, "questions": len(questions), "weak_points": weak_points}


async def _contribute_to_pool(questions: list[dict[str, Any]]) -> None:
    """Append deidentified questions to interview_question_pool. opt-in only."""
    dsn = os.environ.get("RELAY_PG_DSN")
    if not dsn:
        return
    import hashlib

    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            for q in questions:
                if not q.get("is_real"):
                    continue
                h = hashlib.sha256(q["question_text"].lower().encode()).hexdigest()
                await cur.execute(
                    """
                    INSERT INTO interview_question_pool (
                        company, role_category, stage, question_text, category,
                        question_hash, last_seen
                    ) VALUES (%s, %s, %s, %s, %s, %s, CURRENT_DATE)
                    ON CONFLICT (question_hash) DO UPDATE SET
                        report_count = interview_question_pool.report_count + 1,
                        last_seen    = CURRENT_DATE
                    """,
                    (
                        q.get("company", "unknown"),
                        q.get("role_category", "unknown"),
                        q.get("stage"),
                        q["question_text"],
                        q.get("category", "behavioral"),
                        h,
                    ),
                )
        await conn.commit()


# ───────────────────────────────────────────────────────────────────────
# Graph nodes (wrap tools into LangGraph nodes)
# ───────────────────────────────────────────────────────────────────────


async def intel_brief_node(state: MockState) -> dict[str, Any]:
    async with audit(state["user_id"], "interview_agent", "fetch_intel", state.get("session_id")):
        brief = await fetch_intel(
            state.get("company"), state.get("role"), state.get("round_type"), state["mode"]
        )
        return {"intel": brief}


async def ask_question_node(state: MockState) -> dict[str, Any]:
    return await ask_question(state)


async def await_user_input_node(state: MockState) -> dict[str, Any]:
    """interrupt() — pause the graph, wait for user answer via Command(resume=...)."""
    pending = state.get("_pending_question") or {}
    decision = interrupt(
        {
            "type": "await_answer",
            "question_id": str(pending.get("id", "")),
            "question_text": pending.get("text", ""),
            "category": pending.get("category", "behavioral"),
        }
    )
    answer = (decision or {}).get("answer", "") if isinstance(decision, dict) else ""
    stalled = _looks_stalled(answer)
    return {
        "last_answer": answer,
        "stuck_count": state.get("stuck_count", 0) + (1 if stalled else 0),
    }


async def translate_feedback_node(state: MockState) -> dict[str, Any]:
    async with audit(state["user_id"], "interview_agent", "translate_feedback", state.get("session_id")):
        pending = state.get("_pending_question") or {}
        feedback = await translate_feedback(
            answer=state.get("last_answer") or "",
            question_text=pending.get("text", ""),
            mode=state["mode"],
        )
        # Bank the completed (question, answer, feedback) triple into a buffer
        # for save_to_card to consume at debrief.
        buf = list(state.get("_q_buffer", []))
        buf.append(
            {
                **pending,
                "user_answer": state.get("last_answer"),
                "feedback": dict(feedback),
                "follow_up_of": pending.get("follow_up_of"),
            }
        )
        return {"_q_buffer": buf, "last_feedback": feedback}


def route_next_step(state: MockState) -> str:
    """Decide follow-up / next question / debrief based on mode + state."""
    mode = state["mode"]
    pressure = mode["pressure_level"]
    asked = state.get("questions_asked", 0)
    max_q = int(os.environ.get("RELAY_MOCK_MAX_QUESTIONS", "10"))

    if asked >= max_q:
        return "debrief"

    if pressure == "encourage_only":
        return "next_q"

    if pressure == "one_follow_up":
        if state.get("last_was_follow_up"):
            return "next_q"
        # 60% follow-up rate keeps it conversational, not interrogation.
        return "follow_up" if _looks_stalled(state.get("last_answer") or "") or asked % 2 == 0 else "next_q"

    if pressure == "chained_to_stuck":
        if state.get("stuck_count", 0) >= 2:
            return "next_q"
        return "follow_up"

    return "next_q"


async def save_to_card_node(state: MockState) -> dict[str, Any]:
    async with audit(state["user_id"], "interview_agent", "save_to_card", state.get("session_id")):
        # Distil weak points from the feedback corpus (heuristic v0).
        weak = _distil_weak_points(state.get("_q_buffer", []))
        result = await save_to_card(
            session_id=state["session_id"],
            user_id=state["user_id"],
            mode=state["mode"],
            questions=state.get("_q_buffer", []),
            weak_points=weak,
        )
        return {"weak_points": weak, "_save_result": result}


def _distil_weak_points(q_buffer: list[dict[str, Any]]) -> list[WeakPoint]:
    """v0 heuristic: count occurrences of low-confidence markers in feedback."""
    skills: dict[str, int] = {}
    for q in q_buffer:
        heard = (q.get("feedback") or {}).get("interviewer_heard", "").lower()
        for skill, markers in {
            "Owning impact": ["didn't say", "may be just a name", "ownership unclear"],
            "Specificity": ["vague", "abstract", "no specifics"],
            "Conflict with eng": ["avoided", "deflected", "no concrete disagreement"],
            "Quantification": ["no numbers", "no metric"],
        }.items():
            if any(m in heard for m in markers):
                skills[skill] = skills.get(skill, 0) + 1
    return [
        WeakPoint(skill=s, confidence=max(0.1, 1 - n / 5), last_session_id=None)
        for s, n in sorted(skills.items(), key=lambda kv: -kv[1])
    ]


# ───────────────────────────────────────────────────────────────────────
# Graph factory
# ───────────────────────────────────────────────────────────────────────


def build_mock_graph(mode: InterviewMode):
    """Build a Mock graph wired to the given mode.

    Topology depends on mode.intel_strategy (skip intel node if 'none')
    and route_next_step reads mode.pressure_level at runtime.
    """
    g: StateGraph = StateGraph(MockState)

    if mode["intel_strategy"] != "none":
        g.add_node("intel_brief", intel_brief_node)
        g.set_entry_point("intel_brief")
        g.add_edge("intel_brief", "ask_question")
    else:
        g.set_entry_point("ask_question")

    g.add_node("ask_question", ask_question_node)
    g.add_node("await_answer", await_user_input_node)
    g.add_node("translate_feedback", translate_feedback_node)
    g.add_node("save_to_card", save_to_card_node)

    g.add_edge("ask_question", "await_answer")
    g.add_edge("await_answer", "translate_feedback")
    g.add_conditional_edges(
        "translate_feedback",
        route_next_step,
        {"follow_up": "ask_question", "next_q": "ask_question", "debrief": "save_to_card"},
    )
    g.add_edge("save_to_card", END)

    return g.compile(checkpointer=get_checkpointer())


# ───────────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────────


async def load_mode(slug: str, user_id: UUID | None = None) -> InterviewMode | None:
    """Look up a mode by slug. Falls through to built-in if user_id has no match."""
    if user_id:
        rows = await pg_query(
            "SELECT * FROM interview_modes WHERE slug = %s AND user_id = %s AND NOT is_archived",
            (slug, str(user_id)),
        )
        if rows:
            return cast(InterviewMode, rows[0])

    rows = await pg_query(
        "SELECT * FROM interview_modes WHERE slug = %s AND user_id IS NULL AND NOT is_archived",
        (slug,),
    )
    return cast(InterviewMode, rows[0]) if rows else None


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        return json.loads(_strip_codefences(str(content)))
    except json.JSONDecodeError:
        log.warning("ll_response.invalid_json", preview=str(content)[:200])
        return {}


def _strip_codefences(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
    return s.strip()


def _safe_token_count(resp: Any, key: str) -> int:
    usage = getattr(resp, "usage_metadata", None) or {}
    return int(usage.get(key, 0))
