"""The seventeen host project routes sit behind the route-level host gate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("POST", "/api/project/create"),
    ("POST", "/api/project/pick"),
    ("POST", "/api/project/pick-folder"),
    ("POST", "/api/project/open"),
    ("POST", "/api/project/close"),
    ("GET", "/api/projects/recent"),
    ("DELETE", "/api/projects/recent"),
    ("POST", "/api/projects/recent/reveal"),
    ("POST", "/api/project/reveal"),
    ("POST", "/api/project/move"),
    ("POST", "/api/projects/recent/duplicate"),
    ("GET", "/api/project"),
    ("GET", "/api/project/meta"),
    ("GET", "/api/waveform-snap"),
    ("GET", "/api/project/prosody"),
    ("GET", "/api/audio"),
    ("GET", "/api/history/diff"),
]


def _relayed() -> TestClient:
    return TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_refuses_a_relayed_caller(method: str, path: str) -> None:
    res = _relayed().request(
        method,
        path,
        params={"path": "p", "track_id": "t", "start": 0, "end": 1},
        json={"path": "p", "dest_parent": "d"} if method == "POST" else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method == "POST" else None)

    assert res.status_code == 403


def test_health_stays_open_to_a_relayed_caller() -> None:
    res = _relayed().get("/api/health")

    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_a_loopback_host_caller_reaches_the_project(minimal_project) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/project", params={"path": str(minimal_project)})

    assert res.status_code == 200
    assert "tracks" in res.json()
    assert "render_status" in res.json()


def test_a_loopback_host_caller_reaches_the_project_meta(minimal_project) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/project/meta", params={"path": str(minimal_project)})

    assert res.status_code == 200
    assert res.json()["size"] > 0


def test_a_loopback_host_caller_reaches_the_recent_list() -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/projects/recent")

    assert res.status_code == 200
    assert isinstance(res.json()["projects"], list)
