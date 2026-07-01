"""Ask Vantage router — single conversation, intent-routed to 5 agents.

Two-layer intent classification (vantage-ui-mapping.md § 1.3):
  Layer 1: regex / keyword → ~70% coverage, $0 cost
  Layer 2: V4 Flash classifier → remainder, ~$0.0001/msg

The Ask Vantage dock holds a lifetime thread per user
(thread_id = ask_vantage:{user_id}). PostgresSaver makes it durable.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import structlog
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from agents.harness.audit import redact_exception_text
from agents.harness.llm import pick_model
from agents.harness.locale import (
    detect_reply_locale,
    reply_language_directive,
)
from agents.harness.locale import (
    language_directive as build_language_directive,
)

log = structlog.get_logger("agents.coordinator.router")

# DISP5 (round-6): every LLM call in this module is wrapped with this
# timeout so a hanging upstream (OpenRouter, DeepSeek, GLM) can never
# stall the SSE stream indefinitely. The round-6 audit flagged that
# both classify_intent and _smalltalk_reply called ainvoke unguarded;
# a 30s deadline matches the upper bound stated in agent-harness.md.
_ROUTER_LLM_TIMEOUT_S = float(os.environ.get("RELAY_ROUTER_LLM_TIMEOUT_S", "30"))

INTENT_PROMPT = (
    Path(__file__).parent.parent / "prompts" / "coordinator" / "intent_classifier.v1.md"
).read_text()


VALID_INTENTS = {
    "find_jobs",
    "tailor_resume",
    "draft_cover_letter",
    "mock_me",
    "trends_today",
    "build_resume",
    # Read-only "show me my résumé history". Dispatch answers inline as a
    # small-talk text reply — no HITL card, no jump to studio. Read intent
    # must be ordered before update_resume in the regex table so a user
    # writing "查看 / show / list" never accidentally lands on the write
    # path.
    "list_resume_versions",
    "update_resume",
    "review_application",
    # Applications kanban — move a row between columns, list the user's
    # pipeline, or record an outcome. Lives in the agent's surface so a
    # user can say "move Stripe to interviewing" inside any vibe chat.
    "list_applications",
    "move_application",
    "set_application_outcome",
    # Dual-track résumé intents (design §6, the "This résumé" dock chips).
    # analyze_resume → weakest-spots critique (inline reply).
    # optimize_resume → no-JD best-practice pass (suggestion stack artifact).
    # map_career_moves → trajectory + skill-gap (inline reply).
    # surface_roles → roles matching the current résumé (routes to job search).
    "analyze_resume",
    "optimize_resume",
    "map_career_moves",
    "surface_roles",
    "other",
}


# INTENT4 (round-19): the four built-in Mock interview modes seeded by
# migrations/013_seed_interview_modes.up.sql. Used as a fast-path in
# `_normalize_mode_slug` so the obvious cases pass without a regex.
_BUILT_IN_MODE_SLUGS = frozenset({"scene_recreation", "pressure_drill", "warm_up", "rapid_fire"})
# Syntactic gate for user-custom slugs: lowercase / digits / underscore,
# 2-64 chars. Anything else (English sentences, JSON snippets, attempted
# SQL fragments — the LLM has been known to emit all three under
# adversarial input) collapses to `scene_recreation` before any DB
# round-trip.
_VALID_CUSTOM_MODE_SLUG_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")


def _normalize_mode_slug(raw: object) -> str | None:
    """Return a safe mode_slug or None if the input is obviously hostile.

    Conservative: accept built-in slugs verbatim, accept user-custom
    snake_case slugs that look like real identifiers, drop everything
    else.
    """
    if not isinstance(raw, str):
        return None
    slug = raw.strip()
    if not slug:
        return None
    if slug in _BUILT_IN_MODE_SLUGS:
        return slug
    if _VALID_CUSTOM_MODE_SLUG_RE.match(slug):
        return slug
    return None


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
    (
        re.compile(r"\b(sharpen|tailor|customi[sz]e)\s+(my\s+)?r[eé]sum[eé]\b", re.I),
        "tailor_resume",
        0.92,
    ),
    (re.compile(r"\bsharpen\s+(my\s+)?cv\b", re.I), "tailor_resume", 0.88),
    (
        re.compile(r"\b(write|draft|generate)\s+(a\s+)?cover\s+letter\b", re.I),
        "draft_cover_letter",
        0.95,
    ),
    (
        re.compile(r"\b(find|show)\s+(me\s+)?(new\s+)?(jobs|roles|matches)\b", re.I),
        "find_jobs",
        0.90,
    ),
    (re.compile(r"\bwhat[\'']s\s+(trending|hot|new)\s+today\b", re.I), "trends_today", 0.92),
    (re.compile(r"\b(market|trend|what'?s)\s+(trending|hot)\b", re.I), "trends_today", 0.85),
    (re.compile(r"\b(build|create|start)\s+(a\s+)?r[eé]sum[eé]\b", re.I), "build_resume", 0.85),
    (re.compile(r"\bi\s+don[\'']?t\s+have\s+a\s+r[eé]sum[eé]\b", re.I), "build_resume", 0.95),
    # Read-only "show me my résumé VERSION HISTORY". Must come BEFORE the
    # update_resume rule so "list" never lands on the write path.
    #
    # Round-21 split: two distinct surfaces share these verbs, so we route
    # them apart with a qualifier.
    #
    #   (a) "查看 / 看一下 / 看看 / 显示 + 简历 + (版本|历史|记录|列表)"
    #       → the user wants the *version timeline* → list_resume_versions.
    #   (b) "查看 / 看 + 简历" without a qualifier
    #       → the user wants the *content* of the document. We deliberately
    #         skip Layer 1 so the dock LLM picks it up and calls the
    #         ``read_resume`` tool (see prompts/coordinator/dock_agent.v1.md
    #         "Viewing / showing the résumé"). The earlier broad regex
    #         matched plain "查看我的简历" and collapsed both intents into
    #         the version-list reply, which confused users.
    #
    # The unambiguous list verbs ("列出 / 列表") stay as an unconditional
    # list match: those carry an explicit "list" semantic and are not the
    # source of the ambiguity.
    (
        re.compile(
            r"(查看|查一下|看一下|看看|显示)\s*(我的)?\s*(简历|履历)\s*(版本|历史|记录|列表)",
            re.I,
        ),
        "list_resume_versions",
        0.92,
    ),
    (
        re.compile(r"(列出|列表)\s*(我的)?\s*(简历|履历)", re.I),
        "list_resume_versions",
        0.90,
    ),
    (
        re.compile(
            r"(我|目前)?\s*(一共)?\s*(有|存了)\s*(几|多少)\s*(个|份|版)\s*(简历|履历)", re.I
        ),
        "list_resume_versions",
        0.90,
    ),
    (
        re.compile(
            r"\b(show|list|view|see)\s+(me\s+)?(my\s+|all\s+)?r[eé]sum[eé]s?\s+versions?\b",
            re.I,
        ),
        "list_resume_versions",
        0.92,
    ),
    (
        re.compile(r"\b(what|which)\s+r[eé]sum[eé]\s+versions?\s+do\s+i\s+have\b", re.I),
        "list_resume_versions",
        0.94,
    ),
    (
        re.compile(r"\b(r[eé]sum[eé])\s+(version|history|timeline)s?\b", re.I),
        "list_resume_versions",
        0.87,
    ),
    # Dual-track "This résumé" chips (design §6 / §1.4). These must precede the
    # update_resume rule so "analyze / weakest / optimize this résumé" never
    # lands on the write path.
    (
        re.compile(r"\b(analy[sz]e|critique|review)\s+(this\s+|my\s+)?r[eé]sum[eé]\b", re.I),
        "analyze_resume",
        0.90,
    ),
    (re.compile(r"\b(weakest|weak)\s+(spots?|points?|parts?)\b", re.I), "analyze_resume", 0.90),
    # zh — "(帮我)?分析(一下)?(我的|这份)?简历/履历"
    (
        re.compile(r"(帮我)?\s*分析\s*(一下)?\s*(我的|这份|这个)?\s*(简历|履历)"),
        "analyze_resume",
        0.92,
    ),
    (
        re.compile(r"(给|帮)\s*(我)?\s*(看一下|评估|点评|审视)\s*(我的|这份)?\s*(简历|履历)"),
        "analyze_resume",
        0.90,
    ),
    (
        re.compile(
            r"\b(optimi[sz]e|improve|sharpen|strengthen)\s+(this\s+|my\s+)?r[eé]sum[eé]\b(?!\s+for)",
            re.I,
        ),
        "optimize_resume",
        0.88,
    ),
    (re.compile(r"\b(quick\s+wins?|best[- ]practice)\b", re.I), "optimize_resume", 0.80),
    (re.compile(r"\b(next|career)\s+(move|moves|step|steps)\b", re.I), "map_career_moves", 0.88),
    (re.compile(r"\b(surface|suggest|recommend)\s+(\w+\s+)?roles?\b", re.I), "surface_roles", 0.86),
    (re.compile(r"\broles?\s+that\s+match\b", re.I), "surface_roles", 0.88),
    (
        re.compile(r"\b(update|edit|change|fix)\s+(my\s+)?r[eé]sum[eé]\b", re.I),
        "update_resume",
        0.85,
    ),
    (re.compile(r"\breview\s+(my\s+)?application\b", re.I), "review_application", 0.85),
    # Applications kanban.
    (
        re.compile(
            # "move <company> to interviewing", "drag stripe to outcome",
            # "shift the openai card to interview".
            r"\b(move|drag|shift|push|bump)\s+(the\s+)?[\w-]+(?:\s+(card|app|application|role))?\s+to\s+(applied|interview|interviewing|outcome|offer|rejected|ghosted|submitted)\b",
            re.I,
        ),
        "move_application",
        0.90,
    ),
    (
        re.compile(
            # "mark <company> as interviewing|rejected|offer"
            r"\bmark\s+(the\s+)?[\w-]+\s+as\s+(applied|interview|interviewing|outcome|offer|rejected|ghosted|submitted|accepted|closed)\b",
            re.I,
        ),
        "move_application",
        0.90,
    ),
    (
        re.compile(r"\b(show|list)\s+(me\s+)?(my\s+)?(applications|pipeline|kanban)\b", re.I),
        "list_applications",
        0.92,
    ),
    (
        re.compile(
            # "record outcome: signed offer", "note outcome <company> ..."
            r"\b(record|note|log|set)\s+(the\s+)?outcome\b",
            re.I,
        ),
        "set_application_outcome",
        0.85,
    ),
]


# Accept "for / on / at / with / against" as the leading preposition so
# natural phrasings like "mock me on Stripe" or "tailor for Linear" both
# yield a captured company hint.
_COMPANY_HINT = re.compile(
    r"\b(?:for|on|at|with|against|to)\s+([A-Z][a-zA-Z0-9&\-]+(?:\s+[A-Z][a-zA-Z0-9&\-]+){0,2})\b"
)
# Accept both spaces and underscores between mode words, and the bare
# slug form ("pressure_drill") that the dock + the modes catalogue use.
_MODE_HINT = re.compile(
    r"\b(scene[\s_]+recreation|pressure[\s_]+drill|warm[\s_-]?up|rapid[\s_]+fire)\b",
    re.I,
)
# Word after "to <X>" or "as <X>" in the move/mark intents — used to derive
# the target status. We canonicalise interviewing → interview etc. before
# dispatch so the tool gets one of the values _ALLOWED_STATUSES (see
# tools/applications.py) accepts.
_MOVE_TARGET = re.compile(
    r"\b(?:to|as)\s+(applied|interview|interviewing|outcome|offer|rejected|ghosted|submitted|accepted|closed)\b",
    re.I,
)
# Company hint specific to the move/mark intents. Matches the first capitalised
# token or the slug after "move <X>". Conservative on purpose — when we can't
# pull a name we fall through to the LLM layer for clarification.
_MOVE_COMPANY = re.compile(
    r"\b(?:move|drag|shift|push|bump|mark)\s+(?:the\s+)?([A-Za-z][\w-]{1,40})\b",
    re.I,
)

# Canonical-status mapping for the kanban → status field. The drawer's
# COLUMN_DEFAULT_STATUS in web/src/components/views/tracker-view.tsx is the
# same mapping in reverse; keep them in sync.
_TARGET_TO_STATUS = {
    "applied": "submitted",
    "interviewing": "interview",
    "outcome": "rejected",
}


def cheap_intent_classifier(message: str) -> Intent | None:
    """Layer 1. Returns None if no rule fires confidently enough."""
    for pattern, intent, base_conf in _REGEX_RULES:
        if pattern.search(message):
            return Intent(
                intent=intent, confidence=base_conf, args=_extract_args(message), via="regex"
            )
    return None


def _extract_args(message: str) -> dict[str, Any]:
    args: dict[str, Any] = {
        "company": None,
        "role": None,
        "mode_slug": None,
        "target_status": None,
    }
    m = _COMPANY_HINT.search(message)
    if m:
        args["company"] = m.group(1)
    m = _MODE_HINT.search(message)
    if m:
        slug = m.group(1).lower().replace(" ", "_").replace("-", "_")
        slug = {
            "scene_recreation": "scene_recreation",
            "pressure_drill": "pressure_drill",
            "warmup": "warm_up",
            "warm_up": "warm_up",
            "rapid_fire": "rapid_fire",
        }.get(slug, slug)
        args["mode_slug"] = slug
    # Applications: pull the move target and any company hint. The company
    # regex here is looser than _COMPANY_HINT (no leading "for") so we
    # try it second and only use it when _COMPANY_HINT already missed.
    m = _MOVE_TARGET.search(message)
    if m:
        raw = m.group(1).lower()
        args["target_status"] = _TARGET_TO_STATUS.get(raw, raw)
    if not args["company"]:
        m = _MOVE_COMPANY.search(message)
        if m:
            args["company"] = m.group(1)
    return args


# ───────────────────────────────────────────────────────────────────────
# Layer 2: V4 Flash
# ───────────────────────────────────────────────────────────────────────


async def llm_intent_classifier(message: str) -> Intent:
    """Fallback when regex misses. Always returns something; defaults to 'other'."""
    import asyncio as _asyncio  # local import keeps formatter from dropping it

    model = pick_model("fast", temperature=0.0, max_tokens=256)
    try:
        # DISP5 (round-6): wrap the LLM call in a hard timeout so a
        # hanging upstream can never stall the SSE dispatch above this
        # frame. asyncio.TimeoutError flows into the same except below
        # and yields the same "other / confidence=0" fallback the
        # original handler produced for any other exception class.
        resp = await _asyncio.wait_for(
            model.ainvoke(
                [SystemMessage(content=INTENT_PROMPT), HumanMessage(content=message[:2000])]
            ),
            timeout=_ROUTER_LLM_TIMEOUT_S,
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
        log.error(
            "llm_intent_classifier.failed",
            error=redact_exception_text(str(exc)),
            kind=type(exc).__name__,
        )
        return Intent(intent="other", confidence=0.0, args={}, via="llm")


# ───────────────────────────────────────────────────────────────────────
# Combined router
# ───────────────────────────────────────────────────────────────────────


REGEX_ACCEPT_THRESHOLD = 0.85

# Below this length the message is almost certainly a slip (the classic
# "hji" autocomplete miss). We short-circuit before paying the LLM cost
# and route it to the smalltalk reply, which gives a "What would you like
# me to do?" copy — much faster than a thinking spinner. The threshold
# matches the web composer's client-side guard so the two layers stay
# in lockstep.
SHORT_INPUT_MIN_CHARS = 2


async def classify_intent(message: str) -> Intent:
    """Layer 1 → Layer 2 fallback."""
    stripped = (message or "").strip()
    # Defense-in-depth: the web composer drops these before they ever leave
    # the browser (dock.tsx submit()), but raw curl, extension, or older
    # clients can still send them. Skip LLM entirely.
    if len(stripped) < SHORT_INPUT_MIN_CHARS:
        return Intent(
            intent="other",
            confidence=1.0,
            args={},
            via="short_input_guard",
        )
    cheap = cheap_intent_classifier(message)
    if cheap and cheap.confidence >= REGEX_ACCEPT_THRESHOLD:
        return cheap
    return await llm_intent_classifier(message)


# ───────────────────────────────────────────────────────────────────────
# Dispatch — wraps each intent in its own agent call
# ───────────────────────────────────────────────────────────────────────


async def dispatch(
    intent: Intent,
    user_id: UUID,
    message: str,
    thread_id: str | None = None,
    surface: str | None = None,
    locale: str | None = None,
) -> dict[str, Any]:
    """Route to the relevant agent. Returns a result dict the API streams back.

    Each branch invokes the agent layer's high-level function. The actual
    LangGraph nodes / workflows are constructed lazily so this module doesn't
    pull every agent at import time.

    ``thread_id`` is the lifetime ask_vantage thread for this user
    (vantage-ui-mapping.md § 1.2). It is threaded into the small-talk reply so
    the dock has multi-turn memory.

    ``surface`` identifies which UI panel asked. When it is ``resume_studio``
    we attach a brief of the user's current master résumé to the small-talk
    system prompt so questions like "介绍一下这个人" or "分析这份简历" reach
    the model with the document already in context — otherwise the agent has
    no way to know which résumé is open and (correctly) refuses to invent
    one. Other surfaces keep the old, surface-agnostic behaviour.
    """
    if intent.intent == "find_jobs":
        return {
            "agent": "jobmatch_agent",
            "action": "find_matches",
            "status": "not_implemented_yet",
        }

    if intent.intent == "tailor_resume":
        # Hands off to resume_agent.customize via API layer (it needs job + base ids).
        return {
            "agent": "resume_agent",
            "action": "customize",
            "needs": ["base_resume_id", "job_id"],
            "args": intent.args,
        }

    if intent.intent == "draft_cover_letter":
        return {
            "agent": "appprep_agent",
            "action": "draft_cover_letter",
            "status": "not_implemented_yet",
        }

    if intent.intent == "mock_me":
        from agents.nodes.interview_agent import load_mode

        # INTENT4 (round-19): the round-18 audit flagged that the
        # LLM-emitted `mode_slug` flowed straight into load_mode() with
        # no enum check. The parameterised SQL closes the injection
        # door (round-14), but any string still got a DB round-trip
        # which the round-18 audit called out as a wasted call and as
        # leaving the door open for a hostile user to inject a
        # carefully-crafted slug that matches a future user-custom
        # mode they don't own. Gate the slug on a syntactic policy
        # first: a built-in slug (the four migrations/013 seed entries)
        # always passes; any other slug must look like a snake-case
        # identifier (lower-case letters / digits / underscore, ≤ 64
        # chars) before we'll ask the DB. Garbage from the LLM
        # collapses to the safe `scene_recreation` default before any
        # I/O happens.
        slug_raw = intent.args.get("mode_slug") or "scene_recreation"
        slug = _normalize_mode_slug(slug_raw) or "scene_recreation"
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

    if intent.intent == "list_resume_versions":
        # Read-only: list what the user has and reply inline as text.
        # No artifact card, no jump to /app/studio/resume. The whole point
        # of this branch (user feedback 2026-06-22) is that "查看简历版本"
        # must NOT surface "Open résumé / Tweak in studio" buttons — the
        # agent already has everything it needs to answer in the dock.
        #
        # We tag the response as ``action: "reply"`` so the TS gateway
        # (api/src/routes/ask.ts § "Smalltalk replies arrive as ...") takes
        # the text-only path and skips buildArtifact entirely. The original
        # intent is preserved in ``source_action`` for audit + future analytics.
        rows = await load_resume_versions(user_id)
        text = format_resume_versions_reply(rows, has_cjk=bool(re.search(r"[぀-ヿ㐀-鿿]", message)))
        return {
            "agent": "coordinator",
            "action": "reply",
            "text": text,
            "source_action": "list_resume_versions",
            "count": len(rows),
        }

    if intent.intent == "analyze_resume":
        # Weakest-spots critique — inline text reply (no studio jump). Reads the
        # current original and runs resume_agent.analyze + a short LLM critique.
        return await _analyze_resume_reply(user_id, message)

    if intent.intent == "optimize_resume":
        # No-JD best-practice pass (design §6.1/§6.3). Resolve the current
        # original, run optimize_general, and return the suggestion stack so the
        # API can stream it back as a suggestion-list artifact card.
        from agents.nodes import resume_agent, resume_store

        original = await resume_store.get_current_original(user_id)
        if not original:
            return _no_resume_reply(bool(re.search(r"[぀-ヿ㐀-鿿]", message)))
        result = await resume_agent.optimize_general(UUID(original["id"]), user_id=user_id)
        return {
            "agent": "resume_agent",
            "action": "optimize_general",
            "suggestions": result.get("suggestions", []),
            "optimized_resume_id": result.get("optimized_resume_id"),
            "source_resume_id": original["id"],
        }

    if intent.intent == "map_career_moves":
        return await _career_moves_reply(user_id, message)

    if intent.intent == "surface_roles":
        # Roles matching the current résumé. Routes into job search with a
        # "from current résumé" hint; the API maps this onto jobmatch and the
        # dock offers a jump to /app/jobs.
        return {
            "agent": "jobmatch_agent",
            "action": "find_matches",
            "from_resume": True,
            "args": intent.args,
        }

    if intent.intent == "update_resume":
        return {"agent": "resume_agent", "action": "update_field", "status": "needs_clarification"}

    if intent.intent == "review_application":
        return {"agent": "appprep_agent", "action": "review", "status": "not_implemented_yet"}

    if intent.intent == "list_applications":
        from agents.tools.applications import list_applications

        rows = await list_applications(user_id=user_id)
        return {
            "agent": "applications",
            "action": "list",
            "count": len(rows),
            # Trim to the fields the dock surface card uses so we don't blow
            # past frame size on a 100-row pipeline. Full data is in PG; if
            # the agent needs more it can ask for a specific row.
            "items": [
                {
                    "id": r.get("id"),
                    "company": r.get("company"),
                    "role_title": r.get("role_title"),
                    "status": r.get("status"),
                }
                for r in rows[:25]
            ],
        }

    if intent.intent == "move_application":
        # We don't resolve "Stripe" → an application_id from here — that
        # requires a name match against application_drafts.company and
        # potentially user disambiguation when the user has multiple Stripe
        # applications. Return needs_clarification with what we extracted so
        # the UI / next-turn prompt can ask the right question. Once the
        # web side wires up "Vantage says: which Stripe row?" we'll add the
        # lookup here. For now the agent surface is informational + the
        # web drawer / drag-drop remains the live edit path.
        return {
            "agent": "applications",
            "action": "move",
            "status": "needs_clarification",
            "needs": ["application_id"],
            "company_hint": intent.args.get("company"),
            "target_status": intent.args.get("target_status"),
        }

    if intent.intent == "set_application_outcome":
        return {
            "agent": "applications",
            "action": "set_outcome",
            "status": "needs_clarification",
            "needs": ["application_id", "outcome"],
            "company_hint": intent.args.get("company"),
        }

    # 'other' → small-talk fallback (free, V4 Flash).
    return await _smalltalk_reply(
        message, thread_id=thread_id, user_id=user_id, surface=surface, locale=locale
    )


async def _smalltalk_reply(
    message: str,
    thread_id: str | None = None,
    user_id: UUID | None = None,
    surface: str | None = None,
    locale: str | None = None,
) -> dict[str, Any]:
    # Load the last few turns of this lifetime thread so the reply has memory
    # (vantage-ui-mapping.md § 1.2). Best-effort: no history if PG is down.
    history: list[BaseMessage] = []
    if thread_id:
        try:
            history = await load_recent_turns(thread_id, limit=6)
        except Exception as exc:  # noqa: BLE001 — boundary, never break the reply
            # A transient DB problem (auth failure, query error) must degrade to a
            # context-free reply, not replace the whole reply with an error frame.
            log.error(
                "router.load_recent_turns_failed",
                thread_id=thread_id,
                error=redact_exception_text(str(exc)),
            )
            history = []

    # Resume Studio surface → pull the current master résumé and attach it as
    # an extra system block so "介绍一下这个人 / analyze this résumé" land with
    # the actual document, not a blank context. Best-effort: when there is no
    # résumé yet, or PG is unreachable, we just skip the block (the reply still
    # works, it'll just be the generic "upload one to get started" line).
    resume_block: str | None = None
    if surface == "resume_studio" and user_id is not None:
        try:
            resume_block = await load_active_resume_brief(user_id)
        except Exception as exc:  # noqa: BLE001 — boundary
            log.error(
                "router.load_active_resume_brief_failed", error=redact_exception_text(str(exc))
            )
            resume_block = None

    # Two language pins (see api/server.py ask_stream for the same posture):
    #   1. UI-locale directive — global preference (X-Relay-Locale)
    #   2. reply_locale directive — language of THIS user message
    # We add #2 LAST so it sits adjacent to the user turn; recency makes it
    # the strongest signal when UI and message languages disagree.
    language_directive = build_language_directive(locale, message)
    reply_locale = detect_reply_locale(message, locale)
    reply_directive = reply_language_directive(reply_locale)

    system_parts = [
        "You are Vantage, an AI job-search copilot. Reply briefly and "
        "redirect the user gently to what you can do: find roles, sharpen "
        "résumés, draft cover letters, run mocks, surface market trends, "
        "or build a résumé from scratch.",
        language_directive,
    ]
    if resume_block:
        system_parts.append(
            "The user is currently viewing their master résumé in Resume "
            "Studio. Treat the following JSON as the live document and refer "
            "to it when the user says '这个人' / 'this résumé' / 'me' / 'I'. "
            "Never invent experience that isn't in it. If asked to introduce "
            "the person, summarise from the résumé itself.\n\n"
            f"<active_resume>\n{resume_block}\n</active_resume>"
        )
    # Append the reply-locale directive LAST so it lands closest to the user
    # turn in the system block stack (recency wins ties for most models).
    system_parts.append(reply_directive)
    log.info(
        "router.smalltalk_reply_locale",
        ui_locale=locale,
        reply_locale=reply_locale,
        message_chars=len(message or ""),
    )

    import asyncio as _asyncio  # local import — see DISP5 note at top of file

    model = pick_model("fast", temperature=0.7, max_tokens=400)
    try:
        # DISP5 (round-6): same hard timeout as llm_intent_classifier so
        # a stuck OpenRouter call can't hold the SSE stream open. Failure
        # here returns a friendly fallback rather than propagating up,
        # because this is the small-talk path — the user just asked a
        # casual question, not a high-stakes agent action.
        resp = await _asyncio.wait_for(
            model.ainvoke(
                [
                    SystemMessage(content="\n\n".join(system_parts)),
                    *history,
                    HumanMessage(content=message[:1000]),
                ]
            ),
            timeout=_ROUTER_LLM_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001 boundary
        log.error(
            "smalltalk_reply.failed", error=redact_exception_text(str(exc)), kind=type(exc).__name__
        )
        return {
            "agent": "coordinator",
            "action": "reply",
            "text": "Sorry — I couldn't respond just now. Please try again in a moment.",
        }
    return {"agent": "coordinator", "action": "reply", "text": str(resp.content)}


async def load_resume_versions(user_id: UUID) -> list[dict[str, Any]]:
    """Return every résumé row for this user, newest first.

    Read-only helper for the ``list_resume_versions`` intent. Returns
    [] when PG isn't configured (dev / tests) or the user has none yet
    so the caller can degrade to a friendly "you don't have one — want
    to upload?" reply instead of an error frame.
    """
    dsn = _resolve_pg_dsn()
    if not dsn:
        return []

    import psycopg
    from psycopg.rows import dict_row

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT version, is_base, tailored_for_job, created_at,
                       coalesce(content -> 'basics' ->> 'name', '') AS owner_name,
                       coalesce(content -> 'basics' ->> 'label', '') AS headline
                FROM resumes
                WHERE user_id = %s
                ORDER BY version DESC
                LIMIT 50
                """,
                (str(user_id),),
            )
            rows = await cur.fetchall()
    return rows


