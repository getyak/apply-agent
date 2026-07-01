"""Chain 8 (Dual-track résumé · migration 017) e2e scorecard.

Why this exists
----------------
Migration 017 introduced the dual-track résumé model — a ``track`` axis
(original / optimized / tailored), ``derived_from`` + ``bullet_index`` on
``resumes``, the long-lived ``resume_suggestions`` stack, and the
``prevent_original_mutation`` trigger. This file scores the whole thing
*end-to-end against a real Postgres*: the immutability trigger, the atomic
proposed→accepted state machine (one-winner under concurrency), track
derivation, plus the FastAPI decision endpoint's envelope + trace contract.

Unlike the mocked chain tests, this one needs a live PG (``RELAY_PG_DSN``).
When PG is absent (CI without the infra) the whole module skips — it never
fails a laptop that hasn't run ``make up``.

Rubric (8 dims, 100-point scale)
  - completion            15  proposed suggestion is listable (mig-017 shape)
  - schema-fidelity       10  reads/writes hit the exact mig-017 columns
  - original-immutability 15  UPDATE resumes ... WHERE track='original' rejected
  - state-machine         15  concurrent double-accept → exactly one winner
  - track-derivation      10  derived_from + bullet_index round-trip
  - trace-propagation     10  X-Trace-Id echoed by the decision endpoint
  - envelope-shape        10  error path yields a typed envelope
  - accessibility         15  dual-track component exposes aria + testids

Pass condition: total == 100.

Run:  cd agents && uv run pytest tests/test_chain8_dual_track_e2e_score.py -v -s
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest

# Load repo .env so RELAY_PG_DSN is present when the dev shell hasn't sourced it.
from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

_DSN = os.environ.get("RELAY_PG_DSN") or os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not _DSN,
    reason="chain-8 needs a live Postgres (RELAY_PG_DSN); run `make up` first",
)


def _connect() -> psycopg.Connection:
    return psycopg.connect(_DSN)  # type: ignore[arg-type]


# ── Fixture: a throwaway user + one original + one optimized child + suggestion


@pytest.fixture
def seed():
    """Insert a user, an original résumé, an optimized child, and a proposed
    bullet suggestion. Yields their ids; tears everything down after."""
    user_id = uuid4()
    original_id = uuid4()
    optimized_id = uuid4()
    suggestion_id = uuid4()
    bullet_id = "b_chain8fixture"

    original_content = {
        "parsed": {
            "basics": {"name": "Chain Eight"},
            "work": [
                {"name": "Acme", "position": "Engineer", "highlights": ["Worked on migration"]}
            ],
        },
        "raw": "Chain Eight — Engineer at Acme",
    }
    bullet_index = {
        bullet_id: {
            "path": "work.0.highlights.0",
            "text_hash": "deadbeef",
            "anchor_text": "Worked on migration",
        }
    }
    optimized_content = {
        "parsed": {
            "basics": {"name": "Chain Eight"},
            "work": [
                {"name": "Acme", "position": "Engineer", "highlights": ["Led migration of the monolith"]}
            ],
        },
        "raw": "Chain Eight — Engineer at Acme",
    }

    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (id, email) VALUES (%s, %s)",
            (str(user_id), f"chain8-{user_id}@example.test"),
        )
        # version=0 lets the 016 assign-version trigger allocate MAX+1 atomically.
        cur.execute(
            """INSERT INTO resumes
                 (id, user_id, version, content, is_base, track, bullet_index)
               VALUES (%s, %s, 0, %s, true, 'original', %s)""",
            (str(original_id), str(user_id), json.dumps(original_content), json.dumps(bullet_index)),
        )
        cur.execute(
            """INSERT INTO resumes
                 (id, user_id, version, content, is_base, track, derived_from, bullet_index)
               VALUES (%s, %s, 0, %s, false, 'optimized', %s, %s)""",
            (
                str(optimized_id),
                str(user_id),
                json.dumps(optimized_content),
                str(original_id),
                json.dumps(bullet_index),
            ),
        )
        cur.execute(
            """INSERT INTO resume_suggestions
                 (id, user_id, source_resume_id, bullet_stable_id, section,
                  change_type, before_text, after_text, rationale, risk_level,
                  status, proposed_by)
               VALUES (%s, %s, %s, %s, 'work', 'quantify_existing',
                       'Worked on migration', 'Led migration of the monolith',
                       'actives + quantify', 'needs_review', 'proposed',
                       'optimize_general')""",
            (str(suggestion_id), str(user_id), str(original_id), bullet_id),
        )
        conn.commit()

    yield {
        "user_id": user_id,
        "original_id": original_id,
        "optimized_id": optimized_id,
        "suggestion_id": suggestion_id,
        "bullet_id": bullet_id,
    }

    uid = str(user_id)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM resume_suggestions WHERE user_id = %s", (uid,))
        cur.execute("DELETE FROM resumes WHERE user_id = %s", (uid,))
        cur.execute("DELETE FROM users WHERE id = %s", (uid,))
        conn.commit()


# ── Dim 3: original immutability (the prevent_original_mutation trigger) ─────


def test_original_immutability(seed):
    original_id = seed["original_id"]
    mutated = json.dumps({"parsed": {"basics": {"name": "Tampered"}}, "raw": "x"})
    blocked = False
    with _connect() as conn, conn.cursor() as cur:
        try:
            cur.execute(
                "UPDATE resumes SET content = %s WHERE id = %s",
                (mutated, str(original_id)),
            )
            conn.commit()
        except psycopg.Error:
            conn.rollback()
            blocked = True

    # A metadata-only UPDATE (label) must still be allowed — the trigger only
    # blocks content changes, per design §7.2.
    label_ok = False
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE resumes SET label = %s WHERE id = %s",
            ("renamed", str(original_id)),
        )
        conn.commit()
        label_ok = cur.rowcount == 1

    _dim("original-immutability", 15, blocked and label_ok, f"blocked={blocked} label_ok={label_ok}")
    assert blocked, "content UPDATE on track='original' was NOT blocked by the trigger"
    assert label_ok, "metadata-only UPDATE on original should be allowed"


# ── Dim 4: atomic state machine (concurrent double-accept → one winner) ──────


def test_state_machine_one_winner(seed):
    from agents.nodes import resume_store

    suggestion_id: UUID = seed["suggestion_id"]
    user_id: UUID = seed["user_id"]

    async def claim() -> bool:
        # Mirrors the decision endpoint's atomic claim: proposed → accepted,
        # conditional on the row still being proposed.
        return await resume_store.set_suggestion_status(
            suggestion_id, user_id, "accepted", decided_via="studio_panel", expected_from="proposed"
        )

    async def race() -> list[bool]:
        return await asyncio.gather(*[claim() for _ in range(5)])

    results = asyncio.run(race())
    winners = sum(1 for r in results if r)

    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM resume_suggestions WHERE id = %s", (str(suggestion_id),))
        final_status = cur.fetchone()[0]

    ok = winners == 1 and final_status == "accepted"
    _dim("state-machine", 15, ok, f"winners={winners} final={final_status!r}")
    assert winners == 1, f"expected exactly one accept winner, got {winners}"
    assert final_status == "accepted"


# ── Dim 5: track derivation (derived_from + bullet_index round-trip) ─────────


def test_track_derivation(seed):
    original_id: UUID = seed["original_id"]
    optimized_id: UUID = seed["optimized_id"]
    bullet_id: str = seed["bullet_id"]

    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT track, derived_from, bullet_index FROM resumes WHERE id = %s",
            (str(optimized_id),),
        )
        track, derived_from, bullet_index = cur.fetchone()

    derived_ok = track == "optimized" and str(derived_from) == str(original_id)
    bi_ok = isinstance(bullet_index, dict) and bullet_id in bullet_index
    ok = derived_ok and bi_ok
    _dim("track-derivation", 10, ok, f"track={track} derived_ok={derived_ok} bi_ok={bi_ok}")
    assert derived_ok, f"optimized row should derive_from the original: {track=} {derived_from=}"
    assert bi_ok, "bullet_index did not round-trip the stable bullet id"


# ── Dims 1/2/6/7: FastAPI decision endpoint + PG list shape ──────────────────


@pytest.fixture
def client(seed):
    """TestClient whose auth resolves to the seeded user, so ownership checks
    on the suggestion endpoints pass against real rows."""
    from fastapi.testclient import TestClient

    from agents.api import server as srv
    from agents.api.deps import current_user

    user_id: UUID = seed["user_id"]

    async def fake_user_dep():
        return user_id

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app, raise_server_exceptions=False)
    srv.app.dependency_overrides.clear()


def test_list_and_trace_and_envelope(client, seed):
    original_id: UUID = seed["original_id"]

    # Dim 1 (completion) + Dim 2 (schema-fidelity): the TS gateway reads the
    # suggestion list straight from PG, so we assert the exact mig-017 columns
    # the UI + store expect are present and carry the seeded proposed row.
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, bullet_stable_id, section, change_type, before_text,
                      after_text, rationale, risk_level, status, proposed_by
                 FROM resume_suggestions
                WHERE source_resume_id = %s AND status = 'proposed'""",
            (str(original_id),),
        )
        cols = [d.name for d in cur.description]
        rows = cur.fetchall()
    schema_ok = cols == [
        "id",
        "bullet_stable_id",
        "section",
        "change_type",
        "before_text",
        "after_text",
        "rationale",
        "risk_level",
        "status",
        "proposed_by",
    ]
    completion_ok = len(rows) >= 1
    _dim("completion", 15, completion_ok, f"proposed_rows={len(rows)}")
    _dim("schema-fidelity", 10, schema_ok, f"cols_ok={schema_ok}")
    assert completion_ok, "expected the seeded proposed suggestion to be listable"
    assert schema_ok, f"resume_suggestions columns drifted from mig-017: {cols}"

    # Dim 6 (trace) + Dim 7 (envelope): hit the decision endpoint for a
    # non-existent suggestion → 404 with the trace echoed and a typed body.
    trace_id = str(uuid4())
    resp = client.post(
        f"/resume/suggestions/{uuid4()}/decision",
        json={"decision": "accept", "decided_via": "studio_panel"},
        headers={"X-Trace-Id": trace_id},
    )
    status_ok = resp.status_code == 404
    echoed = resp.headers.get("x-trace-id") or resp.headers.get("X-Trace-Id")
    trace_ok = echoed == trace_id
    body_ok = False
    try:
        body = resp.json()
        body_ok = isinstance(body, dict) and (
            "error" in body or "detail" in body or "traceId" in body or "trace_id" in body
        )
    except json.JSONDecodeError:
        body_ok = False

    _dim("trace-propagation", 10, trace_ok, f"sent={trace_id} echoed={echoed}")
    _dim("envelope-shape", 10, status_ok and body_ok, f"status={resp.status_code} body_ok={body_ok}")
    assert status_ok, f"expected 404 for a non-existent suggestion, got {resp.status_code}"
    assert trace_ok, f"X-Trace-Id not echoed: sent={trace_id!r} got={echoed!r}"
    assert body_ok, f"error envelope shape unexpected: {resp.text[:200]}"


