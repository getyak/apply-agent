"""Dock Agent — main-loop ReAct agent for the Ask Vantage dock.

Design reference: docs/design/chat-agent-system-redesign.md §5.1 (P0-A) +
§5.2 (P0-B).

Caller:
  - ``agents.api.server.ask_stream`` builds + invokes the graph per turn,
    translating LangGraph events into the existing 5-event SSE protocol
    plus the new ``task_graph`` / ``hitl`` events.

Behavior:
  - Pure ``create_react_agent`` (LangGraph prebuilt) with our DOCK_TOOLS
    registry — propose_plan + 4 domain tools + 3 recall tools + 3 admin
    tools (build_resume, list_apps, trends_today).
  - General-tier model (GLM-4.7) by default. Heavy-tier fallback only
    when a plan step explicitly marks ``requires_review=true`` for a
    high-cost decision (not implemented in P0; the registry is in place).
  - Same PostgresSaver as the rest of the agent layer
    (``harness.checkpointer.get_checkpointer``) so the dock keeps a
    durable per-user thread and HITL ``interrupt()`` calls resume cleanly.
  - The cheap regex router stays as a **fast path** in ``server.ask_stream``
    (confidence ≥ 0.95 → direct dispatch, no main-loop LLM call). This
    file only handles the cases the regex misses.

Notes on harness wiring:
  - ``post_model_hook`` from ``harness.guards`` is registered so token /
    cost guards work the same way they do for other graphs. The hook
    operates on the state dict and is NOT subject to LangGraph #4841
    (we don't rely on InjectedState).
  - Context window compaction is delegated to ``harness.context.maybe_compact``
    on each turn entry (server.ask_stream does this; not the agent).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import structlog
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.prebuilt import create_react_agent

from agents.coordinator.dock_tools import DOCK_TOOLS
from agents.harness.checkpointer import get_checkpointer
from agents.harness.context import dock_pre_model_hook
from agents.harness.guards import post_model_hook
from agents.harness.llm import pick_model

log = structlog.get_logger("agents.coordinator.dock_agent")


DOCK_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "coordinator" / "dock_agent.v1.md"


@dataclass(frozen=True)
class DockEvent:
    """One observable event from a dock turn, normalised across LangGraph stream types.

    ``kind`` is one of:
      - "plan"             — propose_plan tool returned; payload = plan dict
      - "narrator"         — narrate() tool returned; payload = {text}
      - "tool_start"       — execution tool started; payload = {tool, args}
      - "tool_end"         — execution tool finished; payload = {tool, result}
      - "tool_error"       — execution tool raised; payload = {tool, error}
      - "assistant_delta"  — model text delta; payload = {text}
      - "reasoning_delta"  — model chain-of-thought delta (when the picked
        tier returns OpenRouter ``reasoning``); payload = {text}. A single
        chat-model chunk can produce *both* a reasoning_delta and an
        assistant_delta in the same tick; the multi-event translator
        emits both, in reasoning-then-text order.
      - "partial_artifact" — Step 5: a tool emitted an in-progress snapshot
        of the artifact it's still building. payload = {artifact_id, kind,
        title?, sub?, progress, payload}. The dock UI merges these
        snapshots into a single live card by ``artifact_id``.
      - "interrupt"        — graph hit ``interrupt()``; payload = {value}
      - "done"             — graph completed normally
    """

    kind: str
    payload: dict[str, Any]


# Tool result body cap. Anything larger gets stringified to this limit and
# suffixed with "…[truncated]" so a single 100k-row find_matches dump can't
# bloat an SSE frame. 8 KiB matches what the dock JsonBlock renders (~200
# lines of pretty JSON); raise both ends together if you ever change it.
_TOOL_RESULT_CAP_BYTES = 8 * 1024


@lru_cache(maxsize=1)
def _load_dock_prompt() -> str:
    try:
        return DOCK_PROMPT_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        # Defensive: tests sometimes patch the prompt path; surface as empty
        # rather than crash so the dock still has a model session to fall
        # back on (the LLM gets a less-opinionated system prompt).
        log.warning("dock_agent.prompt_missing", path=str(DOCK_PROMPT_PATH))
        return "You are Vantage. Reply briefly."


@lru_cache(maxsize=4)
def build_dock_graph(tier: str = "general"):
    """Build (and cache) the dock ReAct graph.

    Cached by tier so a future "premium" path can swap the model without
    leaking graphs. Each instance owns its own checkpointer reference,
    which itself is cached at ``get_checkpointer``-level, so this is safe
    to keep around for the process lifetime.

    Returns the compiled LangGraph, ready for ``ainvoke`` /
    ``astream_events``.
    """
    if tier not in ("heavy", "general", "fast"):
        raise ValueError(f"invalid dock tier: {tier!r}")
    model = pick_model(tier, temperature=0.4, max_tokens=2_048)
    checkpointer = get_checkpointer()
    graph = create_react_agent(
        model=model,
        tools=DOCK_TOOLS,
        prompt=_load_dock_prompt(),
        checkpointer=checkpointer,
        # pre_model_hook: iteration / consecutive-error budget AND token-budget
        # compaction. dock_pre_model_hook composes guards.pre_model_hook with
        # harness.context.maybe_compact so a long lifetime dock thread auto-
        # summarises older turns when it crosses the 80k token line set by
        # post_model_hook. Without this, long Ask Vantage sessions would
        # silently bloat their context window.
        pre_model_hook=dock_pre_model_hook,
        # post_model_hook gives us token + cost guards (see harness/guards.py).
        # Cost gets sourced from the contextvar cost_tracker tally so direct
        # model.ainvoke paths (resume_agent.customize etc.) also accumulate.
        post_model_hook=post_model_hook,
    )
    return graph


async def run_dock_turn(
    *,
    message: str,
    thread_id: str,
    extra_system_blocks: list[str] | None = None,
    recursion_limit: int = 12,
    tier: str = "general",
    graph_factory=None,
):
    """Yield ``DockEvent``s for one user turn.

    The caller (``agents.api.server.ask_stream``) is responsible for:
      - regex fast-path (confidence ≥ 0.95 → direct dispatch, skip this)
      - setting the dock contextvars via
        ``agents.coordinator.dock_tools.set_dock_context`` *before*
        calling this generator.
      - persisting the turn into conversation_messages once the stream
        settles.

    ``extra_system_blocks`` are appended after the base prompt for
    surface-specific context (e.g. resume_studio active résumé brief).
    They're sent as additional SystemMessages so the persistent prompt
    on the graph stays cacheable.

    ``recursion_limit`` caps the ReAct loop's depth. Default 12 = up to
    6 thought/tool pairs. Higher values cost real money; lift it only if
    you have a workflow that genuinely needs it.

    ``graph_factory`` is a test seam — pass a zero-arg callable that
    returns a pre-wired graph (e.g. one with a mock model + MemorySaver).
    Production callers leave it as ``None`` to use ``build_dock_graph``.
    """
    graph = graph_factory() if graph_factory else build_dock_graph(tier=tier)
    cfg: dict[str, Any] = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": recursion_limit,
    }

    extras = [SystemMessage(content=blk) for blk in (extra_system_blocks or []) if blk]
    messages = [*extras, HumanMessage(content=message)]

    async for event in graph.astream_events({"messages": messages}, version="v2", config=cfg):
        for evt in _translate_event_multi(event):
            yield evt


async def emit_partial_artifact(
    *,
    artifact_id: str,
    kind: str,
    progress: float | None = None,
    title: str | None = None,
    sub: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Stream an in-progress artifact snapshot from inside a LangGraph tool.

    Step 5 contract — long-running tools (e.g. tailor_resume) call this
    repeatedly as they generate; the dock UI merges the snapshots into a
    single live card identified by ``artifact_id``. The final tool_end
    still produces the canonical artifact frame; partials are
    *previews*, not authoritative state.

    Args:
      artifact_id: stable id the dock uses to merge updates. Reuse the
        same id across calls within one tool invocation.
      kind: human-meaningful category — "resume_bullet" / "cover_letter" /
        "form_answers" / ... — purely descriptive, the dock chooses how
        to render based on this.
      progress: optional 0.0–1.0 completion estimate. ``None`` for tools
        that can't estimate.
      title: short header ("Tailored résumé v7"). Updates the card title.
      sub: one-line subline ("Bullet 2 of 5"). Updates each tick.
      payload: free-form chunk content. The dock will merge by ``kind``:
        for resume_bullet etc., the payload is appended to a list under
        ``payload.items``; otherwise replaced wholesale.

    The dispatcher is a no-op outside a LangGraph callback context — so
    calling this from tests / a REPL won't crash, it just logs no event.
    """
    from langchain_core.callbacks.manager import adispatch_custom_event

    data: dict[str, Any] = {"artifact_id": artifact_id, "kind": kind}
    if progress is not None:
        data["progress"] = max(0.0, min(1.0, float(progress)))
    if title is not None:
        data["title"] = str(title)[:200]
    if sub is not None:
        data["sub"] = str(sub)[:200]
    if payload is not None:
        data["payload"] = payload
    try:
        await adispatch_custom_event("partial_artifact", data)
    except RuntimeError:
        # Outside a callback context (no run_manager). Treat as no-op so
        # tools can call this freely during unit tests without monkey
        # patching the callback runner.
        log.debug("emit_partial_artifact.no_runner", artifact_id=artifact_id)