def format_resume_versions_reply(rows: list[dict[str, Any]], has_cjk: bool) -> str:
    """Render the version list as a plain-text dock reply.

    Language follows the user's last message (CJK → Chinese, else English)
    so the dock doesn't suddenly switch language between turns. Each line
    is short on purpose — the dock truncates long bubbles and the user
    asked specifically not to be sent elsewhere to "actually look at it".
    """
    if not rows:
        if has_cjk:
            return "你还没有简历版本。直接上传一份 PDF/DOCX,我可以解析进来——或者跟我说几句你的经历,我从空白开始帮你建。"
        return "You don't have any résumé versions yet. Upload a PDF/DOCX and I'll parse it in, or tell me about your background and I'll build one from scratch."

    base_rows = [r for r in rows if r.get("is_base")]
    tailored_rows = [r for r in rows if not r.get("is_base")]
    latest_base = base_rows[0] if base_rows else None

    lines: list[str] = []
    if has_cjk:
        lines.append(f"你目前有 {len(rows)} 个简历版本:")
        if latest_base:
            lines.append(
                f"• 当前主版本 v{latest_base['version']} · 创建于 "
                f"{latest_base['created_at']:%Y-%m-%d}"
            )
        for r in base_rows[1:6]:
            lines.append(f"• 历史主版本 v{r['version']} · {r['created_at']:%Y-%m-%d}")
        if tailored_rows:
            lines.append(f"\n针对岗位定制的版本 ({len(tailored_rows)} 份,最近 5 份):")
            for r in tailored_rows[:5]:
                job = r.get("tailored_for_job")
                jd_hint = f"岗位 {str(job)[:8]}…" if job else "无岗位标记"
                lines.append(f"• v{r['version']} · {jd_hint} · {r['created_at']:%Y-%m-%d}")
        return "\n".join(lines)

    lines.append(f"You have {len(rows)} résumé version(s):")
    if latest_base:
        lines.append(
            f"• Current master v{latest_base['version']} — saved "
            f"{latest_base['created_at']:%Y-%m-%d}"
        )
    for r in base_rows[1:6]:
        lines.append(f"• Older master v{r['version']} — {r['created_at']:%Y-%m-%d}")
    if tailored_rows:
        lines.append(f"\nTailored variants ({len(tailored_rows)} total, last 5):")
        for r in tailored_rows[:5]:
            job = r.get("tailored_for_job")
            jd_hint = f"for job {str(job)[:8]}…" if job else "no job link"
            lines.append(f"• v{r['version']} · {jd_hint} · {r['created_at']:%Y-%m-%d}")
    return "\n".join(lines)


