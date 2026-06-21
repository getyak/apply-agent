"""Shared TypedDict schemas for LangGraph state.

Caller: every node/coordinator imports CoordinatorState or MockState as the
state schema of its StateGraph. Fabrication-guard reads/writes resume_state.

Fields use TypedDict for LangGraph compatibility (it does dict merges, not
attribute access). Cost is always cents (NUMERIC(10,4) on PG side).
"""

from __future__ import annotations

from typing import Annotated, Literal, TypedDict
from uuid import UUID

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages

# Pluggable mode dimensions (mirror PG enum check constraints in 012).
IntelStrategy = Literal["none", "jd_based", "crowdsourced", "recruiter_specific"]
PressureLevel = Literal["encourage_only", "one_follow_up", "chained_to_stuck"]
FeedbackStyle = Literal["rating_1to5", "three_perspective_translation", "one_line_per_answer"]
LoopBehavior = Literal["standalone", "save_to_card", "replay_real_interview"]


class InterviewMode(TypedDict):
    """Loaded from interview_modes table."""
    id: UUID
    slug: str
    display_name: str
    description: str
    intel_strategy: IntelStrategy
    pressure_level: PressureLevel
    feedback_style: FeedbackStyle
    loop_behavior: LoopBehavior
    is_built_in: bool


class IntelBrief(TypedDict, total=False):
    """Returned by fetch_intel; stored as JSONB on interview_sessions.intel_brief."""
    round_minutes: int
    interviewer_style: str
    frequent_questions: list[dict]  # [{q, probability: 0..1, trap: bool}]
    jd_real_focus: list[str]


class FeedbackTranslation(TypedDict, total=False):
    """Three-perspective translation (mode.feedback_style == three_perspective_translation)."""
    you_said: str
    interviewer_heard: str
    suggested_rephrase: str
    stuck_replay: str | None


class WeakPoint(TypedDict):
    skill: str
    confidence: float  # 0..1, lower = weaker
    last_session_id: UUID | None


# ── Shared coordinator state (Ask Vantage dock) ─────────────────────────
class CoordinatorState(TypedDict, total=False):
    """Persistent across the user's lifetime ask_vantage thread."""
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: UUID
    last_intent: str
    total_cost_cents: float
    total_tokens: int
    consecutive_errors: int


# ── Mock interview state (per-session thread) ───────────────────────────
class MockState(TypedDict, total=False):
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: UUID
    session_id: UUID
    mode: InterviewMode
    company: str | None
    role: str | None
    round_type: str | None
    intel: IntelBrief | None
    questions_asked: int
    last_question_id: UUID | None
    last_was_follow_up: bool
    last_answer: str | None
    stuck_count: int  # for chained_to_stuck pressure
    last_feedback: FeedbackTranslation | None
    weak_points: list[WeakPoint]
    total_cost_cents: float
    total_tokens: int
    consecutive_errors: int


# ── Build-from-scratch resume workflow state ────────────────────────────
class BuildResumeState(TypedDict, total=False):
    messages: Annotated[list[BaseMessage], add_messages]
    user_id: UUID
    target_role: str | None
    recent_role: str | None
    top_3_wins: list[str]
    draft_resume_id: UUID | None
    total_cost_cents: float
    total_tokens: int


# ── Prepare-application workflow state ──────────────────────────────────
# Drives docs/architecture/delivery-loop-plan.md § 2.3 saga. The fields are
# all `total=False` so partial state at each stage is valid — saga branches
# check for `last_error` or stage results directly.
class PrepareApplicationState(TypedDict, total=False):
    user_id: UUID
    application_id: UUID  # row in application_drafts; created on entry

    # Inputs
    jd_url: str
    base_resume_id: UUID
    base_resume_content: dict   # JSON Resume v1.0 dict
    base_resume_version: int
    form_fields: list[dict]      # ATS field descriptors, may be empty

    # Stage outputs (set incrementally by nodes)
    job_id: UUID | None
    parsed_jd: dict | None       # canonical schema from jobmatch parse
    company: str | None
    role_title: str | None
    tailored_resume: dict | None
    tailored_resume_id: UUID | None
    cover_letter: dict | None    # CoverLetter.to_dict()
    form_answers: list[dict]     # [FormFieldAnswer.to_dict(), ...]

    # Saga bookkeeping
    fabrication_attempts: int
    last_error: str | None
    stage_status: dict           # {stage_name: "ok" | "fallback" | "failed"}

    # TTAR per-stage timings — propagated through nodes (each returns the
    # accumulated dict so LangGraph's default replace-on-update reducer
    # keeps the union, not just the latest stage). Read out by
    # workflows.run_prepare_application and pushed into the TTARRecord.
    _stage_timings: dict         # {f"{stage}_ms": int}
