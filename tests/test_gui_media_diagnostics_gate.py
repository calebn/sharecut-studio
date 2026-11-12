"""The media upload and diagnostics routes sit behind the include-time host gate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import HOST_ROLE_RELAYED_REASON
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

ROUTES = [
    ("POST", "/api/media/upload"),
    ("GET", "/api/diagnostics"),
    ("POST", "/api/diagnostics/bundle"),
    ("GET", "/api/diagnostics/bundle/diag.zip"),
    ("POST", "/api/diagnostics/submit"),
    ("GET", "/api/diagnostics/report-status"),
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

    res = _relayed().request(
        method,
        path,
        params={"path": "p", "filename": "a.wav", "url": "u"},
        json={} if method == "POST" and path != "/api/media/upload" else None,
    )

    assert res.status_code == 403
    assert res.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert res.headers["X-Sharecut-Error-Code"] == "authz_denied"


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_gate_runs_before_request_validation(
    method: str, path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)

    res = _relayed().request(method, path, json={} if method == "POST" else None)

    assert res.status_code == 403
