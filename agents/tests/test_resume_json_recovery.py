"""Recover model formatting noise without changing résumé string values."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage

from agents.nodes import resume_agent


@pytest.mark.parametrize(
    "response",
    [
        'Here is the résumé:\n{"summary":"Kept verbatim"}\nEnd of response.',
        '  ```json\n{"summary":"Kept verbatim"}\n  ```',
        '{"summary":"Kept verbatim",}',
    ],
    ids=["surrounding-prose", "indented-fences", "trailing-comma"],
)
def test_recovers_object_from_model_formatting_noise(response: str) -> None:
    assert resume_agent._safe_json(response) == {"summary": "Kept verbatim"}


def test_trailing_comma_repair_preserves_punctuation_and_escapes_inside_strings() -> None:
    response = r"""{
      "summary": "O'Reilly, } and ,] and {'key': value}",
      "quote": "said \"hello\" \\ path",
      "work": [{"highlights": ["Literal {braces} and [brackets]",],},],
    }"""

    assert resume_agent._safe_json(response) == {
        "summary": "O'Reilly, } and ,] and {'key': value}",
        "quote": 'said "hello" \\ path',
        "work": [{"highlights": ["Literal {braces} and [brackets]"]}],
    }


def test_extracts_wrapped_object_with_escaped_quotes_and_braces_in_values() -> None:
    response = r"""Result: {"summary":"Quoted \"}\" then \\ then { literal",} Finished."""

    assert resume_agent._safe_json(response) == {"summary": 'Quoted "}" then \\ then { literal'}


@pytest.mark.parametrize(
    "response",
    [
        None,
        "",
        "not JSON",
        "[]",
        '[{"summary":"Do not unwrap this array"}]',
        'Result: [{"summary":"Do not unwrap this array"},]',
        '"plain text"',
        r'''"{\"summary\":\"Do not unwrap this string\"}"''',
        "null",
        "42",
        '{"summary":"truncated"',
        '{"outer":{"summary":"Do not rescue an inner object"}',
        '{"summary":"unterminated}',
        '{"summary":"raw\nnewline"}',
        "{'summary':'Single quotes are not JSON'}",
        '{"work":[,]}',
        '{"summary":,}',
        "{,}",
        '{"work":[1,,]}',
        '{"work":[1,}}',
    ],
)
def test_invalid_or_non_object_output_keeps_empty_dict_fallback(response: object) -> None:
    assert resume_agent._safe_json(response) == {}


def test_invalid_output_does_not_log_resume_content(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    private_text = "PRIVATE_RESUME_NAME_AND_PHONE"
    monkeypatch.setattr(
        resume_agent,
        "log",
        SimpleNamespace(warning=lambda event, **values: events.append((event, values))),
    )

    assert resume_agent._safe_json('{"summary":"' + private_text) == {}
    assert private_text not in repr(events)


@pytest.mark.parametrize(
    "response",
    [
        'Result:\n{"tailored":{"basics":{"name":"Ada"},"work":[{"name":"Acme"}]},"change_log":[]}',
        '  ```json\n{"tailored":{"basics":{"name":"Ada"},"work":[{"name":"Acme"}]},"change_log":[]}\n  ```',
        '{"tailored":{"basics":{"name":"Ada"},"work":[{"name":"Acme"},],},"change_log":[],}',
    ],
    ids=["surrounding-prose", "indented-fences", "trailing-commas"],
)
async def test_recoverable_output_avoids_regenerating_entire_resume(
    response: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[object] = []

    class Model:
        async def ainvoke(self, messages: object) -> AIMessage:
            calls.append(messages)
            return AIMessage(content=response)

    monkeypatch.setattr(resume_agent, "pick_model", lambda *args, **kwargs: Model())
    result = await resume_agent._generate_tailored_with_retries(
        {"basics": {"name": "Ada"}, "work": [{"name": "Acme"}]}, "A role"
    )

    assert result == {
        "tailored": {"basics": {"name": "Ada"}, "work": [{"name": "Acme"}]},
        "change_log": [],
    }
    assert len(calls) == 1
