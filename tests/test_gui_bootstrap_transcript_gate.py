"""The bootstrap and transcript routes sit behind the include-time host gate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("GET", "/api/bootstrap/status"),
    ("POST", "/api/bootstrap/run"),
    ("DELETE", "/api/bootstrap/models/whisper"),
    ("POST", "/api/bootstrap/cancel"),
    ("GET", "/api/bootstrap/status-job"),
    ("GET", "/api/bootstrap/events"),
    ("GET", "/api/transcript/vocabulary"),
    ("PUT", "/api/transcript/vocabulary"),
    ("GET", "/api/transcript/refine/status"),
    ("POST", "/api/transcript/refine/done"),
    ("POST", "/api/transcript/refine/waive"),
    ("POST", "/api/transcript/replacement-preview"),
    ("POST", "/api/transcript/word-timing-context"),
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
        json={"path": "p"} if method in {"POST", "PUT"} else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method in {"POST", "PUT"} else None)

    assert res.status_code == 403