# ───────────────────────────────────────────────────────────────────────
# Dual-track inline replies (design §6 / §1.4 "This résumé" chips)
# ───────────────────────────────────────────────────────────────────────


def _no_resume_reply(has_cjk: bool) -> dict[str, Any]:
    text = (
        "你还没有简历。先上传一份 PDF/DOCX,我就能分析了。"
        if has_cjk
        else "You don't have a résumé yet. Upload a PDF/DOCX and I'll take a look."
    )
    return {"agent": "coordinator", "action": "reply", "text": text}


async def _analyze_resume_reply(user_id: UUID, message: str) -> dict[str, Any]:
    """Weakest-spots critique as an inline dock reply. Grounded on the current
    original; the prompt forbids inventing anything not in the résumé."""
    has_cjk = bool(re.search(r"[぀-ヿ㐀-鿿]", message))
    brief = await load_active_resume_brief(user_id)
    if not brief:
        return _no_resume_reply(has_cjk)
    sys = (
        "You are a blunt but constructive résumé reviewer. Given the résumé JSON, "
        "name the 3 weakest spots — cite the exact bullet or section and say what to "
        "change. Critique ONLY what is written; never invent skills, employers, dates, "
        "or metrics. Answer in the user's language. Keep it tight: 3 short numbered points."
    )
    model = pick_model("general", temperature=0.3, max_tokens=700)
    try:
        import asyncio as _asyncio

        resp = await _asyncio.wait_for(
            model.ainvoke([SystemMessage(content=sys), HumanMessage(content=brief)]),
            timeout=_ROUTER_LLM_TIMEOUT_S,
        )
        text = str(resp.content).strip()
    except Exception as exc:  # noqa: BLE001 boundary
        log.error("analyze_resume_reply.failed", error=redact_exception_text(str(exc)))
        text = (
            "我现在分析不了,稍后再试。"
            if has_cjk
            else "I couldn't analyze that right now — try again in a moment."
        )
    return {
        "agent": "resume_agent",
        "action": "reply",
        "text": text,
        "source_action": "analyze_resume",
    }


