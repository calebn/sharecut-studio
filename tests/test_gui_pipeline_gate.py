"""The nine host pipeline routes sit behind the include-time host gate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.pipeline import STEP_NAMES
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("GET", "/api/pipeline/config"),
    ("PUT", "/api/pipeline/config"),
    ("POST", "/api/pipeline/analyze"),
    ("GET", "/api/pipeline/status"),
    ("POST", "/api/pipeline/retry"),
    ("POST", "/api/pipeline/run"),
    ("POST", "/api/pipeline/cancel"),
    ("POST", "/api/pipeline/render-preview"),
    ("GET", "/api/pipeline/events"),
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
        params={"path": "p"},
        json={"path": "p", "job_id": "j"} if method in {"POST", "PUT"} else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method in {"POST", "PUT"} else None)

    assert res.status_code == 403


def test_the_static_steps_route_stays_open_to_a_relayed_caller() -> None:
    res = _relayed().get("/api/pipeline/steps")

    assert res.status_code == 200
    assert res.json() == {"steps": list(STEP_NAMES)}


def test_a_loopback_host_caller_reaches_status() -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/pipeline/status")

    assert res.status_code == 200
    assert res.json()["running"] is False


def test_a_loopback_host_caller_reaches_config(minimal_project) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/pipeline/config", params={"path": str(minimal_project)})

    assert res.status_code == 200
    assert res.json()["unattended"] is True
