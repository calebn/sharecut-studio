"""Security hardening: host authz, served_project pin, body limits."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.ffmpeg import _concat_list_entry
from podcast_mcp.gui.routes.deps import (
    ensure_non_loopback_session_auth,
    is_bind_loopback,
    require_authz,
    require_host,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.gui_launch import viewer_url
from podcast_mcp.services.session_sync.authz import (
    HOST_ROLE_RELAYED_REASON,
    authorize_client,
    authorize_host,
)
from podcast_mcp.util.body_limits import BodyTooLarge, read_body_capped
from podcast_mcp.util.proxy_paths import is_relayed_request


def test_concat_list_entry_escapes_quotes(tmp_path: Path):
    p = tmp_path / "o'brien.wav"
    p.write_bytes(b"x")
    line = _concat_list_entry(p)
    assert "o'\\''brien.wav" in line or "o'\\''brien" in line
    assert line.startswith("file '")


def test_concat_list_entry_rejects_newlines(tmp_path: Path):
    class _Bad:
        def resolve(self):
            return Path("/tmp/bad\nname.wav")

    with pytest.raises(ValueError, match="newlines"):
        _concat_list_entry(_Bad())  # type: ignore[arg-type]


def test_served_project_rejects_other_path(minimal_project, monkeypatch):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    other = Path(minimal_project).parent / "other.project.json"
    other.write_text(Path(minimal_project).read_text(encoding="utf-8"), encoding="utf-8")
    app = create_app(served_project=Path(minimal_project))
    client = TestClient(app)
    ok = client.get(f"/api/project?path={minimal_project}")
    assert ok.status_code == 200
    denied = client.get(f"/api/project?path={other}")
    assert denied.status_code == 403


def test_strict_authz_remote_peer_needs_token(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "sekrit")
    app = create_app()
    client = TestClient(app)
    denied = client.get(f"/api/project?path={minimal_project}")
    assert denied.status_code == 403
    ok = client.get(
        f"/api/project?path={minimal_project}",
        headers={"X-Podcast-Token": "sekrit"},
    )
    assert ok.status_code == 200


@pytest.mark.parametrize("route", ["/api/export/bounce", "/api/export/deliverables"])
def test_export_routes_reject_share_token_guest(
    route: str, minimal_project, published_share, monkeypatch
) -> None:
    """#219: a minted share token (all caps) cannot start host export jobs."""
    _, _, share = published_share(label="guest")
    share_token = share["token"]

    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "session-token")
    monkeypatch.setattr("podcast_mcp.gui.routes.deps.peer_host", lambda _request: "10.0.0.5")
    app = create_app(bind_host="0.0.0.0")
    client = TestClient(app)
    res = client.post(
        f"{route}?token={share_token}",
        json={"path": str(minimal_project)},
        headers={"X-Podcast-Token": share_token},
    )
    assert res.status_code == 403
    assert res.json() == {"detail": "remote client requires PODCAST_SESSION_TOKEN"}
    status = app.state.jobs.status()
    assert status["jobs"] == []  # no bounce/export job was started (or failed)
    assert status["running"] is False


def test_ensure_non_loopback_session_auth(monkeypatch):
    # delenv on an already-unset key does not register undo - SUT writes
    # os.environ directly, so always pop in finally to avoid xdist worker leaks.
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    monkeypatch.delenv("PODCAST_SESSION_TOKEN", raising=False)
    try:
        assert is_bind_loopback("127.0.0.1")
        assert ensure_non_loopback_session_auth("127.0.0.1") is None
        tok = ensure_non_loopback_session_auth("0.0.0.0")
        assert tok
        assert os.environ.get("PODCAST_SESSION_AUTHZ") == "strict"
        assert os.environ.get("PODCAST_SESSION_TOKEN") == tok
        assert ensure_non_loopback_session_auth("0.0.0.0") == tok
    finally:
        os.environ.pop("PODCAST_SESSION_AUTHZ", None)
        os.environ.pop("PODCAST_SESSION_TOKEN", None)


def test_gui_middleware_rejects_large_content_length(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_GUI_MAX_BODY_BYTES", "32")
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    app = create_app()
    client = TestClient(app)
    r = client.post(
        f"/api/pipeline/run?path={minimal_project}",
        content=b"{}",
        headers={"Content-Length": "9999", "Content-Type": "application/json"},
    )
    assert r.status_code in {413, 422, 400}


def _asgi_http_scope(
    *,
    path: str = "/api/document/command",
    method: str = "POST",
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> dict:
    headers: list[tuple[bytes, bytes]] = [(b"content-type", b"application/json")]
    if extra_headers:
        headers.extend(extra_headers)
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 80),
    }


def _once_body_receive(body: bytes):
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    return receive