async def _career_moves_reply(user_id: UUID, message: str) -> dict[str, Any]:
    """Next 1–2 career moves + the skills to close, as an inline reply."""
    has_cjk = bool(re.search(r"[぀-ヿ㐀-鿿]", message))
    brief = await load_active_resume_brief(user_id)
    if not brief:
        return _no_resume_reply(has_cjk)
    sys = (
        "You are a career coach. From the résumé's trajectory, suggest the next 1–2 "
        "realistic moves and, for each, the 1–2 skills the candidate would need to close "
        "to get there. Base everything on what's actually in the résumé — no fabrication. "
        "Answer in the user's language, concise."
    )
    model = pick_model("general", temperature=0.4, max_tokens=700)
    try:
        import asyncio as _asyncio

        resp = await _asyncio.wait_for(
            model.ainvoke([SystemMessage(content=sys), HumanMessage(content=brief)]),
            timeout=_ROUTER_LLM_TIMEOUT_S,
        )
        text = str(resp.content).strip()
    except Exception as exc:  # noqa: BLE001 boundary
        log.error("career_moves_reply.failed", error=redact_exception_text(str(exc)))
        text = (
            "我现在给不了建议,稍后再试。"
            if has_cjk
            else "I couldn't map that out right now — try again in a moment."
        )
    return {
        "agent": "trend_agent",
        "action": "reply",
        "text": text,
        "source_action": "map_career_moves",
    }


