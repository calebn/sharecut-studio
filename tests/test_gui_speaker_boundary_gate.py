"""The speaker and boundary routes sit behind the include-time host gate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("GET", "/api/speaker/doctor"),
    ("POST", "/api/speaker/split"),
    ("POST", "/api/speaker/move-lane-span"),
    ("POST", "/api/boundary/context"),
    ("POST", "/api/boundary/audition"),
    ("GET", "/api/boundary/audition/opaque/left"),
]


def _relayed() -> TestClient:
    return TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_refuses_a_relayed_caller(
    method: str, path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)

    res = _relayed().request(method, path, params={"expected_token": "t"}, json=None)

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(
    method: str, path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)

    res = _relayed().request(method, path, json={} if method == "POST" else None)

    assert res.status_code == 403