async def _asgi_ok_app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _asgi_capture_body_app(captured: list[bytes]):
    async def app(scope, receive, send):
        chunks: list[bytes] = []
        more = True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                break
            chunks.append(message.get("body", b""))
            more = bool(message.get("more_body"))
        captured.append(b"".join(chunks))
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    return app


async def _run_middleware(
    mw,
    body: bytes,
    *,
    scope: dict | None = None,
) -> int:
    status_holder: dict[str, int] = {}

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            status_holder["status"] = int(message["status"])

    await mw(scope or _asgi_http_scope(), _once_body_receive(body), send)
    return status_holder["status"]


@pytest.mark.asyncio
async def test_gui_middleware_rejects_oversized_body_without_content_length():
    from podcast_mcp.util.body_limits import MaxBodySizeMiddleware

    body = b"n" * 64
    mw = MaxBodySizeMiddleware(_asgi_ok_app, limit=32)
    status = await _run_middleware(mw, body)
    assert status == 413


@pytest.mark.asyncio
async def test_gui_middleware_replays_body_without_content_length():
    """Under-limit chunked (no Content-Length) POSTs must reach the app intact."""
    from podcast_mcp.util.body_limits import MaxBodySizeMiddleware

    captured: list[bytes] = []
    payload = b'{"ok":true}'
    mw = MaxBodySizeMiddleware(_asgi_capture_body_app(captured), limit=1024)
    status = await _run_middleware(mw, payload)
    assert status == 200
    assert captured == [payload]


@pytest.mark.asyncio
async def test_gui_middleware_passes_through_with_content_length():
    """With Content-Length under the limit, do not buffer/consume the body."""
    from podcast_mcp.util.body_limits import MaxBodySizeMiddleware

    captured: list[bytes] = []
    payload = b'{"ok":true}'
    mw = MaxBodySizeMiddleware(_asgi_capture_body_app(captured), limit=1024)
    scope = _asgi_http_scope(extra_headers=[(b"content-length", str(len(payload)).encode("ascii"))])
    status = await _run_middleware(mw, payload, scope=scope)
    assert status == 200
    assert captured == [payload]


@pytest.mark.asyncio
async def test_gui_middleware_skips_media_upload_path():
    """Media upload routes own their caps; middleware must not 413."""
    from podcast_mcp.util.body_limits import MaxBodySizeMiddleware

    captured: list[bytes] = []
    payload = b"n" * 64
    mw = MaxBodySizeMiddleware(_asgi_capture_body_app(captured), limit=32)
    scope = _asgi_http_scope(path="/api/media/upload")
    status = await _run_middleware(mw, payload, scope=scope)
    assert status == 200
    assert captured == [payload]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    ["/api/record/upload", "/api/rec/cool-name/upload"],
)
async def test_gui_middleware_skips_record_upload_path(path: str):
    from podcast_mcp.util.body_limits import MaxBodySizeMiddleware

    captured: list[bytes] = []
    payload = b"n" * 64
    mw = MaxBodySizeMiddleware(_asgi_capture_body_app(captured), limit=32)
    scope = _asgi_http_scope(path=path)
    status = await _run_middleware(mw, payload, scope=scope)
    assert status == 200
    assert captured == [payload]


@pytest.mark.asyncio
async def test_gui_middleware_aborts_on_client_disconnect():
    """Mid-body disconnect must not replay a truncated payload into the app."""
    from starlette.requests import ClientDisconnect

    from podcast_mcp.util.body_limits import MaxBodySizeMiddleware

    called = {"app": False}

    async def app(scope, receive, send):
        called["app"] = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    step = 0

    async def receive() -> dict:
        nonlocal step
        step += 1
        if step == 1:
            return {"type": "http.request", "body": b"partial", "more_body": True}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        raise AssertionError(f"unexpected send: {message!r}")

    mw = MaxBodySizeMiddleware(app, limit=1024)
    with pytest.raises(ClientDisconnect):
        await mw(_asgi_http_scope(), receive, send)
    assert called["app"] is False


def test_require_authz_raises(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.delenv("PODCAST_SESSION_TOKEN", raising=False)
    with pytest.raises(HTTPException) as exc:
        require_authz(
            client_id="viewer",
            role="viewer",
            peer_host="1.2.3.4",
            token=None,
        )
    assert exc.value.status_code == 403


def test_is_relayed_request():
    from starlette.datastructures import Headers

    assert is_relayed_request(Headers({"X-Sharecut-Relayed": "1"})) is True
    assert is_relayed_request(Headers({})) is False
    assert is_relayed_request(Headers({"x-sharecut-relayed": ""})) is True


def test_authorize_host_rules(monkeypatch):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    monkeypatch.delenv("PODCAST_SESSION_TOKEN", raising=False)

    denied = authorize_host(peer_host="127.0.0.1", relayed=True)
    assert denied.allowed is False
    assert denied.reason == HOST_ROLE_RELAYED_REASON

    allowed = authorize_host(peer_host="127.0.0.1", relayed=False)
    assert allowed.allowed is True

    assert authorize_host(client_id="", peer_host="127.0.0.1").allowed is False

    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "sekrit")

    remote_no_token = authorize_host(peer_host="10.0.0.5")
    assert remote_no_token.allowed is False

    remote_with_token = authorize_host(peer_host="10.0.0.5", token="sekrit")
    assert remote_with_token.allowed is True

    remote_with_token_relayed = authorize_host(peer_host="10.0.0.5", token="sekrit", relayed=True)
    assert remote_with_token_relayed.allowed is False
    assert remote_with_token_relayed.reason == HOST_ROLE_RELAYED_REASON


