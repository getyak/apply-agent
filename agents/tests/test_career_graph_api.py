"""HTTP contract for the Relay Web Career Graph review gate."""

from __future__ import annotations

from collections.abc import Iterator
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from agents.api import server as srv
from agents.api.deps import current_user
from agents.career_graph import store as career_graph_store


@pytest.fixture
def client() -> Iterator[tuple[TestClient, UUID]]:
    fixed_user = uuid4()

    async def fake_user_dep() -> UUID:
        return fixed_user

    srv.app.dependency_overrides[current_user] = fake_user_dep
    yield TestClient(srv.app), fixed_user
    srv.app.dependency_overrides.clear()


def test_overview_is_owner_scoped_and_exposes_pending_review(
    client: tuple[TestClient, UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_client, user_id = client
    seen: list[UUID] = []

    async def list_graphs(owner: UUID) -> list[dict]:
        seen.append(owner)
        return [{"id": str(uuid4()), "revision": 0, "node_count": 0}]

    async def list_resumes(owner: UUID) -> list[dict]:
        seen.append(owner)
        return [{"id": str(uuid4()), "version": 1}]

    async def list_changes(owner: UUID) -> list[dict]:
        seen.append(owner)
        return [{"id": str(uuid4()), "status": "pending"}]

    monkeypatch.setattr(career_graph_store, "list_graphs", list_graphs)
    monkeypatch.setattr(career_graph_store, "list_source_resumes", list_resumes)
    monkeypatch.setattr(career_graph_store, "list_change_sets", list_changes)

    response = test_client.get("/career-graphs")

    assert response.status_code == 200
    assert seen == [user_id, user_id, user_id]
    body = response.json()
    assert len(body["graphs"]) == 1
    assert len(body["source_resumes"]) == 1
    assert body["pending_changes"][0]["status"] == "pending"
    assert body["review_gate"]["proposal_changes_approved_graph"] is False
    assert body["review_gate"]["exact_confirmation_required"] is True


def test_import_stages_parsed_resume_without_approving_it(
    client: tuple[TestClient, UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_client, user_id = client
    resume_id = uuid4()
    change_id = uuid4()

    async def propose(
        owner: UUID,
        source_resume_id: UUID,
        *,
        graph_id: UUID | None,
        graph_label: str,
    ) -> dict:
        assert owner == user_id
        assert source_resume_id == resume_id
        assert graph_id is None
        assert graph_label == "Primary graph"
        return {
            "id": str(change_id),
            "graph_id": str(graph_id or uuid4()),
            "status": "pending",
            "requires_human_approval": True,
        }

    monkeypatch.setattr(career_graph_store, "propose_resume_import", propose)

    response = test_client.post(
        "/career-graphs/import",
        json={
            "resume_id": str(resume_id),
            "graph_label": "  Primary graph  ",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert response.json()["requires_human_approval"] is True


def test_decision_requires_exact_current_change_phrase(
    client: tuple[TestClient, UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_client, _user_id = client
    change_id = uuid4()
    approve_calls = 0

    async def approve(*_args, **_kwargs) -> dict:
        nonlocal approve_calls
        approve_calls += 1
        return {"ok": True, "status": "approved"}

    monkeypatch.setattr(career_graph_store, "approve_change_set", approve)

    rejected = test_client.post(
        f"/career-graph-changes/{change_id}/decision",
        json={"decision": "approve", "confirmation": "yes"},
    )

    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "VALIDATION_FAILED"
    assert approve_calls == 0


def test_exact_approval_advances_via_web_review_channel(
    client: tuple[TestClient, UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_client, user_id = client
    change_id = uuid4()
    seen: dict[str, object] = {}

    async def approve(
        owner: UUID,
        requested_change_id: UUID,
        *,
        decided_via: str,
    ) -> dict:
        seen.update(
            owner=owner,
            change_id=requested_change_id,
            decided_via=decided_via,
        )
        return {
            "ok": True,
            "change_set_id": str(requested_change_id),
            "revision": 1,
            "status": "approved",
        }

    monkeypatch.setattr(career_graph_store, "approve_change_set", approve)

    response = test_client.post(
        f"/career-graph-changes/{change_id}/decision",
        json={
            "decision": "approve",
            "confirmation": f"APPROVE CAREER CHANGE {change_id}",
        },
    )

    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert seen == {
        "owner": user_id,
        "change_id": change_id,
        "decided_via": "relay_web_exact_confirmation",
    }
