"""Cost tracker — collects per-LLM-call usage via callback + contextvar.

Closes the loop that was broken across:
  - llm.py never wrote `_pending_cost_cents` → guards.py cost branch was dead
  - audit.py record.total_tokens / total_cost_cents / model_used always 0

Design: one contextvar holds an accumulator dict for the *current asyncio
task*. Every LLM call appends a usage row. Readers:
  - guards.post_model_hook   reads + drains pending cost
  - audit.audit()            reads totals on exit, persists to agent_tasks

Why contextvar and not state: LangGraph's ``create_react_agent`` calls the
chat model inside its own runnable; we don't get a state hook around each
invocation, only ``post_model_hook`` *after* the AIMessage is appended.
A contextvar lets the callback (which sees ``response_metadata.token_usage``
directly) hand off to the hook without changing every node's call signature.

Why this also fixes audit: nodes that call ``model.ainvoke()`` directly
(resume_agent.customize etc.) bypass LangGraph entirely, so post_model_hook
never fires for them. The audit context manager reads from the same
contextvar — works for both paths uniformly.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult

# ───────────────────────────────────────────────────────────────────────
# Per-call usage record + contextvar
# ───────────────────────────────────────────────────────────────────────


@dataclass
class CallUsage:
    """One LLM call's reported usage. cents may be 0.0 if the call's model
    is not in MODELS (e.g. a non-OpenRouter test stub)."""

    model_id: str
    tokens_in: int
    tokens_out: int
    cents: float


@dataclass
class CostTally:
    """Per-task accumulator of LLM call usage.

    Two streams of consumers:
      - ``pending_cents`` is *drained* by guards.post_model_hook after each
        AIMessage so the hook can degrade tier mid-conversation.
      - ``calls`` / ``total_*`` are *accumulated* over the whole task; audit
        reads them on context-manager exit.
    """

    calls: list[CallUsage] = field(default_factory=list)
    total_tokens: int = 0
    total_cost_cents: float = 0.0
    pending_cents: float = 0.0
    last_model: str | None = None

    def add(self, usage: CallUsage) -> None:
        self.calls.append(usage)
        self.total_tokens += usage.tokens_in + usage.tokens_out
        self.total_cost_cents = round(self.total_cost_cents + usage.cents, 4)
        self.pending_cents = round(self.pending_cents + usage.cents, 4)
        self.last_model = usage.model_id

    def drain_pending(self) -> float:
        """Return + zero the pending bucket (for post_model_hook)."""
        out, self.pending_cents = self.pending_cents, 0.0
        return out


_current_tally: ContextVar[CostTally | None] = ContextVar("relay_cost_tally", default=None)


def get_tally() -> CostTally | None:
    """Return the active tally for this task, or None if none was opened."""
    return _current_tally.get()


def open_tally() -> TallyHandle:
    """Open a fresh CostTally for the current task.

    Use via context manager:

        with open_tally() as tally:
            await model.ainvoke(...)
            print(tally.total_cost_cents)

    Audit and post_model_hook get a tally automatically via ``audit()`` and
    the dock graph's setup. Manual openers are mostly for tests / scripts.
    """
    return TallyHandle()


class TallyHandle:
    def __init__(self) -> None:
        self._token = None
        self.tally = CostTally()

    def __enter__(self) -> CostTally:
        self._token = _current_tally.set(self.tally)
        return self.tally

    def __exit__(self, *exc) -> None:
        if self._token is not None:
            _current_tally.reset(self._token)


# ───────────────────────────────────────────────────────────────────────
# Callback handler — fires on every chat model end
# ───────────────────────────────────────────────────────────────────────


class CostTrackingCallback(AsyncCallbackHandler):
    """LangChain callback that records per-call usage into the active tally.

    Plugged into ``ChatOpenAI(callbacks=[CostTrackingCallback()])`` by
    ``pick_model()`` in llm.py so every ainvoke / astream path goes
    through it transparently.
    """

    async def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        tally = _current_tally.get()
        if tally is None:
            return  # no tally opened (e.g. outside an agent run) — silently skip

        tokens_in = 0
        tokens_out = 0
        model_id: str | None = None

        # LangChain stores token_usage on `llm_output` and also (in newer
        # versions) on each generation's `generation_info` /
        # `message.usage_metadata`. Try both for robustness.
        llm_output = response.llm_output or {}
        usage = llm_output.get("token_usage") or llm_output.get("usage") or {}
        tokens_in += int(usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0) or 0)
        tokens_out += int(usage.get("completion_tokens", 0) or usage.get("output_tokens", 0) or 0)
        model_id = llm_output.get("model_name") or llm_output.get("model")

        if tokens_in == 0 and tokens_out == 0:
            # Fall back to per-generation metadata (streaming case)
            for gen_list in response.generations:
                for gen in gen_list:
                    msg = getattr(gen, "message", None)
                    md = getattr(msg, "usage_metadata", None) or {}
                    tokens_in += int(md.get("input_tokens", 0) or 0)
                    tokens_out += int(md.get("output_tokens", 0) or 0)
                    rm = getattr(msg, "response_metadata", {}) or {}
                    if not model_id:
                        model_id = rm.get("model_name") or rm.get("model")

        cents = 0.0
        if model_id:
            # Lazy import to avoid circular (llm imports nothing from harness).
            from agents.harness.llm import MODELS

            for spec in MODELS.values():
                if spec.openrouter_id == model_id:
                    cents = round(
                        (tokens_in * spec.cents_in_per_1m / 1_000_000)
                        + (tokens_out * spec.cents_out_per_1m / 1_000_000),
                        4,
                    )
                    break

        tally.add(
            CallUsage(
                model_id=model_id or "unknown",
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cents=cents,
            )
        )


# Module-level singleton; ChatOpenAI accepts a list of callbacks and this is
# stateless (state lives in the contextvar), so sharing one instance across
# all picks is safe.
COST_TRACKING_CALLBACK = CostTrackingCallback()
