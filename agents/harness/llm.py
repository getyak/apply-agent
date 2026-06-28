"""ChatOpenRouter — 3-tier model picker + cost calc.

Caller: every node imports `pick_model(tier)` for `create_react_agent(model=...)`.
guards.py / context.py / audit.py inject pre/post hooks via `with_hooks(model)`.

Pricing matches docs/architecture/agent-harness.md (USD per 1M tokens, cents
on PG = total_cost_cents NUMERIC(10,4)).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from langchain_openai import ChatOpenAI

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
) -> ChatOpenAI:
    """Return a ChatOpenAI bound to OpenRouter with the chosen tier.

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

    extra_body: dict[str, object] = {
        # Lock provider routing for stability on critical prompts (see
        # cicd-aiops-harness.md § 6 pitfall #2 — OpenRouter silent provider swaps).
        "provider": {"allow_fallbacks": True},
    }
    if reasoning_effort is not None:
        # OpenRouter extended-thinking passthrough. The `reasoning` field
        # asks the upstream provider to surface chain-of-thought; the
        # `include_reasoning: True` belt-and-braces is for providers that
        # honor the legacy flag instead. dock_agent reads the deltas from
        # AIMessageChunk.additional_kwargs["reasoning"] and emits them as
        # `reasoning_delta` SSE frames the dock renders inline.
        extra_body["reasoning"] = {"effort": reasoning_effort}
        extra_body["include_reasoning"] = True

    # Cost tracking — every model call writes usage into the active
    # CostTally via contextvar. Hooks (guards.post_model_hook) read pending
    # cents; audit() reads totals on exit. See harness/cost_tracker.py.
    from agents.harness.cost_tracker import COST_TRACKING_CALLBACK

    return ChatOpenAI(
        model=spec.openrouter_id,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        max_tokens=max_tokens,
        # LLM1 (round-8): the round-8 audit found the prior config let a
        # single OpenRouter 429 / 5xx / connection wobble propagate as a
        # hard failure into the saga, even though langchain_openai already
        # ships a tenacity-backed retry loop. Setting max_retries=3
        # enables exponential backoff (~1s, 2s, 4s) for transient upstream
        # errors. request_timeout matches the router's 30s wait_for so a
        # hung provider can't outlive its enclosing asyncio.wait_for and
        # leak file descriptors.
        max_retries=3,
        request_timeout=30,
        model_kwargs={"extra_body": extra_body},
        callbacks=[COST_TRACKING_CALLBACK],
    )


def cost_cents(tier: Tier, tokens_in: int, tokens_out: int) -> float:
    """Compute USD-cents cost for one LLM call."""
    spec = MODELS[tier]
    return round(
        (tokens_in * spec.cents_in_per_1m / 1_000_000)
        + (tokens_out * spec.cents_out_per_1m / 1_000_000),
        4,
    )