def test_authorize_client_denies_relayed():
    decision = authorize_client(client_id="a", role="viewer", peer_host="127.0.0.1", relayed=True)
    assert decision.allowed is False


def test_require_host_raises_for_relayed():
    from fastapi import HTTPException
    from starlette.requests import Request

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": [(b"x-sharecut-relayed", b"1")],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 80),
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    req = Request(scope, receive)
    with pytest.raises(HTTPException) as exc:
        require_host(req)
    assert exc.value.status_code == 403


@pytest.mark.parametrize(
    ("method", "path", "path_in_query", "json_body"),
    [
        ("get", "/api/project", True, None),
        ("post", "/api/project/close", False, None),
        (
            "put",
            "/api/transcript/vocabulary",
            False,
            {"terms": ["x"], "guest_names": [], "base_revision": None},
        ),
        ("post", "/api/transcript/refine/waive", False, {"reason": "x"}),
        ("post", "/api/pipeline/cancel", False, {}),
        ("post", "/api/export/bounce", False, {}),
        ("post", "/api/diagnostics/bundle", False, {}),
        ("post", "/api/bootstrap/cancel", False, {}),
        ("post", "/api/record/land", True, None),
        ("post", "/api/shares", False, {}),
        (
            "post",
            "/api/comments",
            False,
            {"body": "x", "author": "a", "timeline_start": 0.0},
        ),
        ("post", "/api/session/state", True, {}),
        (
            "post",
            "/api/document/command",
            True,
            {
                "type": "CorrectTranscriptWord",
                "payload": {"track_id": "host", "word_index": 0, "text": "x"},
                "client_id": "viewer",
                "client_seq": 1,
                "role": "viewer",
            },
        ),
    ],
)
def test_owner_routes_reject_relayed_requests(
    method: str,
    path: str,
    path_in_query: bool,
    json_body: dict | None,
    minimal_project,
    monkeypatch,
) -> None:
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    P = str(minimal_project)
    client = TestClient(create_app())
    before = minimal_project.read_bytes()

    kwargs: dict = {"headers": {"X-Sharecut-Relayed": "1"}}
    if path_in_query:
        kwargs["params"] = {"path": P}
    elif json_body is not None:
        json_body = {**json_body, "path": P}
    if json_body is not None:
        kwargs["json"] = json_body

    caller = getattr(client, method)
    response = caller(path, **kwargs)
    assert response.status_code == 403
    assert response.json() == {"detail": HOST_ROLE_RELAYED_REASON}
    assert minimal_project.read_bytes() == before


@pytest.mark.parametrize("path", ["/api/document/ws", "/api/session/ws"])
def test_owner_ws_rejects_relayed(path: str, minimal_project, monkeypatch) -> None:
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    client = TestClient(create_app())
    url = f"{path}?path={minimal_project}&client_id=c1&role=viewer"
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url, headers={"X-Sharecut-Relayed": "1"}):
            pass
    assert exc.value.code == 4403


def test_guest_review_route_accepts_relayed(published_share, monkeypatch) -> None:
    monkeypatch.setenv("PODCAST_RATE_LIMIT", "0")
    _, _, share = published_share(label="guest")
    token = share["token"]
    client = TestClient(create_app())
    response = client.get(
        f"/api/review/{token}/daw/meta",
        headers={"X-Sharecut-Relayed": "1"},
    )
    assert response.status_code == 200


def test_viewer_url_with_session_token(tmp_path: Path):
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    url = viewer_url("0.0.0.0", 8765, proj, session_token="abc")
    assert "session_token=abc" in url


@pytest.mark.asyncio
async def test_read_body_capped():
    from starlette.requests import Request

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 123),
        "server": ("127.0.0.1", 80),
    }
    body = b"hello"
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.request", "body": b"", "more_body": False}

    req = Request(scope, receive)
    assert await read_body_capped(req, 10) == body

    sent = False
    req2 = Request(scope, receive)
    with pytest.raises(BodyTooLarge):
        await read_body_capped(req2, 2)


