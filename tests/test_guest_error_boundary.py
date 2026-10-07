"""Guest transports disclose refusals, never exception text from crashes."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.gui.routes import review_share


@pytest.mark.parametrize(
    "error",
    [
        ValueError("broken host state /private/host/project.json"),
        PermissionError(13, "permission denied", "/private/host/project.json"),
    ],
)
def test_guest_http_crash_hides_exception_text(monkeypatch, error):
    def crash(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(review_share, "_check_token", lambda _token: {})
    monkeypatch.setattr(review_share, "_rate_limit", lambda *_args: None)
    monkeypatch.setattr(review_share, "share_daw_project_view", crash)
    app = FastAPI()
    app.include_router(review_share.router)
    response = TestClient(app).get("/api/review/token/daw/project")
    assert response.status_code == 500
    assert response.json() == {"detail": "internal error"}


def test_guest_websocket_os_error_hides_exception_text(monkeypatch):
    async def admit(_websocket, _token):
        return False

    def crash(*_args, **_kwargs):
        raise PermissionError(13, "permission denied", "/private/host/project.json")

    monkeypatch.setattr(review_share, "_admit_review_ws", admit)
    monkeypatch.setattr(review_share, "require_share_cap", crash)
    app = FastAPI()
    app.include_router(review_share.router)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as failure:
            with client.websocket_connect("/api/review/token/daw/ws") as socket:
                socket.receive_json()
                socket.receive_json()
    assert failure.value.code == 1011
    assert failure.value.reason == "internal error"
