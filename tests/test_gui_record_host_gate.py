"""The host record routes sit behind the include-time host gate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("GET", "/api/record/state"),
    ("GET", "/api/record/sessions"),
    ("POST", "/api/record/command"),
    ("GET", "/api/record/upload"),
    ("POST", "/api/record/upload"),
    ("DELETE", "/api/record/upload"),
    ("POST", "/api/record/land"),
    ("POST", "/api/record/discard-take"),
    ("GET", "/api/record/tracks"),
    ("POST", "/api/record/assign-track"),
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
        params={
            "path": "p",
            "take_index": 0,
            "segment_index": 0,
            "part_seq": 0,
        },
        json={"path": "p"} if method == "POST" else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(method: str, path: str) -> None:
    res = _relayed().request(method, path, json={} if method == "POST" else None)

    assert res.status_code == 403


def test_a_loopback_host_caller_is_not_refused_by_the_gate(tmp_path) -> None:
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    res = client.get("/api/record/sessions", params={"path": str(tmp_path / "none.sharecut")})

    assert res.status_code not in {401, 403}
    assert res.headers.get("X-Sharecut-Error-Code") != "authz_denied"
