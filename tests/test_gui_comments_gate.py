"""The five comments routes sit behind the route-level host gate with its client_id semantics."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.routes import comments
from podcast_mcp.gui.routes.deps import host_gate_for_client
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("POST", "/api/comments"),
    ("PATCH", "/api/comments/c1"),
    ("DELETE", "/api/comments/c1"),
    ("POST", "/api/comments/c1/actions/a1/done"),
    ("POST", "/api/comments/c1/replies"),
]
TOKEN = "s3cret-token"
REMOTE = ("203.0.113.9", 50000)
LOOPBACK = ("127.0.0.1", 50000)


def _relayed() -> TestClient:
    return TestClient(create_app(), client=LOOPBACK, headers={RELAYED_REQUEST_HEADER: "1"})


@pytest.fixture
def strict(monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", TOKEN)


def _comment(client: TestClient, path, **kwargs):
    return client.post(
        "/api/comments",
        json={"path": str(path), "body": "Too long", "author": "guest", "timeline_start": 1.0},
        **kwargs,
    )


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_refuses_a_relayed_caller(method: str, path: str) -> None:
    res = _relayed().request(
        method,
        path,
        params={"path": "p"},
        json={"path": "p", "body": "x", "author": "a"} if method != "DELETE" else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method != "DELETE" else None)

    assert res.status_code == 403


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_carries_the_host_gate(method: str, path: str) -> None:
    template = path.replace("c1", "{comment_id}").replace("a1", "{action_id}")
    found = [
        {dep.dependency for dep in route.dependencies}
        for route in comments.router.routes
        if route.path == template and method in route.methods
    ]

    assert found == [{host_gate_for_client}]


def test_a_loopback_host_caller_creates_a_comment(minimal_project) -> None:
    res = _comment(TestClient(create_app(), client=LOOPBACK), minimal_project)

    assert res.status_code == 200
    comment = res.json()["comment"]
    assert comment["body"] == "Too long"
    assert comment["author"] == "guest"


def test_an_empty_client_id_is_refused(minimal_project) -> None:
    res = _comment(
        TestClient(create_app(), client=LOOPBACK), minimal_project, params={"client_id": ""}
    )

    assert res.status_code == 403
    assert res.json() == {"detail": "client_id required"}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


def test_a_remote_peer_with_the_token_header_is_allowed(strict, minimal_project) -> None:
    res = _comment(
        TestClient(create_app(), client=REMOTE), minimal_project, headers={"X-Podcast-Token": TOKEN}
    )

    assert res.status_code == 200


def test_a_remote_peer_with_a_token_query_is_still_refused(strict, minimal_project) -> None:
    res = _comment(
        TestClient(create_app(), client=REMOTE), minimal_project, params={"token": TOKEN}
    )

    assert res.status_code == 403
    assert res.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}


def test_a_remote_peer_without_a_token_is_refused(strict, minimal_project) -> None:
    res = _comment(TestClient(create_app(), client=REMOTE), minimal_project)

    assert res.status_code == 403
