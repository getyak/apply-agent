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
    """Restore .env-leak-prone vars for tests that depend on the pristine state.

    Conditional autouse rather than blanket: ``test_openrouter_tool_calling``
    legitimately needs ``OPENROUTER_API_KEY`` set when it runs (it's the
    smoke test that *exercises* the real provider). Indiscriminately
    stripping the key would make that test fail at runtime even though its
    ``skipif`` was evaluated against the populated env at collection time.
    """
    nodeid = getattr(request.node, "nodeid", "")
    if any(needle in nodeid for needle in _TESTS_NEEDING_PRISTINE_OPENROUTER):
        for k, v in _PRISTINE_ENV.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    yield
