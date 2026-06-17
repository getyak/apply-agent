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


@dataclass(frozen=True)
class ModelSpec:
    openrouter_id: str
    cents_in_per_1m: float   # cents per 1M input tokens
    cents_out_per_1m: float  # cents per 1M output tokens
    tier: Tier


# Source: docs/architecture/agent-harness.md § LLM 模型分层. USD → cents (×100).
MODELS: dict[Tier, ModelSpec] = {
    "heavy":   ModelSpec("deepseek/deepseek-v4-pro",   43.5,  87.0,  "heavy"),
    "general": ModelSpec("z-ai/glm-4.7",               40.0, 175.0,  "general"),
    "fast":    ModelSpec("deepseek/deepseek-v4-flash",  9.8,  19.6,  "fast"),
}


def pick_model(tier: Tier, temperature: float = 0.3, max_tokens: int = 4096) -> ChatOpenAI:
    """Return a ChatOpenAI bound to OpenRouter with the chosen tier."""
    spec = MODELS[tier]
    base_url = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    return ChatOpenAI(
        model=spec.openrouter_id,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        max_tokens=max_tokens,
        # Lock provider routing for stability on critical prompts (see
        # cicd-aiops-harness.md § 6 pitfall #2 — OpenRouter silent provider swaps).
        model_kwargs={"extra_body": {"provider": {"allow_fallbacks": True}}},
    )


def cost_cents(tier: Tier, tokens_in: int, tokens_out: int) -> float:
    """Compute USD-cents cost for one LLM call."""
    spec = MODELS[tier]
    return round(
        (tokens_in * spec.cents_in_per_1m / 1_000_000)
        + (tokens_out * spec.cents_out_per_1m / 1_000_000),
        4,
    )