def _translate_event_multi(event: dict[str, Any]) -> list[DockEvent]:
    """Translate one LangGraph stream event into 0..n DockEvents.

    Most LangGraph events still map 1:1 — those delegate straight to the
    single-event ``_translate_event``. The exception is
    ``on_chat_model_stream``: a single chunk may carry *both* a reasoning
    delta (provider chain-of-thought, surfaced when OpenRouter's
    ``reasoning`` passthrough is enabled in harness/llm.py) *and* a normal
    text delta. Emitting them as two separate DockEvents — reasoning first
    so the dock can paint the "Thinking" body live before any user-visible
    text — lets the UI render both lanes without us re-shaping the chunk.
    """
    name = event.get("event") or ""
    if name == "on_chat_model_stream":
        data = event.get("data") or {}
        chunk = data.get("chunk")
        out: list[DockEvent] = []
        reasoning = _extract_reasoning(chunk)
        if reasoning:
            out.append(DockEvent(kind="reasoning_delta", payload={"text": reasoning}))
        text = _extract_text(chunk)
        if text:
            out.append(DockEvent(kind="assistant_delta", payload={"text": text}))
        return out
    evt = _translate_event(event)
    return [evt] if evt is not None else []


def _translate_event(event: dict[str, Any]) -> DockEvent | None:
    """Translate a LangGraph astream event into a DockEvent (or None to skip).

    Coverage:
      - ``on_tool_start`` / ``on_tool_end`` / ``on_tool_error``: 1:1 → tool_*
      - ``on_chat_model_stream``: token delta → assistant_delta
        (reasoning lane is handled by ``_translate_event_multi``; this
        single-event entry point still emits only the assistant text for
        backwards compatibility with the existing test suite.)
      - ``on_chain_end`` on the root: → done
      - everything else (chain_start, retriever events, ...): None
    """
    name = event.get("event") or ""
    data = event.get("data") or {}

    if name == "on_tool_start":
        tool_name = event.get("name") or ""
        # ``narrate`` is a cosmetic tool — surface only the *end* event as a
        # narrator chip; emitting a spinner row for it would defeat the point.
        if tool_name == "narrate":
            return None
        tool_args = data.get("input") or {}
        return DockEvent(kind="tool_start", payload={"tool": tool_name, "args": tool_args})

    if name == "on_tool_end":
        tool_name = event.get("name") or ""
        result = data.get("output")
        # LangGraph wraps tool returns in a ToolMessage; we want the raw
        # dict for downstream consumers. Try to decode JSON content first,
        # then fall through to a plain string / dict / list.
        decoded = _decode_tool_output(result)
        # ``propose_plan`` gets a dedicated event so the caller can fan out
        # a ``task_graph`` SSE frame ahead of any agent_start.
        if tool_name == "propose_plan" and isinstance(decoded, dict):
            return DockEvent(kind="plan", payload={"plan": decoded})
        # ``narrate`` is the "thought aloud" chip that fires right before each
        # execution tool. We surface it as a dedicated event so the dock can
        # render an italic narrator line (Manus-style) — and so we never let
        # it slip into ``tool_end`` and pollute the tool console.
        if tool_name == "narrate" and isinstance(decoded, dict):
            text = str(decoded.get("narration") or "").strip()
            if not text:
                # Drop empty narrations — model was over-eager but had nothing
                # meaningful to say. Don't surface a blank chip.
                return None
            return DockEvent(kind="narrator", payload={"text": text})
        capped = _cap_for_wire(decoded if decoded is not None else result)
        return DockEvent(
            kind="tool_end",
            payload={"tool": tool_name, "result": capped},
        )

    if name == "on_tool_error":
        tool_name = event.get("name") or ""
        err = data.get("error")
        return DockEvent(
            kind="tool_error",
            payload={"tool": tool_name, "error": _safe_str(err)},
        )

    if name == "on_chat_model_stream":
        chunk = data.get("chunk")
        text = _extract_text(chunk)
        if not text:
            return None
        return DockEvent(kind="assistant_delta", payload={"text": text})

    # Step 5 — partial artifact stream from inside a tool. Tools call
    # ``await emit_partial_artifact(...)`` which dispatches a custom event
    # named "partial_artifact"; we translate that into a DockEvent.
    if name == "on_custom_event" and event.get("name") == "partial_artifact":
        snap = data if isinstance(data, dict) else {}
        # ``data`` is whatever the tool passed as the dispatcher's ``data``
        # arg — already the payload dict, no further unwrapping needed.
        # We defensively coerce so a tool that emits garbage doesn't crash
        # the stream. The translator just drops empties.
        if not snap:
            return None
        return DockEvent(kind="partial_artifact", payload=dict(snap))

    # LangGraph emits this when interrupt() fires inside a tool.
    if name == "on_chain_stream" and isinstance(data.get("chunk"), dict):
        chunk = data["chunk"]
        if "__interrupt__" in chunk:
            return DockEvent(
                kind="interrupt",
                payload={"value": chunk["__interrupt__"]},
            )

    if name == "on_chain_end" and event.get("name") == "LangGraph":
        return DockEvent(kind="done", payload={})

    return None