# ── Dim 8: accessibility of the dual-track component (source-level contract) ─


def test_dual_track_accessibility():
    """The web package has no DOM test lib; the React component test asserts
    render output. Here we assert the *source contract* that backs it — the
    aria roles/labels and testids exist — so a regression in the component
    that drops accessibility hooks fails this scorecard too."""
    src = (
        Path(__file__).resolve().parents[2]
        / "web"
        / "src"
        / "components"
        / "screens"
        / "resume-dual-track.tsx"
    )
    text = src.read_text(encoding="utf-8") if src.exists() else ""
    needles = [
        'role="list"',
        'role="listitem"',
        'role="region"',
        "dualTrack.regionAria",
        "dualTrack.acceptAria",
        "dualTrack.rejectAria",
        "aria-current",
        'data-testid="suggestion-stack"',
    ]
    missing = [n for n in needles if n not in text]
    ok = src.exists() and not missing
    _dim("accessibility", 15, ok, f"exists={src.exists()} missing={missing}")
    assert src.exists(), "resume-dual-track.tsx not found"
    assert not missing, f"dual-track component dropped accessibility hooks: {missing}"


# ── Scoring helpers ─────────────────────────────────────────────────────────

_SCORES: dict[str, tuple[int, int]] = {}


def _dim(name: str, weight: int, passed: bool, note: str = "") -> None:
    earned = weight if passed else 0
    _SCORES[name] = (earned, weight)
    bar = "█" * earned
    print(f"[chain8] {name:<22} {earned:>3}/{weight:<3}  {bar}  {note}")


def test_chain8_score_banner():
    print(
        "\n"
        + "═" * 72
        + "\n"
        + " Chain 8 · Dual-track résumé (mig 017) · e2e scorecard\n"
        + " 15 completion · 10 schema · 15 immutability · 15 state-machine\n"
        + " · 10 derivation · 10 trace · 10 envelope · 15 a11y = 100/100\n"
        + "═" * 72
    )
