"""The host share and tunnel routes sit behind the include-time host gate of the collaboration mount."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("GET", "/api/shares"),
    ("POST", "/api/shares"),
    ("POST", "/api/shares/tok/revoke"),
    ("POST", "/api/shares/tok/restore"),
    ("POST", "/api/shares/record"),
    ("POST", "/api/shares/record/tok/replace"),
    ("POST", "/api/shares/rooms/sid/revoke"),
    ("POST", "/api/shares/rooms/sid/restore"),
    ("GET", "/api/tunnel/status"),
]


@pytest.fixture(autouse=True)
def _collaboration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")


def _relayed() -> TestClient:
    return TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_refuses_a_relayed_caller(method: str, path: str) -> None:
    res = _relayed().request(
        method,
        path,
        params={"path": "p"},
        json={"path": "p"} if method == "POST" else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method == "POST" else None)

    assert res.status_code == 403


def test_a_loopback_host_lists_shares(minimal_project, tmp_workspace) -> None:
    client = TestClient(
        create_app(served_project=Path(minimal_project)), client=("127.0.0.1", 50000)
    )

    res = client.get("/api/shares", params={"path": str(minimal_project)})

    assert res.status_code == 200
    assert res.json()["shares"] == []


def test_a_loopback_host_reads_the_tunnel_status(tmp_workspace) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/tunnel/status")

    assert res.status_code == 200
    assert res.json()["schema"] == 1