def _extract_text(chunk: Any) -> str:
    """Pull a text delta out of any of the chunk shapes LangGraph hands us."""
    if chunk is None:
        return ""
    # AIMessageChunk-style: .content is a str OR a list of dicts.
    content = getattr(chunk, "content", chunk)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out: list[str] = []
        for part in content:
            if isinstance(part, dict):
                # Reasoning blocks (when the provider returns them inside
                # ``content`` instead of additional_kwargs) belong to the
                # reasoning lane — skip them here so they don't leak into
                # the user-visible assistant text.
                if part.get("type") == "reasoning":
                    continue
                txt = part.get("text") or part.get("content") or ""
                if isinstance(txt, str):
                    out.append(txt)
            elif isinstance(part, str):
                out.append(part)
        return "".join(out)
    return ""


def _extract_reasoning(chunk: Any) -> str:
    """Pull a reasoning (chain-of-thought) delta out of the chunk.

    OpenRouter's extended-thinking passthrough (enabled in harness/llm.py
    when ``reasoning_effort`` is set) hands reasoning back in one of three
    shapes, and we accept all of them so a langchain-openai version bump
    or a provider quirk doesn't silently kill the "Thinking" body in the
    dock:

      1. ``chunk.additional_kwargs["reasoning"]`` — string (OpenRouter
         primary path; what most DeepSeek / GLM responses use).
      2. ``chunk.additional_kwargs["reasoning_content"]`` — string
         fallback used by a few providers and by older OpenRouter docs.
      3. ``chunk.content`` is a list with ``{"type": "reasoning", "text"}``
         blocks — Anthropic-style "thinking" blocks, defensive against a
         future routing change.

    Returns the empty string when nothing is found (caller treats that as
    "no reasoning this tick").
    """
    if chunk is None:
        return ""
    extras = getattr(chunk, "additional_kwargs", None)
    if isinstance(extras, dict):
        for key in ("reasoning", "reasoning_content"):
            val = extras.get(key)
            if isinstance(val, str) and val:
                return val
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        out: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "reasoning":
                txt = part.get("text") or part.get("content") or ""
                if isinstance(txt, str):
                    out.append(txt)
        if out:
            return "".join(out)
    return ""


