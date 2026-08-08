"""Unit tests for the shared OpenRouter model factory."""

from __future__ import annotations

from typing import Any

from agents.harness import llm


class _FakeModel:
    def __init__(self) -> None:
        self.bound: dict[str, Any] | None = None

    def bind(self, **kwargs: Any) -> _FakeModel:
        self.bound = kwargs
        return self


def test_pick_model_binds_openrouter_json_mode(monkeypatch):
    """Object-producing calls request syntactically valid JSON from OpenRouter."""
    fake = _FakeModel()
    constructor_kwargs: dict[str, Any] = {}

    def fake_chat_openai(**kwargs: Any) -> _FakeModel:
        constructor_kwargs.update(kwargs)
        return fake

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(llm, "ChatOpenRouter", fake_chat_openai)

    result = llm.pick_model("fast", reasoning_effort=None, json_mode=True)

    assert result is fake
    assert fake.bound == {"response_format": {"type": "json_object"}}
    assert constructor_kwargs["openrouter_provider"] == {"allow_fallbacks": True}
    assert constructor_kwargs["reasoning"] is None
    assert constructor_kwargs["max_retries"] == 0
    assert constructor_kwargs["max_tokens"] == 4096
    assert constructor_kwargs["timeout"] == 30_000
    assert "max_completion_tokens" not in constructor_kwargs
    assert "request_timeout" not in constructor_kwargs
    assert "model_kwargs" not in constructor_kwargs


def test_pick_model_uses_unified_openrouter_reasoning(monkeypatch):
    fake = _FakeModel()
    constructor_kwargs: dict[str, Any] = {}

    def fake_chat_openai(**kwargs: Any) -> _FakeModel:
        constructor_kwargs.update(kwargs)
        return fake

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(llm, "ChatOpenRouter", fake_chat_openai)

    llm.pick_model("general", reasoning_effort="high")

    assert constructor_kwargs["reasoning"] == {"effort": "high"}
    assert constructor_kwargs["openrouter_provider"] == {"allow_fallbacks": True}


def test_openrouter_reasoning_chunk_reaches_agui_adapter():
    """Guard the exact provider → LangChain → AG-UI reasoning contract."""
    from ag_ui_langgraph.utils import resolve_reasoning_content
    from langchain_core.messages import AIMessageChunk
    from langchain_openrouter.chat_models import _convert_chunk_to_message_chunk

    chunk = _convert_chunk_to_message_chunk(
        {
            "choices": [
                {
                    "delta": {
                        "role": "assistant",
                        "content": "",
                        "reasoning": "Inspect the candidate evidence first.",
                    }
                }
            ]
        },
        AIMessageChunk,
    )

    assert chunk.additional_kwargs["reasoning_content"] == ("Inspect the candidate evidence first.")
    assert resolve_reasoning_content(chunk) == {
        "type": "text",
        "text": "Inspect the candidate evidence first.",
        "index": 0,
    }