def test_host_binding_rejects_evil_host(minimal_project, monkeypatch):
    from podcast_mcp.gui.middleware_host_binding import (
        host_header_is_allowed,
        origin_is_loopback,
        path_requires_host_binding,
    )

    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    assert path_requires_host_binding("/api/project/open")
    assert path_requires_host_binding("/api/project/pick")
    assert path_requires_host_binding("/api/audio")
    assert path_requires_host_binding("/api/peaks/host")
    assert path_requires_host_binding("/api/waveform-snap")
    assert path_requires_host_binding("/api/waveform/tiles/x")
    assert path_requires_host_binding("/api/waveform/status")
    assert path_requires_host_binding("/api/waveform/pcm/x")
    assert path_requires_host_binding("/api/history/diff")
    assert path_requires_host_binding("/api/shares")
    assert path_requires_host_binding("/api/record/command")
    assert path_requires_host_binding("/api/record/state")
    assert path_requires_host_binding("/api/export/bounce")
    assert path_requires_host_binding("/api/export/deliverables")
    assert path_requires_host_binding("/api/diagnostics")
    assert path_requires_host_binding("/api/diagnostics/bundle")
    assert path_requires_host_binding("/api/transcript/refine/waive")
    assert not path_requires_host_binding("/api/review/tok/project")
    assert host_header_is_allowed("127.0.0.1:8765")
    assert host_header_is_allowed("localhost")
    assert host_header_is_allowed("testserver")
    assert host_header_is_allowed("[::1]:8765")
    assert not host_header_is_allowed("evil.example")
    assert not host_header_is_allowed("")
    assert origin_is_loopback(None)
    assert origin_is_loopback("http://127.0.0.1:5173")
    assert not origin_is_loopback("https://evil.example")
    assert not origin_is_loopback("ftp://127.0.0.1")

    app = create_app()
    client = TestClient(app)
    denied = client.post(
        "/api/project/open",
        json={"path": str(minimal_project)},
        headers={"Host": "evil.example"},
    )
    assert denied.status_code == 400
    denied_audio = client.get(
        f"/api/audio?path={minimal_project}&kind=premix",
        headers={"Host": "evil.example"},
    )
    assert denied_audio.status_code == 400
    denied_origin = client.post(
        "/api/project/open",
        json={"path": str(minimal_project)},
        headers={"Host": "127.0.0.1:8765", "Origin": "https://evil.example"},
    )
    assert denied_origin.status_code == 403
    denied_referer = client.post(
        "/api/project/open",
        json={"path": str(minimal_project)},
        headers={"Host": "127.0.0.1:8765", "Referer": "https://evil.example/x"},
    )
    assert denied_referer.status_code == 403
    denied_transcript_host = client.post(
        "/api/transcript/refine/waive",
        json={"path": str(minimal_project), "reason": "reviewed"},
        headers={"Host": "evil.example"},
    )
    assert denied_transcript_host.status_code == 400
    denied_transcript_origin = client.post(
        "/api/transcript/refine/waive",
        json={"path": str(minimal_project), "reason": "reviewed"},
        headers={"Host": "127.0.0.1:8765", "Origin": "https://evil.example"},
    )
    assert denied_transcript_origin.status_code == 403


def test_websocket_host_binding_denied_helper():
    from podcast_mcp.gui.middleware_host_binding import websocket_host_binding_denied

    class FakeWS:
        def __init__(self, headers: dict[str, str]):
            self.headers = headers

    assert (
        websocket_host_binding_denied(FakeWS({"host": "evil.example"}))
        == "invalid Host header for host GUI"
    )
    assert (
        websocket_host_binding_denied(
            FakeWS({"host": "127.0.0.1:8765", "origin": "https://evil.example"})
        )
        == "Origin not allowed for host GUI"
    )
    assert (
        websocket_host_binding_denied(
            FakeWS({"host": "127.0.0.1:8765", "referer": "https://evil.example/x"})
        )
        == "Referer not allowed for host GUI"
    )
    assert websocket_host_binding_denied(FakeWS({"host": "127.0.0.1:8765"})) is None


def test_served_project_pins_comments(minimal_project, monkeypatch):
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ", raising=False)
    other = Path(minimal_project).parent / "other.project.json"
    other.write_text(Path(minimal_project).read_text(encoding="utf-8"), encoding="utf-8")
    app = create_app(served_project=Path(minimal_project))
    client = TestClient(app)
    denied = client.post(
        "/api/comments",
        json={
            "path": str(other),
            "body": "hi",
            "author": "x",
            "timeline_start": 0.0,
        },
    )
    assert denied.status_code == 403
    ok = client.post(
        "/api/comments",
        json={
            "path": str(minimal_project),
            "body": "hi",
            "author": "x",
            "timeline_start": 0.0,
        },
    )
    assert ok.status_code == 200
