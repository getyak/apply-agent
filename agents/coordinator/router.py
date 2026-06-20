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

from agents.harness.llm import pick_model

log = structlog.get_logger("agents.coordinator.router")

# DISP5 (round-6): every LLM call in this module is wrapped with this
# timeout so a hanging upstream (OpenRouter, DeepSeek, GLM) can never
# stall the SSE stream indefinitely. The round-6 audit flagged that
# both classify_intent and _smalltalk_reply called ainvoke unguarded;
# a 30s deadline matches the upper bound stated in agent-harness.md.
_ROUTER_LLM_TIMEOUT_S = float(os.environ.get("RELAY_ROUTER_LLM_TIMEOUT_S", "30"))

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
    # Applications kanban — move a row between columns, list the user's
    # pipeline, or record an outcome. Lives in the agent's surface so a
    # user can say "move Stripe to interviewing" inside any vibe chat.
    "list_applications",
    "move_application",
    "set_application_outcome",
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


_COMPANY_HINT = re.compile(r"\bfor\s+([A-Z][a-zA-Z0-9&\-]+(?:\s+[A-Z][a-zA-Z0-9&\-]+){0,2})\b")
_MODE_HINT = re.compile(r"\b(scene\s+recreation|pressure\s+drill|warm[\s-]?up|rapid\s+fire)\b", re.I)
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
        slug = {"scene_recreation": "scene_recreation", "pressure_drill": "pressure_drill",
                "warmup": "warm_up", "warm_up": "warm_up", "rapid_fire": "rapid_fire"}.get(slug, slug)
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
        log.error("llm_intent_classifier.failed", error=str(exc), kind=type(exc).__name__)
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


async def dispatch(
    intent: Intent,
    user_id: UUID,
    message: str,
    thread_id: str | None = None,
    surface: str | None = None,
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
        message, thread_id=thread_id, user_id=user_id, surface=surface
    )


async def _smalltalk_reply(
    message: str,
    thread_id: str | None = None,
    user_id: UUID | None = None,
    surface: str | None = None,
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
                "router.load_recent_turns_failed", thread_id=thread_id, error=str(exc)
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
            log.error("router.load_active_resume_brief_failed", error=str(exc))
            resume_block = None

    # Language fidelity: the chat history shipped Chinese user turns next to
    # English agent turns — see the QA pass UX notes. The fix is small but
    # uncompromising: detect once from the *latest* user turn and pin the
    # reply language for the whole response. We hand the model a simple
    # heuristic so it doesn't have to think about it.
    has_cjk = bool(re.search(r"[぀-ヿ㐀-鿿]", message))
    language_directive = (
        "Reply in the same language the user just wrote in. The user's "
        "latest message is "
        + (
            "written with CJK characters — reply in Chinese unless the user "
            "explicitly asks for English. "
            if has_cjk
            else "written in a Latin script — reply in English unless the user "
            "explicitly asks for another language. "
        )
        + "Never mix two languages in a single reply, and do not translate "
        "technical terms / brand names that should stay in their original form."
    )

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
        log.error("smalltalk_reply.failed", error=str(exc), kind=type(exc).__name__)
        return {
            "agent": "coordinator",
            "action": "reply",
            "text": "Sorry — I couldn't respond just now. Please try again in a moment.",
        }
    return {"agent": "coordinator", "action": "reply", "text": str(resp.content)}


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
            | ({"highlights": _clip_list(w.get("highlights") or [], 4)} if w.get("highlights") else {})
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
            {
                k: p.get(k)
                for k in ("name", "description", "url")
                if p.get(k)
            }
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
                # One session row per lifetime thread, identified by title.
                await cur.execute(
                    "SELECT id FROM conversation_sessions WHERE title = %s LIMIT 1",
                    (thread_id,),
                )
                row = await cur.fetchone()
                if row:
                    session_id = row[0]
                    await cur.execute(
                        "UPDATE conversation_sessions "
                        "SET last_active_at = now(), message_count = message_count + 2 "
                        "WHERE id = %s",
                        (session_id,),
                    )
                else:
                    await cur.execute(
                        """
                        INSERT INTO conversation_sessions
                            (user_id, session_type, agent_type, title, message_count)
                        VALUES (%s, 'general', 'coordinator', %s, 2)
                        RETURNING id
                        """,
                        (str(user_id), thread_id),
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
        log.error("router.persist_turn_failed", thread_id=thread_id, error=str(exc))


def _safe_json(content: Any) -> dict[str, Any]:
    try:
        s = str(content).strip()
        if s.startswith("```"):
            s = "\n".join(line for line in s.splitlines() if not line.startswith("```"))
        return json.loads(s)
    except json.JSONDecodeError:
        return {}
