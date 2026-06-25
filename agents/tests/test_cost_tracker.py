"""Unit tests for agents/harness/cost_tracker.py — the cost-tracking loop.

What this locks down (closes the round-15 P0-1 audit finding):
  - on_llm_end populates an open CostTally with tokens + cents
  - cents are looked up from MODELS pricing by openrouter_id
  - drain_pending() returns + zeros the pending bucket (for post_model_hook)
  - audit() automatically opens a tally and fills record totals on exit
  - guards.post_model_hook reads tally.drain_pending() and accumulates into
    state.total_cost_cents, raising BudgetExhausted when over cap

No live LLM call — we drive the callback manually with a synthetic LLMResult,
which is exactly what langchain emits from ChatOpenAI on_llm_end internally.
"""
from __future__ import annotations

from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from agents.harness.audit import audit
from agents.harness.cost_tracker import (
    COST_TRACKING_CALLBACK,
    CallUsage,
    get_tally,
    open_tally,
)
from agents.harness.guards import Budget, BudgetExhausted, post_model_hook

# ─────────────────────────────────────────────────────────────────────
# Hermetic: no live PG / OpenRouter for these tests.
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    monkeypatch.delenv("RELAY_PG_DSN", raising=False)


def _make_llm_result(
    *, model_name: str, prompt_tokens: int, completion_tokens: int, content: str = "ok"
) -> LLMResult:
    """Build the exact LLMResult shape ChatOpenAI hands to on_llm_end."""
    msg = AIMessage(
        content=content,
        usage_metadata={
            "input_tokens": prompt_tokens,
            "output_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        response_metadata={"model_name": model_name},
    )
    gen = ChatGeneration(message=msg)
    return LLMResult(
        generations=[[gen]],
        llm_output={
            "token_usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            "model_name": model_name,
        },
    )


# ─────────────────────────────────────────────────────────────────────
# Callback → tally
# ─────────────────────────────────────────────────────────────────────


async def test_callback_records_usage_with_cents_lookup():
    """on_llm_end maps model_id → MODELS pricing and writes a CallUsage row."""
    result = _make_llm_result(
        model_name="deepseek/deepseek-v4-flash",
        prompt_tokens=1_000,
        completion_tokens=500,
    )
    with open_tally() as tally:
        await COST_TRACKING_CALLBACK.on_llm_end(result)
        assert len(tally.calls) == 1
        usage = tally.calls[0]
        assert usage.model_id == "deepseek/deepseek-v4-flash"
        assert usage.tokens_in == 1_000
        assert usage.tokens_out == 500
        # V4 Flash pricing: 9.8c/1M in + 19.6c/1M out
        # = (1000 * 9.8 + 500 * 19.6) / 1e6 = (9800 + 9800) / 1e6 = 0.0196
        assert usage.cents == pytest.approx(0.0196, rel=1e-3)
        assert tally.total_tokens == 1_500
        assert tally.total_cost_cents == pytest.approx(0.0196, rel=1e-3)
        assert tally.last_model == "deepseek/deepseek-v4-flash"


async def test_callback_silently_skips_when_no_tally_open():
    """Outside an open_tally() block the callback must not crash."""
    result = _make_llm_result(
        model_name="z-ai/glm-4.7",
        prompt_tokens=10,
        completion_tokens=5,
    )
    assert get_tally() is None
    await COST_TRACKING_CALLBACK.on_llm_end(result)
    assert get_tally() is None


async def test_drain_pending_zeros_bucket_but_keeps_totals():
    """post_model_hook reads pending via drain; totals must survive."""
    with open_tally() as tally:
        tally.add(CallUsage("z-ai/glm-4.7", 100, 50, 0.05))
        tally.add(CallUsage("z-ai/glm-4.7", 200, 100, 0.10))
        assert tally.pending_cents == pytest.approx(0.15, rel=1e-6)
        drained = tally.drain_pending()
        assert drained == pytest.approx(0.15, rel=1e-6)
        assert tally.pending_cents == 0.0
        # Totals are NOT zeroed — they're the running session total.
        assert tally.total_cost_cents == pytest.approx(0.15, rel=1e-6)
        assert tally.total_tokens == 450


# ─────────────────────────────────────────────────────────────────────
# audit() integration
# ─────────────────────────────────────────────────────────────────────


async def test_audit_opens_tally_and_fills_record_on_exit():
    """audit() auto-opens a tally; record gets totals from it on close."""
    user_id = uuid4()

    async with audit(user_id, "resume_agent", "parse") as record:
        tally = get_tally()
        assert tally is not None  # audit opened one
        await COST_TRACKING_CALLBACK.on_llm_end(
            _make_llm_result(
                model_name="deepseek/deepseek-v4-pro",
                prompt_tokens=2_000,
                completion_tokens=1_000,
            )
        )

    # After exit, record should reflect what the tally accumulated.
    assert record.total_tokens == 3_000
    # V4 Pro: 43.5c/1M in + 87c/1M out = (2000*43.5 + 1000*87) / 1e6 = 0.174
    assert record.total_cost_cents == pytest.approx(0.174, rel=1e-3)
    assert record.model_used == "deepseek/deepseek-v4-pro"


async def test_audit_does_not_overwrite_caller_provided_totals():
    """If caller set record.total_* explicitly (e.g. cache_hit path), don't clobber."""
    user_id = uuid4()
    async with audit(user_id, "resume_agent", "customize") as record:
        record.total_tokens = 999
        record.total_cost_cents = 1.23
        record.model_used = "cache"
        await COST_TRACKING_CALLBACK.on_llm_end(
            _make_llm_result(
                model_name="z-ai/glm-4.7", prompt_tokens=100, completion_tokens=50
            )
        )
    assert record.total_tokens == 999
    assert record.total_cost_cents == 1.23
    assert record.model_used == "cache"


# ─────────────────────────────────────────────────────────────────────
# guards.post_model_hook integration
# ─────────────────────────────────────────────────────────────────────


async def test_post_model_hook_pulls_cost_from_tally():
    """post_model_hook reads CostTally.drain_pending() into state.total_cost_cents."""
    with open_tally() as tally:
        tally.add(CallUsage("z-ai/glm-4.7", 1_000, 500, 1.275))
        state = {
            "messages": [AIMessage(content="reply")],
            "total_tokens": 0,
            "total_cost_cents": 0.0,
        }
        update = post_model_hook(state)
        assert update.get("total_cost_cents") == pytest.approx(1.275, rel=1e-3)
        assert tally.pending_cents == 0.0
        # Totals survived for audit to read.
        assert tally.total_cost_cents == pytest.approx(1.275, rel=1e-3)


async def test_post_model_hook_raises_when_over_cost_budget():
    """Cost limit cap actually trips now (was dead code before P0-1)."""
    with open_tally() as tally:
        tally.add(CallUsage("deepseek/deepseek-v4-pro", 100_000, 50_000, 99.99))
        state = {
            "messages": [AIMessage(content="reply")],
            "total_tokens": 0,
            "total_cost_cents": 0.0,
            "_budget": Budget(cost_limit_cents=50.0),
        }
        with pytest.raises(BudgetExhausted) as excinfo:
            post_model_hook(state)
        assert "session cost" in str(excinfo.value)


async def test_post_model_hook_back_compat_with_legacy_state_field():
    """A caller still writing state['_pending_cost_cents'] manually keeps working."""
    state = {
        "messages": [AIMessage(content="reply")],
        "total_tokens": 0,
        "total_cost_cents": 0.0,
        "_pending_cost_cents": 0.42,
    }
    # No tally opened — legacy path must still feed cost in.
    update = post_model_hook(state)
    assert update.get("total_cost_cents") == pytest.approx(0.42, rel=1e-3)
    assert update.get("_pending_cost_cents") == 0.0
