"""Session-wide pytest setup for the agents test suite.

Why this file exists:
  ``agents.api.server`` calls ``dotenv.load_dotenv`` at module import time.
  Several test modules (``test_application_submitted.py``,
  ``test_extension_map_fields.py``, ``test_ask_stream_dock_route.py``)
  import ``server`` during pytest collection, which permanently injects
  the repo's real ``.env`` keys into ``os.environ`` for every subsequent
  test. ``test_prepare_application``'s ``no_llm_key`` assertion silently
  flips from "expected" to "broken" depending on collection order — a
  classic pytest order-dependency bug that's been hiding in the suite.

  Rather than patch each test file, snapshot the env BEFORE collection
  starts and restore it for every test that didn't explicitly opt in. The
  snapshot is taken at conftest import (the earliest possible point), and
  an autouse fixture restores the leak-prone subset before each test.
"""

from __future__ import annotations

import os

import pytest

_LEAK_GUARD_KEYS = (
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "DATABASE_URL",
    "REDIS_URL",
    "POSTGRES_URL",
    "RELAY_PG_DSN",
)
_PRISTINE_ENV: dict[str, str | None] = {k: os.environ.get(k) for k in _LEAK_GUARD_KEYS}


# Tests that ASSERT a leak-prone env var is unset on entry. Any test whose
# nodeid matches one of these substrings gets the snapshot restoration on
# setup. All other tests run with whatever env they already had (which is
# the post-load_dotenv state — what they expected before this conftest
# existed). This keeps the surgical fix surgical: we only intervene for
# the specific assertions that suffered from the order bug.
_TESTS_NEEDING_PRISTINE_OPENROUTER = ("test_prepare_application_sensitive_field_is_skipped",)


@pytest.fixture(autouse=True)
def _restore_env_leak_guard(request):
    """Force LLM/PG keys unset for tests that assert "no LLM key" behaviour.

    Conditional autouse rather than blanket: ``test_openrouter_tool_calling``
    legitimately needs ``OPENROUTER_API_KEY`` set when it runs (it's the
    smoke test that *exercises* the real provider). Indiscriminately
    stripping the key would make that test fail at runtime even though its
    ``skipif`` was evaluated against the populated env at collection time.

    Earlier versions of this fixture "restored the snapshot taken at
    conftest import". That was insufficient: when the dev shell has
    already sourced ``.env`` *before* invoking pytest (typical local
    workflow), the snapshot itself captured the leaked state — restoring
    it was a no-op and the test silently flipped to running with a real
    LLM key. The ``no_llm_key`` skip branch then never fired and
    ``first_name`` got a real answer, breaking the assertion.

    Fix: for tests in the opt-in list, *force-delete* the leak-prone keys,
    regardless of what the snapshot held. The test's intent is absolute
    ("no LLM, no PG"), not relative to whatever the dev's shell looked
    like.
    """
    nodeid = getattr(request.node, "nodeid", "")
    needs_pristine = any(
        needle in nodeid for needle in _TESTS_NEEDING_PRISTINE_OPENROUTER
    )
    if not needs_pristine:
        yield
        return

    # Snapshot the live env *now* (after dotenv has loaded), strip the
    # leak-prone keys for the duration of this test, then restore the
    # exact pre-test values on teardown. Using a per-test snapshot
    # instead of the module-level _PRISTINE_ENV avoids the "snapshot
    # itself was already polluted by the dev shell" trap.
    saved: dict[str, str | None] = {k: os.environ.get(k) for k in _LEAK_GUARD_KEYS}
    for k in _LEAK_GUARD_KEYS:
        os.environ.pop(k, None)
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
