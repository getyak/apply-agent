"""ChatOpenRouter — 3-tier model picker + cost calc.

Caller: every node imports `pick_model(tier)` for `create_react_agent(model=...)`.
guards.py / context.py / audit.py inject pre/post hooks via `with_hooks(model)`.

Pricing matches docs/architecture/agent-harness.md (USD per 1M tokens, cents
on PG = total_cost_cents NUMERIC(10,4)).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

from langchain_openrouter import ChatOpenRouter
from pydantic import SecretStr

Tier = Literal["heavy", "general", "fast"]
ReasoningEffort = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class ModelSpec:
    openrouter_id: str
    cents_in_per_1m: float  # cents per 1M input tokens
    cents_out_per_1m: float  # cents per 1M output tokens
    tier: Tier


# Source: docs/architecture/agent-harness.md § LLM 模型分层. USD → cents (×100).
MODELS: dict[Tier, ModelSpec] = {
    "heavy": ModelSpec("deepseek/deepseek-v4-pro", 43.5, 87.0, "heavy"),
    "general": ModelSpec("z-ai/glm-4.7", 40.0, 175.0, "general"),
    "fast": ModelSpec("deepseek/deepseek-v4-flash", 9.8, 19.6, "fast"),
}


def pick_model(
    tier: Tier,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    reasoning_effort: ReasoningEffort | None = "medium",
    json_mode: bool = False,
) -> Any:
    """Return a ChatOpenRouter bound to the chosen tier.

    ``reasoning_effort`` opts the request into OpenRouter's extended-thinking
    passthrough. DeepSeek V4 Pro and GLM-4.7 return a ``reasoning`` field on
    each stream delta when this is set; V4 Flash silently returns empty
    (dock_agent drops empty reasoning chunks). Pass ``None`` to suppress the
    passthrough entirely (saves ~1-3% tokens on tiers that don't reason).
    """
    spec = MODELS[tier]
    base_url = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    reasoning: dict[str, object] | None = None
    if reasoning_effort is not None:
        # OpenRouter's unified `reasoning` parameter supersedes the legacy
        # `include_reasoning` flag and returns reasoning unless excluded.
        # Source: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
        reasoning = {"effort": reasoning_effort}

    # Cost tracking — every model call writes usage into the active
    # CostTally via contextvar. Hooks (guards.post_model_hook) read pending
    # cents; audit() reads totals on exit. See harness/cost_tracker.py.
    from agents.harness.cost_tracker import COST_TRACKING_CALLBACK

    # Use the provider-specific adapter so OpenRouter reasoning chunks survive
    # as LangChain content/additional-kwargs consumed by ag-ui-langgraph.
    # Source: https://docs.langchain.com/oss/python/integrations/chat/openrouter
    model = ChatOpenRouter(
        model=spec.openrouter_id,
        api_key=SecretStr(api_key),
        base_url=base_url,
        temperature=temperature,
        max_tokens=max_tokens,
        # Durable retries are owned by harness/recovery.py so the SDK, graph
        # node, and external client cannot multiply attempt and cost budgets.
        # ChatOpenRouter's timeout is milliseconds; this bounds one attempt at
        # the same 30-second ceiling as the surrounding recovery policy.
        max_retries=0,
        timeout=30_000,
        reasoning=reasoning,
        openrouter_provider={"allow_fallbacks": True},
        callbacks=[COST_TRACKING_CALLBACK],
    )
    if json_mode:
        # OpenRouter supports OpenAI-compatible JSON mode. Binding the
        # response format at the runnable layer keeps provider-specific
        # routing options in ``extra_body`` while asking the model to emit a
        # syntactically complete top-level JSON object.
        return model.bind(response_format={"type": "json_object"})
    return model


def cost_cents(tier: Tier, tokens_in: int, tokens_out: int) -> float:
    """Compute USD-cents cost for one LLM call."""
    spec = MODELS[tier]
    return round(
        (tokens_in * spec.cents_in_per_1m / 1_000_000)
        + (tokens_out * spec.cents_out_per_1m / 1_000_000),
        4,
    )