async def load_active_resume_brief(user_id: UUID, max_chars: int = 4000) -> str | None:
    """Return a compact JSON brief of the user's current master résumé.

    Picks the highest-version row with ``is_base = true`` and trims a few
    typically-large fields (work descriptions, project highlights) so the brief
    fits comfortably alongside the system prompt. Returns ``None`` when the
    user has no résumé yet or PG isn't configured.
    """
    dsn = _resolve_pg_dsn()
    if not dsn:
        return None

    import psycopg
    from psycopg.rows import dict_row

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT content, version
                FROM resumes
                WHERE user_id = %s AND is_base = true
                ORDER BY version DESC
                LIMIT 1
                """,
                (str(user_id),),
            )
            row = await cur.fetchone()
            # Fallback: if the master row is a fallback parse (empty
            # basics/work) but a downstream optimize / customize produced a
            # populated sibling, surface that one instead. analyze_resume
            # would otherwise critique an empty document and tell the user
            # to add their name + jobs even though the data is already in PG.
            content = (row or {}).get("content") or {}
            looks_empty = not (content.get("basics") or {}) or not (content.get("work") or [])
            if looks_empty:
                await cur.execute(
                    """
                    SELECT content
                    FROM resumes
                    WHERE user_id = %s
                      AND content ? 'work'
                      AND jsonb_array_length(content->'work') > 0
                    ORDER BY version DESC
                    LIMIT 1
                    """,
                    (str(user_id),),
                )
                better = await cur.fetchone()
                if better and better.get("content"):
                    row = better
    if not row:
        return None

    content = row["content"] or {}
    brief = _compact_resume_brief(content, max_chars=max_chars)
    return brief or None


def _compact_resume_brief(content: dict[str, Any], max_chars: int) -> str:
    """Render a small, model-friendly JSON snapshot of a JSON Resume document.

    Drops sections that are usually long-tail noise (interests, references,
    languages metadata) and clips bullets per role so a verbose résumé still
    fits. Falls back to a length-bounded JSON dump if the document doesn't
    look like JSON Resume — better something than nothing.
    """
    if not isinstance(content, dict):
        return json.dumps(content, ensure_ascii=False)[:max_chars]

    basics = content.get("basics") or {}
    work = content.get("work") or []
    education = content.get("education") or []
    skills = content.get("skills") or []
    projects = content.get("projects") or []

    def _clip_list(items: list[Any], n: int) -> list[Any]:
        return items[:n] if isinstance(items, list) else []

    compact: dict[str, Any] = {
        "basics": {
            k: basics.get(k)
            for k in ("name", "label", "headline", "email", "phone", "location", "summary")
            if basics.get(k)
        },
        "work": [
            {
                k: w.get(k)
                for k in ("name", "company", "position", "startDate", "endDate", "summary")
                if w.get(k)
            }
            | (
                {"highlights": _clip_list(w.get("highlights") or [], 4)}
                if w.get("highlights")
                else {}
            )
            for w in _clip_list(work, 5)
            if isinstance(w, dict)
        ],
        "education": [
            {
                k: e.get(k)
                for k in ("institution", "studyType", "area", "startDate", "endDate")
                if e.get(k)
            }
            for e in _clip_list(education, 3)
            if isinstance(e, dict)
        ],
        "skills": [
            {k: s.get(k) for k in ("name", "keywords", "level") if s.get(k)}
            for s in _clip_list(skills, 8)
            if isinstance(s, dict)
        ],
        "projects": [
            {k: p.get(k) for k in ("name", "description", "url") if p.get(k)}
            for p in _clip_list(projects, 4)
            if isinstance(p, dict)
        ],
    }

    rendered = json.dumps(compact, ensure_ascii=False)
    if len(rendered) <= max_chars:
        return rendered
    # Last-resort trim — keep it parseable as a string for the model.
    return rendered[: max_chars - 1] + "…"


# ───────────────────────────────────────────────────────────────────────
# Thread persistence — ask_vantage lifetime conversation (PG 007 tables)
# ───────────────────────────────────────────────────────────────────────
#
# The ask_vantage dock holds ONE lifetime conversation per user
# (vantage-ui-mapping.md § 1.2). We mirror each turn into conversation_messages
# keyed by a conversation_sessions row whose ``title`` is the thread_id. This is
# the same pair of tables the TS /api/chat uses (infra/postgres/migrations/007),
# so history is shared and durable. LangGraph's PostgresSaver still owns the
# checkpoint state for in-flight workflows; this is the human-readable turn log
# that powers context-aware small talk.


# Env vars that may carry the PG DSN, in resolution order. The agents layer has
# historically read ``RELAY_PG_DSN`` only, but the root .env ships ``DATABASE_URL``
# (infra/CLAUDE.md, PG on 5433) — so a normal boot left both persist + history
# load silently no-op'ing. Falling back across the names that actually exist keeps
# the dock's multi-turn memory working without requiring an extra env var.
_PG_DSN_ENV_VARS = ("RELAY_PG_DSN", "DATABASE_URL", "POSTGRES_URL")


def _resolve_pg_dsn() -> str | None:
    """Resolve the Postgres DSN from the first env var that is set.

    Order: ``RELAY_PG_DSN`` → ``DATABASE_URL`` → ``POSTGRES_URL``. Returns None
    (and logs a warning) when none are set so callers degrade gracefully instead
    of failing silently. Shared by persist_turn + load_recent_turns so the read
    and write paths can never drift onto different DSNs.
    """
    for name in _PG_DSN_ENV_VARS:
        dsn = os.environ.get(name)
        if dsn:
            return dsn
    log.warning(
        "router.pg_dsn_unresolved",
        tried=_PG_DSN_ENV_VARS,
        detail="conversation persistence + history load disabled (no PG DSN env var set)",
    )
    return None


async def load_recent_turns(thread_id: str, limit: int = 6) -> list[BaseMessage]:
    """Load the last ``limit`` turns of this thread as LangChain messages.

    Best-effort: returns [] if PG is unconfigured/unreachable (dev/tests).
    """
    dsn = _resolve_pg_dsn()
    if not dsn:
        return []

    import psycopg
    from psycopg.rows import dict_row

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT m.role, m.content
                FROM conversation_messages m
                JOIN conversation_sessions s ON s.id = m.session_id
                WHERE s.title = %s
                ORDER BY m.created_at DESC
                LIMIT %s
                """,
                (thread_id, limit),
            )
            rows = await cur.fetchall()

    msgs: list[BaseMessage] = []
    for r in reversed(rows):  # chronological order for the model
        content = str(r["content"])
        if r["role"] == "user":
            msgs.append(HumanMessage(content=content))
        else:
            msgs.append(AIMessage(content=content))
    return msgs


