"""Loop guards — token / cost / error budgets enforced via pre/post hooks.

Caller: agents/harness/llm.py composes guards with pick_model; nodes that call
LLM directly (not via create_react_agent) can call check_budget() manually.

Important: post_model_hook does NOT inject InjectedState into tools (LangGraph
issue #4841 — see docs/architecture/agent-harness.md § 已知风险). All guards
operate directly on the state dict the hook receives.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage


@dataclass(frozen=True)
class Budget:
    max_iterations: int = 20
    token_budget: int = 80_000
    cost_limit_cents: float = 50.0  # $0.50 per session
    timeout_seconds: int = 300
    max_consecutive_errors: int = 3


DEFAULT_BUDGET = Budget()


# Degradation path: heavy → general → fast (see cicd-aiops-harness.md § 2.6).
DEGRADE_PATH: list[str] = [
    "deepseek/deepseek-v4-pro",
    "z-ai/glm-4.7",
    "deepseek/deepseek-v4-flash",
]


class BudgetExhausted(RuntimeError):
    """Raised when cost or token budget is hit. Caller should checkpoint + stop."""


def _token_count_of(msg: BaseMessage) -> int:
    """Token approximation. Prefer LLM-reported usage; fall back to char/4."""
    usage = getattr(msg, "usage_metadata", None) or getattr(msg, "response_metadata", {}).get(
        "token_usage"
    )
    if usage:
        return int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
    content = msg.content if isinstance(msg.content, str) else str(msg.content)
    return max(1, len(content) // 4)


def post_model_hook(state: dict[str, Any]) -> dict[str, Any]:
    """Accumulate tokens + cost from the last AI message; raise if over budget.

    Cost source priority:
      1. ``CostTally.pending_cents`` (set by the cost_tracker callback after
         every LLM call — works for both LangGraph create_react_agent and
         direct ``model.ainvoke``)
      2. ``state["_pending_cost_cents"]`` legacy path (kept for back-compat
         with any caller still writing this field manually)

    Returns a state-update dict (LangGraph merges).
    """
    msgs = state.get("messages", [])
    if not msgs:
        return {}

    last = msgs[-1]
    if not isinstance(last, AIMessage):
        return {}

    used_tokens = _token_count_of(last)
    update: dict[str, Any] = {
        "total_tokens": state.get("total_tokens", 0) + used_tokens,
    }

    # Drain the callback-tracked pending cost first. Lazy import to keep
    # guards.py importable without langchain (early CI bootstrap).
    try:
        from agents.harness.cost_tracker import get_tally
    except ImportError:
        tally = None
    else:
        tally = get_tally()

    pending_cents = 0.0
    if tally is not None:
        pending_cents = tally.drain_pending()

    # Back-compat: a caller may have stashed cost on state directly.
    legacy_pending = state.get("_pending_cost_cents")
    if legacy_pending:
        pending_cents += float(legacy_pending)

    if pending_cents:
        update["total_cost_cents"] = round(
            state.get("total_cost_cents", 0.0) + pending_cents, 4
        )
        update["_pending_cost_cents"] = 0.0

    budget = state.get("_budget", DEFAULT_BUDGET)
    running_cost = update.get("total_cost_cents", state.get("total_cost_cents", 0.0))
    if running_cost > budget.cost_limit_cents:
        raise BudgetExhausted(
            f"session cost {running_cost:.4f}c > {budget.cost_limit_cents}c"
        )
    if update["total_tokens"] > budget.token_budget:
        # context.py picks this up and compacts; for now signal a soft cap.
        update["_needs_compaction"] = True

    return update


def pre_model_hook(state: dict[str, Any]) -> dict[str, Any]:
    """Run before each LLM call. Bumps iteration counter, short-circuits if errors.

    LangGraph recursion_limit handles the absolute ceiling (set to 2× max_iterations
    so each ReAct step can do thought + tool).
    """
    budget: Budget = state.get("_budget", DEFAULT_BUDGET)
    iterations = state.get("_iterations", 0) + 1

    consecutive_errors = state.get("consecutive_errors", 0)
    if consecutive_errors >= budget.max_consecutive_errors:
        raise BudgetExhausted(
            f"{consecutive_errors} consecutive errors — aborting per max_consecutive_errors"
        )
    return {"_iterations": iterations}


def attach_budget(state_update: dict[str, Any], budget: Budget | None = None) -> dict[str, Any]:
    """Helper used by node entry points to seed the budget for hooks."""
    return {**state_update, "_budget": budget or DEFAULT_BUDGET}


def degrade_tier_for(current_model: str) -> str | None:
    """Given the model that just blew the budget, return the next-cheaper tier model id."""
    try:
        idx = DEGRADE_PATH.index(current_model)
    except ValueError:
        return None
    if idx + 1 >= len(DEGRADE_PATH):
        return None
    return DEGRADE_PATH[idx + 1]


def kill_switch_enabled() -> bool:
    """Env flag for emergency LLM disable (cost guard tripped at infra level)."""
    return os.environ.get("RELAY_LLM_KILLSWITCH", "0") == "1"