def _cap_for_wire(value: Any, *, cap_bytes: int = _TOOL_RESULT_CAP_BYTES) -> Any:
    """Cap a tool result so a single SSE frame can't bloat past the limit.

    Strategy:
      - JSON-encodable values that fit under ``cap_bytes`` pass through
        unchanged (the dock JsonBlock renders them as pretty JSON).
      - Anything bigger is serialised to a string, truncated to
        ``cap_bytes`` characters, and suffixed with the elision marker so
        the dock can show "huge result" without truncating mid-codepoint
        being too obvious.
      - Non-JSON-serialisable values (objects, sets, …) are str()-coerced
        first, then capped via the same path.

    The dock UI matches this cap and stops rendering past 200 lines, so
    they're sized together: if you raise one, raise the other.
    """
    try:
        encoded = json.dumps(value, default=str)
    except (TypeError, ValueError):
        encoded = str(value)
    if len(encoded.encode("utf-8")) <= cap_bytes:
        return value
    # Truncate the *string* form (not the encoded bytes) so we never split
    # a multibyte codepoint mid-character. cap_bytes is an upper bound on
    # the resulting UTF-8 length; the elision tail is ASCII so it adds
    # exactly 12 bytes on top, well within typical SSE frame budgets.
    truncated = encoded[:cap_bytes]
    return f"{truncated}…[truncated]"


def _safe_str(value: Any, *, cap: int = 400) -> str:
    s = str(value) if value is not None else ""
    return s[:cap]


def _decode_tool_output(value: Any) -> Any:
    """Best-effort decode of a LangGraph tool return.

    LangGraph wraps tool outputs in ``ToolMessage`` whose ``content`` is the
    string-serialised return value (LangGraph stringifies non-string returns
    via ``json.dumps``). We undo that wrapping so downstream consumers (the
    SSE translator, the tests) can deal with the original dict/list/str
    directly instead of having to parse JSON every time.
    """
    if value is None:
        return None
    # Direct dict/list passthrough (some tool flows preserve the return type).
    if isinstance(value, (dict, list)):
        return value
    # ToolMessage shape: pluck .content. Could be a str (most common) or
    # a list of content blocks.
    content = getattr(value, "content", None)
    if content is None:
        return value
    if isinstance(content, (dict, list)):
        return content
    if isinstance(content, str):
        # Try JSON first; if it's a plain string (e.g. "Found 1 row") leave
        # it as-is.
        import json as _json

        s = content.strip()
        if s.startswith("{") or s.startswith("["):
            try:
                return _json.loads(s)
            except (ValueError, TypeError):
                pass
        return content
    return value