# PT3 (round-10): both this Python persister and the TS gateway's
# /api/ask/stream history insert (api/src/routes/ask.ts) must agree on
# the persisted-text cap or one side silently grows unbounded. 8000 was
# already the de-facto cap here; lift it to a constant so the TS side
# can mirror it. Append an explicit marker when we truncate so support
# (and round-N audits) can tell "the user actually wrote this" apart
# from "we cut the tail". A trailing ellipsis alone would be ambiguous
# because real users do type "..."; "…(truncated)" is unique enough.
_PERSIST_TURN_MAX_CHARS = 8000
_PERSIST_TRUNC_MARKER = "…(truncated)"


def _truncate_for_history(text: str, max_chars: int = _PERSIST_TURN_MAX_CHARS) -> str:
    """Codepoint-safe truncation with a visible marker.

    Python's [:N] slice already works in codepoints, so the leftover
    string is always valid UTF-8. The marker tells future readers (and
    audits) that the tail is missing.
    """
    if text is None:
        return ""
    if len(text) <= max_chars:
        return text
    keep = max_chars - len(_PERSIST_TRUNC_MARKER)
    return text[:keep] + _PERSIST_TRUNC_MARKER


async def persist_turn(
    thread_id: str, user_id: UUID, user_message: str, assistant_text: str
) -> None:
    """Append a (user, assistant) turn to the lifetime thread.

    Upserts the conversation_sessions row (one per thread_id), then inserts both
    messages. Best-effort: silently no-ops if PG is unconfigured (dev/tests) and
    logs on real failures so a logging hiccup never breaks the dock response.
    """

    dsn = _resolve_pg_dsn()
    if not dsn:
        return
    try:
        import psycopg

        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                # One session row per lifetime / secondary dock thread.
                #
                # Migration 019 added a dedicated `thread_id` column so the
                # multi-session UI can list / rename / delete sessions without
                # overloading `title` (which now carries the user-facing
                # label). For backward-compat with rows persisted before 019
                # we look up by either column.
                await cur.execute(
                    "SELECT id FROM conversation_sessions "
                    "WHERE COALESCE(thread_id, title) = %s LIMIT 1",
                    (thread_id,),
                )
                row = await cur.fetchone()
                preview = _truncate_for_history(user_message, max_chars=160)
                if row:
                    session_id = row[0]
                    await cur.execute(
                        "UPDATE conversation_sessions "
                        "SET last_active_at = now(), "
                        "    message_count = message_count + 2, "
                        "    last_preview = %s, "
                        "    thread_id = COALESCE(thread_id, %s) "
                        "WHERE id = %s",
                        (preview, thread_id, session_id),
                    )
                else:
                    # New rows write the dedicated thread_id column AND keep
                    # title NULL — the UI derives a friendly label
                    # ("Conversation · MMM d") until the user renames it.
                    await cur.execute(
                        """
                        INSERT INTO conversation_sessions
                            (user_id, session_type, agent_type,
                             title, thread_id, last_preview, message_count)
                        VALUES (%s, 'ask_vantage', 'coordinator',
                                NULL, %s, %s, 2)
                        RETURNING id
                        """,
                        (str(user_id), thread_id, preview),
                    )
                    session_id = (await cur.fetchone())[0]  # type: ignore[index]

                await cur.execute(
                    "INSERT INTO conversation_messages (session_id, role, content) "
                    "VALUES (%s, 'user', %s), (%s, 'assistant', %s)",
                    (
                        session_id,
                        _truncate_for_history(user_message),
                        session_id,
                        _truncate_for_history(assistant_text),
                    ),
                )
            await conn.commit()
    except Exception as exc:  # noqa: BLE001 — boundary, never break the reply
        log.error(
            "router.persist_turn_failed", thread_id=thread_id, error=redact_exception_text(str(exc))
        )


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        return json.loads(s)
    except json.JSONDecodeError:
        return {}
