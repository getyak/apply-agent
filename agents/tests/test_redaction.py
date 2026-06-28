"""Regression tests for redact_exception_text.

The redactor is the last line of defence before raw exception text lands
in `agent_tasks.error_message` (audit) or an SSE error frame the
frontend will render. We assert it scrubs the patterns the audit /
fabrication / SSE paths rely on it scrubbing (see
docs/architecture/error-handling.md §4.2.3).

Caller: pytest auto-discovers this file under agents/tests/.
"""
from __future__ import annotations

from agents.harness.audit import redact_exception_text

# ───────────────── secrets / API keys ─────────────────


def test_redacts_openrouter_api_key():
    raw = "ChatOpenAI failed: api_key=sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123 invalid"
    out = redact_exception_text(raw)
    assert "sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123" not in out
    # Long opaque tokens get masked.
    assert "<token>" in out


def test_redacts_long_bearer_token():
    # JWT is split into 3 base64 segments by `.`; the redactor's TOKEN
    # regex requires a single \b…\b run of 32+ chars, so each segment
    # gets evaluated independently. The *long* middle segment must be
    # redacted; the short header segment will survive (deliberate — it's
    # the public algorithm header, not a secret).
    raw = "401 Unauthorized: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.eyJleHAiOjE2MjAwMDAwMDB9"
    out = redact_exception_text(raw)
    # The signature-bearing middle segment must be gone.
    assert "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0" not in out
    assert "<token>" in out


# ───────────────── connection strings ─────────────────


def test_redacts_postgres_dsn_with_password():
    raw = "psycopg.OperationalError: could not connect to postgresql://relay:secret123@127.0.0.1:5433/relay sslmode=require"
    out = redact_exception_text(raw)
    assert "secret123" not in out, out
    assert "<dsn>" in out


def test_redacts_redis_url_with_password():
    raw = "redis.exceptions.ConnectionError: redis://default:supersecret@localhost:6380/0"
    out = redact_exception_text(raw)
    assert "supersecret" not in out
    assert "<dsn>" in out


# ───────────────── absolute filesystem paths ─────────────────


def test_redacts_unix_absolute_path():
    raw = (
        "Traceback at /Users/relay-dev/data/agents/.venv/lib/python3.12/"
        "site-packages/openai/_client.py:227 — KeyError"
    )
    out = redact_exception_text(raw)
    # User home + venv path must not survive into audit records.
    assert "/Users/relay-dev" not in out
    assert "<path>" in out


def test_redacts_home_path():
    raw = "OSError: cannot read /home/builder/.relay/secrets/openrouter.token"
    out = redact_exception_text(raw)
    assert "/home/builder" not in out
    assert "<path>" in out


# ───────────────── stack-trace style noise ─────────────────


def test_caps_overlong_messages():
    # Use printable non-regex-fodder content so the length-cap path is
    # exercised in isolation (xxxx... is matched by the TOKEN regex and
    # collapses to <token> well before reaching the cap).
    raw = "Failure: " + ("ab " * 400)  # ≈1200 chars, no 32+ token runs
    out = redact_exception_text(raw)
    # The cap (_AUDIT_ERROR_MAX_CHARS = 500) holds.
    assert len(out) <= 510
    # Cap path uses an ellipsis joiner between head + tail.
    assert "…" in out


# ───────────────── well-behaved inputs ─────────────────


def test_passes_through_safe_message():
    raw = "Job not found"
    assert redact_exception_text(raw) == raw


def test_handles_empty_and_none_like():
    assert redact_exception_text("") == ""


def test_handles_multiline_with_path_and_token():
    raw = (
        "Traceback (most recent call last):\n"
        "  File \"/Users/relay/agents/api/server.py\", line 412\n"
        "openai.AuthenticationError: api key sk-or-aaaabbbbccccddddeeeeffff0011223344556677 rejected"
    )
    out = redact_exception_text(raw)
    assert "/Users/relay/agents" not in out
    assert "sk-or-aaaabbbb" not in out
    assert "<path>" in out and "<token>" in out
