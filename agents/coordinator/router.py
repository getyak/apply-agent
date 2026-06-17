"""Ask Vantage router — single conversation, intent-routed to 5 agents.

Two-layer intent classification (vantage-ui-mapping.md § 1.3):
  Layer 1: regex / keyword → ~70% coverage, $0 cost
  Layer 2: V4 Flash classifier → remainder, ~$0.0001/msg

The Ask Vantage dock holds a lifetime thread per user
(thread_id = ask_vantage:{user_id}). PostgresSaver makes it durable.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import structlog
from langchain_core.messages import HumanMessage, SystemMessage

from agents.harness.llm import pick_model


log = structlog.get_logger("agents.coordinator.router")

INTENT_PROMPT = (Path(__file__).parent.parent / "prompts" / "coordinator" / "intent_classifier.v1.md").read_text()


VALID_INTENTS = {
    "find_jobs",
    "tailor_resume",
    "draft_cover_letter",
    "mock_me",
    "trends_today",
    "build_resume",
    "update_resume",
    "review_application",
    "other",
}


@dataclass
class Intent:
    intent: str
    confidence: float
    args: dict[str, Any]
    via: str  # "regex" | "llm"


# ───────────────────────────────────────────────────────────────────────
# Layer 1: cheap regex
# ───────────────────────────────────────────────────────────────────────


_REGEX_RULES: list[tuple[re.Pattern[str], str, float]] = [
    # Order matters — most specific first.
    (re.compile(r"\b(mock|practice)\s+(me|interview)\b", re.I), "mock_me", 0.92),
    (re.compile(r"\b(start|run|do)\s+(a\s+)?mock\b", re.I), "mock_me", 0.90),
    (re.compile(r"\b(sharpen|tailor|customi[sz]e)\s+(my\s+)?r[eé]sum[eé]\b", re.I), "tailor_resume", 0.92),
    (re.compile(r"\bsharpen\s+(my\s+)?cv\b", re.I), "tailor_resume", 0.88),
    (re.compile(r"\b(write|draft|generate)\s+(a\s+)?cover\s+letter\b", re.I), "draft_cover_letter", 0.95),
    (re.compile(r"\b(find|show)\s+(me\s+)?(new\s+)?(jobs|roles|matches)\b", re.I), "find_jobs", 0.90),
    (re.compile(r"\bwhat[\'']s\s+(trending|hot|new)\s+today\b", re.I), "trends_today", 0.92),
    (re.compile(r"\b(market|trend|what'?s)\s+(trending|hot)\b", re.I), "trends_today", 0.85),
    (re.compile(r"\b(build|create|start)\s+(a\s+)?r[eé]sum[eé]\b", re.I), "build_resume", 0.85),
    (re.compile(r"\bi\s+don[\'']?t\s+have\s+a\s+r[eé]sum[eé]\b", re.I), "build_resume", 0.95),
    (re.compile(r"\b(update|edit|change|fix)\s+(my\s+)?r[eé]sum[eé]\b", re.I), "update_resume", 0.85),
    (re.compile(r"\breview\s+(my\s+)?application\b", re.I), "review_application", 0.85),
]


_COMPANY_HINT = re.compile(r"\bfor\s+([A-Z][a-zA-Z0-9&\-]+(?:\s+[A-Z][a-zA-Z0-9&\-]+){0,2})\b")
_MODE_HINT = re.compile(r"\b(scene\s+recreation|pressure\s+drill|warm[\s-]?up|rapid\s+fire)\b", re.I)


def cheap_intent_classifier(message: str) -> Intent | None:
    """Layer 1. Returns None if no rule fires confidently enough."""
    for pattern, intent, base_conf in _REGEX_RULES:
        if pattern.search(message):
            return Intent(
                intent=intent, confidence=base_conf, args=_extract_args(message), via="regex"
            )
    return None


def _extract_args(message: str) -> dict[str, Any]:
    args: dict[str, Any] = {"company": None, "role": None, "mode_slug": None}
    m = _COMPANY_HINT.search(message)
    if m:
        args["company"] = m.group(1)
    m = _MODE_HINT.search(message)
    if m:
        slug = m.group(1).lower().replace(" ", "_").replace("-", "_")
        slug = {"scene_recreation": "scene_recreation", "pressure_drill": "pressure_drill",
                "warmup": "warm_up", "warm_up": "warm_up", "rapid_fire": "rapid_fire"}.get(slug, slug)
        args["mode_slug"] = slug
    return args


# ───────────────────────────────────────────────────────────────────────
# Layer 2: V4 Flash
# ───────────────────────────────────────────────────────────────────────


async def llm_intent_classifier(message: str) -> Intent:
    """Fallback when regex misses. Always returns something; defaults to 'other'."""
    model = pick_model("fast", temperature=0.0, max_tokens=256)
    try:
        resp = await model.ainvoke(
            [SystemMessage(content=INTENT_PROMPT), HumanMessage(content=message[:2000])]
        )
        parsed = _safe_json(resp.content)
        intent = parsed.get("intent", "other")
        if intent not in VALID_INTENTS:
            intent = "other"
        return Intent(
            intent=intent,
            confidence=float(parsed.get("confidence", 0.5)),
            args=parsed.get("args") or {},
            via="llm",
        )
    except Exception as exc:  # noqa: BLE001 boundary
        log.error("llm_intent_classifier.failed", error=str(exc))
        return Intent(intent="other", confidence=0.0, args={}, via="llm")


# ───────────────────────────────────────────────────────────────────────
# Combined router
# ───────────────────────────────────────────────────────────────────────


REGEX_ACCEPT_THRESHOLD = 0.85


async def classify_intent(message: str) -> Intent:
    """Layer 1 → Layer 2 fallback."""
    cheap = cheap_intent_classifier(message)
    if cheap and cheap.confidence >= REGEX_ACCEPT_THRESHOLD:
        return cheap
    return await llm_intent_classifier(message)


# ───────────────────────────────────────────────────────────────────────
# Dispatch — wraps each intent in its own agent call
# ───────────────────────────────────────────────────────────────────────


async def dispatch(intent: Intent, user_id: UUID, message: str) -> dict[str, Any]:
    """Route to the relevant agent. Returns a result dict the API streams back.

    Each branch invokes the agent layer's high-level function. The actual
    LangGraph nodes / workflows are constructed lazily so this module doesn't
    pull every agent at import time.
    """
    if intent.intent == "find_jobs":
        return {"agent": "jobmatch_agent", "action": "find_matches", "status": "not_implemented_yet"}

    if intent.intent == "tailor_resume":
        # Hands off to resume_agent.customize via API layer (it needs job + base ids).
        return {
            "agent": "resume_agent",
            "action": "customize",
            "needs": ["base_resume_id", "job_id"],
            "args": intent.args,
        }

    if intent.intent == "draft_cover_letter":
        return {"agent": "appprep_agent", "action": "draft_cover_letter", "status": "not_implemented_yet"}

    if intent.intent == "mock_me":
        from agents.nodes.interview_agent import load_mode

        slug = intent.args.get("mode_slug") or "scene_recreation"
        mode = await load_mode(slug, user_id=user_id)
        if not mode:
            mode = await load_mode("scene_recreation")
        return {
            "agent": "interview_agent",
            "action": "build_mock_graph",
            "mode_slug": mode["slug"] if mode else None,
            "args": intent.args,
        }

    if intent.intent == "trends_today":
        return {"agent": "trend_agent", "action": "daily_snapshot", "status": "not_implemented_yet"}

    if intent.intent == "build_resume":
        from agents.coordinator.workflows import start_build_from_scratch

        return await start_build_from_scratch(user_id=user_id)

    if intent.intent == "update_resume":
        return {"agent": "resume_agent", "action": "update_field", "status": "needs_clarification"}

    if intent.intent == "review_application":
        return {"agent": "appprep_agent", "action": "review", "status": "not_implemented_yet"}

    # 'other' → small-talk fallback (free, V4 Flash).
    return await _smalltalk_reply(message)


async def _smalltalk_reply(message: str) -> dict[str, Any]:
    model = pick_model("fast", temperature=0.7, max_tokens=200)
    resp = await model.ainvoke(
        [
            SystemMessage(
                content=(
                    "You are Vantage, an AI job-search copilot. Reply briefly and "
                    "redirect the user gently to what you can do: find roles, sharpen "
                    "résumés, draft cover letters, run mocks, surface market trends, "
                    "or build a résumé from scratch."
                )
            ),
            HumanMessage(content=message[:1000]),
        ]
    )
    return {"agent": "coordinator", "action": "reply", "text": str(resp.content)}


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        return json.loads(s)
    except json.JSONDecodeError:
        return {}
