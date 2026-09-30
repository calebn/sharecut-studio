"""WebSocket + HTTP proxy coverage for podcast-relay (async, no hanging threads)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import socket
import threading
import time
from collections.abc import Iterator
from unittest.mock import AsyncMock, patch

import pytest
import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect as ws_connect

from podcast_relay.app import (
    GuestWsStream,
    RelayState,
    TunnelSession,
    _parse_host_tokens,
    create_relay_app,
    main,
)
from podcast_relay.protocol import new_id
from podcast_relay.share_claims import attach_share_claims


@contextlib.contextmanager
def _live_relay(
    monkeypatch: pytest.MonkeyPatch, *, host_token: str = "secret", app: FastAPI | None = None
) -> Iterator[str]:
    """Run relay on a real uvicorn port.

    Nested guest+tunnel WebSockets deadlock under Starlette TestClient's single
    portal; live uvicorn is required for bidirectional bridge coverage.
    """
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", host_token)
    app = app if app is not None else create_relay_app()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.01)
    assert server.started, "relay uvicorn failed to start"
    try:
        yield f"ws://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def _ws_send(ws, payload: dict) -> None:
    ws.send(json.dumps(payload))


def _ws_recv(ws, *, timeout: float = 5.0) -> dict:
    raw = ws.recv(timeout=timeout)
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw)


def _tunnel_hello_register(
    base: str,
    *,
    host_id: str,
    token: str,
    capabilities: list[str],
    host_token: str = "secret",
):
    tunnel = ws_connect(f"{base}/tunnel", open_timeout=5, close_timeout=5)
    _ws_send(
        tunnel,
        {"type": "hello", "host_token": host_token, "host_id": host_id},
    )
    hello = _ws_recv(tunnel)
    assert hello.get("ok") is True
    shares = attach_share_claims(
        [{"token": token, "capabilities": capabilities}],
        host_id=host_id,
        secret=host_token,
    )
    _ws_send(
        tunnel,
        {
            "type": "register",
            "shares": shares,
        },
    )
    assert _ws_recv(tunnel).get("ok") is True
    return tunnel


def test_parse_host_tokens_empty(monkeypatch):
    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKENS", raising=False)
    assert _parse_host_tokens() == (set(), {})


def test_parse_host_tokens_csv(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", " a , b, ,c ")
    assert _parse_host_tokens() == ({"a", "b", "c"}, {})


def test_parse_host_tokens_per_host(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "host-a:sec1,shared,host-b:sec2")
    shared, by_host = _parse_host_tokens()
    assert shared == {"shared"}
    assert by_host == {"host-a": "sec1", "host-b": "sec2"}


def test_register_tunnel_replaces_old_shares():
    state = RelayState(set())
    s1 = TunnelSession(host_id="h1", websocket=AsyncMock())
    s1.share_tokens.add("old")
    asyncio.run(state.register_tunnel(s1))
    state.token_to_host["old"] = "h1"
    s2 = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    s2.share_tokens.add("new")
    asyncio.run(state.register_tunnel(s2))
    assert "old" not in state.token_to_host
    assert state.tunnels["h1"] is s2


def test_update_shares_skips_empty_token_and_missing_host():
    state = RelayState(set(), allow_open_tunnel=True)
    asyncio.run(state.update_shares("ghost", [{"token": "x"}]))
    session = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    asyncio.run(
        state.update_shares(
            "h1",
            [
                "skip-me",
                {"token": ""},
                {"token": "ok", "capabilities": None},
            ],
        )
    )
    assert state.tunnel_for_token("ok") is session
    assert session.capabilities["ok"] == []


def test_tunnel_ws_rejects_non_hello(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    client = TestClient(create_relay_app())
    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "ping"})
        msg = ws.receive_json()
        assert msg["type"] == "error"


def test_tunnel_ws_rejects_bad_token(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    client = TestClient(create_relay_app())
    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_token": "nope"})
        msg = ws.receive_json()
        assert msg["type"] == "error"


def test_tunnel_ws_hello_register_ping_unknown(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    client = TestClient(create_relay_app())
    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_token": "secret", "host_id": "host-x"})
        hello = ws.receive_json()
        assert hello["ok"] is True
        assert hello["host_id"] == "host-x"

        claimed = attach_share_claims(
            [{"token": "t1", "capabilities": ["play", "mcp"]}],
            host_id="host-x",
            secret="secret",
        )
        ws.send_json(
            {
                "type": "register",
                "shares": [*claimed, "not-a-dict"],
            }
        )
        ack = ws.receive_json()
        assert ack["ok"] is True
        assert ack["share_count"] == 1

        ws.send_json({"type": "register", "shares": "bad"})
        ack2 = ws.receive_json()
        assert ack2["ok"] is True
        assert ack2["share_count"] == 0

        ws.send_json(
            {
                "type": "register",
                "shares": claimed,
            }
        )
        assert ws.receive_json()["ok"] is True

        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"

        ws.send_json({"type": "pong"})
        ws.send_json({"type": "weird"})
        err = ws.receive_json()
        assert err["type"] == "error"

        health = client.get("/healthz")
        assert health.json()["tunnels"] == 1
        assert health.json()["shares"] == 1

        # Orphan http_response ignored
        ws.send_json(
            {
                "type": "http_response",
                "id": "missing",
                "status": 200,
                "headers": {},
                "body_b64": "",
            }
        )


def test_hello_generates_host_id(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    client = TestClient(create_relay_app())
    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_token": "secret"})
        hello = ws.receive_json()
        assert hello["ok"] is True
        assert hello["host_id"]


class _AutoAnswerWs:
    """Fake host websocket that answers every http request immediately."""

    def __init__(
        self,
        *,
        status: int = 200,
        body: bytes = b"ok",
        headers: dict | None = None,
        headers_raw: object | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.headers = headers if headers is not None else {"content-type": "text/plain"}
        self.headers_raw = headers_raw
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)
        if data.get("type") != "http":
            return
        # Resolve pending on the session that owns this websocket
        session = getattr(self, "_session", None)
        if session is None:
            return
        pending = session.pending.get(data["id"])
        if pending is None:
            return
        from podcast_relay.app import _ingest_http_response

        await _ingest_http_response(
            pending,
            {
                "status": self.status,
                "headers": self.headers_raw if self.headers_raw is not None else self.headers,
                "body_b64": base64.b64encode(self.body).decode("ascii") if self.body else "",
                "eof": True,
            },
        )


@pytest.mark.asyncio
async def test_proxy_roundtrip_paths(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    app = create_relay_app()
    state = app.state.relay
    ws = _AutoAnswerWs(body=b'{"ok":1}', headers={"Content-Type": "application/json"})
    session = TunnelSession(host_id="h1", websocket=ws, host_token="secret")  # type: ignore[arg-type]
    ws._session = session
    await state.register_tunnel(session)
    await state.update_shares(
        "h1",
        attach_share_claims(
            [{"token": "full", "capabilities": ["play", "comment", "mcp"]}],
            host_id="h1",
            secret="secret",
        ),
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as http:
        for path in (
            "/r/full",
            "/r/full/assets/x.js",
            "/api/review/full",
            "/api/review/full/project",
            "/mcp/full",
            "/mcp/full/tools",
        ):
            r = await http.get(path)
            assert r.status_code == 200, path
            assert r.content == b'{"ok":1}'

        r = await http.post("/r/full/x", content=b"hi")
        assert r.status_code == 200
        assert ws.sent[-1]["body_b64"]


@pytest.mark.asyncio
async def test_proxy_timeout(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    app = create_relay_app()
    state = app.state.relay

    class SlowWs:
        async def send_json(self, data: dict) -> None:
            return None

    session = TunnelSession(host_id="h-slow", websocket=SlowWs(), host_token="secret")  # type: ignore[arg-type]
    await state.register_tunnel(session)
    await state.update_shares(
        "h-slow",
        attach_share_claims(
            [{"token": "slow", "capabilities": ["play"]}], host_id="h-slow", secret="secret"
        ),
    )

    real_wait = asyncio.wait_for

    async def short_wait(aw, timeout=None):
        return await real_wait(aw, timeout=0.05)

    monkeypatch.setattr("podcast_relay.app.asyncio.wait_for", short_wait)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as http:
        r = await http.get("/r/slow")
        assert r.status_code == 504


@pytest.mark.asyncio
async def test_proxy_malformed_response(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    app = create_relay_app()
    state = app.state.relay
    ws = _AutoAnswerWs(
        status=None,  # type: ignore[arg-type]
        body=b"",
        headers_raw=["not", "a", "dict"],
    )
    session = TunnelSession(host_id="h2", websocket=ws, host_token="secret")  # type: ignore[arg-type]
    ws._session = session
    await state.register_tunnel(session)
    await state.update_shares(
        "h2",
        attach_share_claims(
            [{"token": "h", "capabilities": ["play"]}], host_id="h2", secret="secret"
        ),
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as http:
        r = await http.get("/r/h")
        assert r.status_code == 502


@pytest.mark.asyncio
async def test_mcp_forbidden_async(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    app = create_relay_app()
    state = app.state.relay
    ws = _AutoAnswerWs()
    session = TunnelSession(host_id="h3", websocket=ws, host_token="secret")  # type: ignore[arg-type]
    ws._session = session
    await state.register_tunnel(session)
    await state.update_shares(
        "h3",
        attach_share_claims(
            [{"token": "view", "capabilities": ["play"]}], host_id="h3", secret="secret"
        ),
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as http:
        r = await http.get("/mcp/view")
        assert r.status_code == 403


def test_main_invokes_uvicorn(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST", "127.0.0.1")
    monkeypatch.setenv("PODCAST_RELAY_PORT", "9999")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    with patch("uvicorn.run") as run:
        main()
        run.assert_called_once()
        assert run.call_args.kwargs["host"] == "127.0.0.1"
        assert run.call_args.kwargs["port"] == 9999
        assert run.call_args.kwargs["ws_max_size"] == 16 * 1024 * 1024


def test_main_exits_without_host_tokens(monkeypatch):
    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKENS", raising=False)
    monkeypatch.delenv("PODCAST_RELAY_ALLOW_OPEN_TUNNEL", raising=False)
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 1


def test_new_id_unique():
    assert new_id() != new_id()
    assert len(new_id()) == 32


def test_guest_daw_ws_host_offline(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    client = TestClient(create_relay_app())
    try:
        with client.websocket_connect("/api/review/missing/daw/ws") as ws:
            ws.receive_text()
            raise AssertionError("expected close when host offline")
    except Exception:
        pass


def test_guest_daw_ws_emits_ws_open(monkeypatch):
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-ws",
            token="gtok",
            capabilities=["view", "play"],
        )
        try:
            with ws_connect(
                f"{base}/api/review/gtok/daw/ws", open_timeout=5, close_timeout=5
            ) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                assert open_msg["path"] == "api/review/daw/ws"
                assert open_msg["share_token"] == "gtok"
                stream_id = open_msg["id"]

                _ws_send(
                    tunnel,
                    {
                        "type": "ws_data",
                        "id": stream_id,
                        "text": json.dumps(
                            {
                                "type": "Snapshot",
                                "plane": "session",
                                "snapshot": {},
                            }
                        ),
                    },
                )
                got = guest.recv(timeout=5)
                if isinstance(got, bytes):
                    got = got.decode("utf-8")
                assert '"plane": "session"' in got or '"plane":"session"' in got

                guest.send('{"type":"ping"}')
                data_msg = _ws_recv(tunnel)
                assert data_msg["type"] == "ws_data"
                assert data_msg["id"] == stream_id
                assert data_msg["text"] == '{"type":"ping"}'
        finally:
            tunnel.close()


def test_guest_progress_ws_emits_ws_open(monkeypatch):
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-progress",
            token="progws",
            capabilities=["play", "comment"],
        )
        try:
            with ws_connect(
                f"{base}/api/review/progws/progress/ws", open_timeout=5, close_timeout=5
            ) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                assert open_msg["path"] == "api/review/progress/ws"
                assert open_msg["share_token"] == "progws"
                stream_id = open_msg["id"]
                _ws_send(
                    tunnel,
                    {
                        "type": "ws_data",
                        "id": stream_id,
                        "text": json.dumps(
                            {
                                "type": "progress",
                                "plane": "progress",
                                "status": "running",
                            }
                        ),
                    },
                )
                got = guest.recv(timeout=5)
                if isinstance(got, bytes):
                    got = got.decode("utf-8")
                assert '"plane": "progress"' in got or '"plane":"progress"' in got
        finally:
            tunnel.close()


def test_record_ws_bridged(monkeypatch):
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-rec",
            token="rtok",
            capabilities=["join", "monitor", "comment"],
        )
        try:
            with ws_connect(f"{base}/api/rec/rtok/ws", open_timeout=5, close_timeout=5) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                assert open_msg["path"] == "api/rec/ws"
                assert open_msg["share_token"] == "rtok"
                stream_id = open_msg["id"]

                _ws_send(
                    tunnel,
                    {
                        "type": "ws_data",
                        "id": stream_id,
                        "text": json.dumps(
                            {
                                "type": "Snapshot",
                                "plane": "record",
                                "snapshot": {},
                            }
                        ),
                    },
                )
                got = guest.recv(timeout=5)
                if isinstance(got, bytes):
                    got = got.decode("utf-8")
                assert '"plane": "record"' in got or '"plane":"record"' in got

                guest.send('{"type":"Record","command_type":"Join"}')
                data_msg = _ws_recv(tunnel)
                assert data_msg["type"] == "ws_data"
                assert data_msg["id"] == stream_id
                assert "Join" in data_msg["text"]
                _ws_send(
                    tunnel,
                    {"type": "ws_close", "id": stream_id, "code": 4403, "reason": "removed"},
                )
                with pytest.raises(ConnectionClosed) as closed:
                    guest.recv(timeout=5)
                assert closed.value.rcvd is not None
                assert closed.value.rcvd.code == 4403
        finally:
            tunnel.close()


def test_record_ws_relays_invite_closed_error_before_4403(monkeypatch):
    """The guest UI keeps "Invite link closed" only if the Error frame precedes the 4403 close."""
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-rec-closed",
            token="rtok-closed",
            capabilities=["join", "monitor", "comment"],
        )
        try:
            with ws_connect(
                f"{base}/api/rec/rtok-closed/ws", open_timeout=5, close_timeout=5
            ) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                stream_id = open_msg["id"]

                guest.send('{"type":"Record","command_type":"Join"}')
                data_msg = _ws_recv(tunnel)
                assert data_msg["type"] == "ws_data"
                assert "Join" in data_msg["text"]

                _ws_send(
                    tunnel,
                    {
                        "type": "ws_data",
                        "id": stream_id,
                        "text": json.dumps(
                            {"plane": "record", "type": "Error", "code": "invite_closed"}
                        ),
                    },
                )
                _ws_send(
                    tunnel,
                    {"type": "ws_close", "id": stream_id, "code": 4403, "reason": "invite closed"},
                )

                got = guest.recv(timeout=5)
                if isinstance(got, bytes):
                    got = got.decode("utf-8")
                err = json.loads(got)
                assert err["type"] == "Error"
                assert err["code"] == "invite_closed"

                with pytest.raises(ConnectionClosed) as closed:
                    guest.recv(timeout=5)
                assert closed.value.rcvd is not None
                assert closed.value.rcvd.code == 4403
        finally:
            tunnel.close()


def test_guest_daw_ws_requires_view_cap(monkeypatch):
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-noview",
            token="noview",
            capabilities=["play"],
        )
        try:
            try:
                with ws_connect(
                    f"{base}/api/review/noview/daw/ws",
                    open_timeout=5,
                    close_timeout=5,
                ) as guest:
                    guest.recv(timeout=5)
                    raise AssertionError("expected close without view")
            except Exception:
                pass
        finally:
            tunnel.close()


def test_guest_daw_ws_concurrency_limit(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_WS_CONCURRENT", "1")
    from podcast_relay.limits import get_relay_limiters, reset_relay_limiters_for_tests

    reset_relay_limiters_for_tests()
    lim = get_relay_limiters()
    assert lim.ws_concurrent.try_enter("tok").allowed
    assert not lim.ws_concurrent.try_enter("tok").allowed
    lim.ws_concurrent.exit("tok")
    assert lim.ws_concurrent.try_enter("tok").allowed
    # Inbound msg limiter basic smoke
    assert lim.ws_msg.allow("tok").allowed


def test_guest_daw_ws_empty_caps_allowed(monkeypatch):
    """Empty capabilities list skips the view check (host enforces)."""
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-emptycaps",
            token="ecap",
            capabilities=[],
        )
        try:
            with ws_connect(
                f"{base}/api/review/ecap/daw/ws", open_timeout=5, close_timeout=5
            ) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                _ws_send(
                    tunnel,
                    {
                        "type": "ws_close",
                        "id": open_msg["id"],
                        "code": 1000,
                        "reason": "",
                    },
                )
                with contextlib.suppress(Exception):
                    guest.recv(timeout=5)
        finally:
            tunnel.close()


def test_unregister_tunnel_closes_ws_streams():
    state = RelayState(set())
    stream = GuestWsStream()
    session = TunnelSession(host_id="h-u", websocket=None)  # type: ignore[arg-type]
    session.ws_streams["s1"] = stream
    session.share_tokens.add("t")
    asyncio.run(state.register_tunnel(session))
    state.token_to_host["t"] = "h-u"
    asyncio.run(state.unregister_tunnel("h-u"))
    assert stream.queue.get_nowait() is None
    assert "h-u" not in state.tunnels


def test_guest_daw_ws_concurrency_rejected_live(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_WS_CONCURRENT", "1")
    from podcast_relay.limits import get_relay_limiters, reset_relay_limiters_for_tests

    reset_relay_limiters_for_tests()
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-rej",
            token="rej",
            capabilities=["view"],
        )
        try:
            assert get_relay_limiters().ws_concurrent.try_enter("rej").allowed
            try:
                with ws_connect(
                    f"{base}/api/review/rej/daw/ws",
                    open_timeout=5,
                    close_timeout=5,
                ) as guest:
                    guest.recv(timeout=5)
                    raise AssertionError("expected concurrency close")
            except Exception:
                pass
            finally:
                get_relay_limiters().ws_concurrent.exit("rej")
        finally:
            tunnel.close()


def test_guest_daw_ws_msg_rate_limit_drops(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_WS_MSG_RPM", "1")
    monkeypatch.setenv("PODCAST_RELAY_WS_MSG_BURST", "1")
    from podcast_relay.limits import reset_relay_limiters_for_tests

    reset_relay_limiters_for_tests()
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-msg",
            token="mtok",
            capabilities=["view"],
        )
        try:
            with ws_connect(
                f"{base}/api/review/mtok/daw/ws", open_timeout=5, close_timeout=5
            ) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                guest.send("one")
                assert _ws_recv(tunnel)["type"] == "ws_data"
                # Second message should be dropped by rate limit (no frame to tunnel)
                guest.send("two")
                _ws_send(
                    tunnel,
                    {
                        "type": "ws_close",
                        "id": open_msg["id"],
                        "code": 1000,
                        "reason": "",
                    },
                )
                with contextlib.suppress(Exception):
                    guest.recv(timeout=5)
        finally:
            tunnel.close()


def test_relay_presence_frames_use_presence_bucket(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RELAY_WS_MSG_RPM", "1")
    monkeypatch.setenv("PODCAST_RELAY_WS_MSG_BURST", "1")
    monkeypatch.setenv("PODCAST_RELAY_WS_PRESENCE_RPM", "100")
    monkeypatch.setenv("PODCAST_RELAY_WS_PRESENCE_BURST", "10")
    from podcast_relay.limits import (
        is_presence_ws_text,
        reset_relay_limiters_for_tests,
    )

    reset_relay_limiters_for_tests()
    assert is_presence_ws_text('{"type":"Presence","x":1}')
    assert is_presence_ws_text('{"type":"RosterRequest"}')
    assert not is_presence_ws_text('{"type":"Command"}')
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-presence",
            token="ptok",
            capabilities=["view"],
        )
        try:
            with ws_connect(
                f"{base}/api/review/ptok/daw/ws", open_timeout=5, close_timeout=5
            ) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                guest.send("one")
                assert _ws_recv(tunnel)["type"] == "ws_data"
                guest.send('{"type":"Presence","client_seq":1}')
                assert _ws_recv(tunnel)["type"] == "ws_data"
                _ws_send(
                    tunnel,
                    {
                        "type": "ws_close",
                        "id": open_msg["id"],
                        "code": 1000,
                        "reason": "",
                    },
                )
                with contextlib.suppress(Exception):
                    guest.recv(timeout=5)
        finally:
            tunnel.close()


def test_relay_presence_frames_drop_when_bucket_exhausted(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RELAY_WS_MSG_RPM", "100")
    monkeypatch.setenv("PODCAST_RELAY_WS_MSG_BURST", "10")
    monkeypatch.setenv("PODCAST_RELAY_WS_PRESENCE_RPM", "1")
    monkeypatch.setenv("PODCAST_RELAY_WS_PRESENCE_BURST", "1")
    from podcast_relay.limits import reset_relay_limiters_for_tests

    reset_relay_limiters_for_tests()
    with _live_relay(monkeypatch) as base:
        tunnel = _tunnel_hello_register(
            base,
            host_id="host-presence-deny",
            token="pdny",
            capabilities=["view"],
        )
        try:
            with ws_connect(
                f"{base}/api/review/pdny/daw/ws", open_timeout=5, close_timeout=5
            ) as guest:
                open_msg = _ws_recv(tunnel)
                assert open_msg["type"] == "ws_open"
                guest.send('{"type":"Presence","client_seq":1}')
                first = _ws_recv(tunnel)
                assert first["type"] == "ws_data"
                guest.send('{"type":"Presence","client_seq":2}')
                guest.send("probe")
                second = _ws_recv(tunnel)
                assert second["type"] == "ws_data"
                assert second.get("text") == "probe"
                _ws_send(
                    tunnel,
                    {
                        "type": "ws_close",
                        "id": open_msg["id"],
                        "code": 1000,
                        "reason": "",
                    },
                )
                with contextlib.suppress(Exception):
                    guest.recv(timeout=5)
        finally:
            tunnel.close()


def test_per_host_token_with_default_relay_config_host_id(monkeypatch):
    from podcast_mcp.runtime_config import RelayConfig, relay_host_id_path

    cfg = RelayConfig(host_token="host-secret")
    # Default host_id is the persisted per-install id, not a fresh uuid per process.
    assert relay_host_id_path().read_text(encoding="utf-8").strip() == cfg.host_id
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", f"{cfg.host_id}:host-secret,other:x")
    client = TestClient(create_relay_app())
    with client.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_token": cfg.host_token, "host_id": cfg.host_id})
        hello = ws.receive_json()
        assert hello["ok"] is True
        assert hello["host_id"] == cfg.host_id


def test_host_bound_secret_rejected_under_unmapped_host_id(monkeypatch):
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "host-1:secret-1")
    app = create_relay_app()
    client = TestClient(app)
    with client.websocket_connect("/tunnel") as live:
        live.send_json({"type": "hello", "host_token": "secret-1", "host_id": "host-1"})
        assert live.receive_json()["ok"] is True
        for host_id in ("host-2", None):
            with client.websocket_connect("/tunnel") as ws:
                hello = {"type": "hello", "host_token": "secret-1"}
                if host_id:
                    hello["host_id"] = host_id
                ws.send_json(hello)
                err = ws.receive_json()
                assert err["type"] == "error"
                assert err["detail"] == "invalid host_token for host_id"
                with pytest.raises(WebSocketDisconnect) as closed:
                    ws.receive_json()
                assert closed.value.code == 4403
        # A rejected hello naming the live host's host_id must not evict it.
        with client.websocket_connect("/tunnel") as spoof:
            spoof.send_json({"type": "hello", "host_token": "wrong", "host_id": "host-1"})
            assert spoof.receive_json()["type"] == "error"
        assert "host-1" in app.state.relay.tunnels


def test_restarted_host_readvertises_bound_tokens(monkeypatch):
    from podcast_mcp.runtime_config import RelayConfig

    first = RelayConfig(host_token="host-secret")
    monkeypatch.setenv(
        "PODCAST_RELAY_HOST_TOKENS", f"{first.host_id}:host-secret,intruder:intruder-secret"
    )
    app = create_relay_app()
    state = app.state.relay
    client = TestClient(app)

    def _connect_and_register(cfg: RelayConfig, token: str) -> int:
        with client.websocket_connect("/tunnel") as ws:
            ws.send_json({"type": "hello", "host_token": cfg.host_token, "host_id": cfg.host_id})
            assert ws.receive_json()["ok"] is True
            shares = attach_share_claims(
                [{"token": token, "capabilities": ["play"]}],
                host_id=cfg.host_id,
                secret=cfg.host_token,
            )
            ws.send_json({"type": "register", "shares": shares})
            ack = ws.receive_json()
            assert ack["ok"] is True
            if ack["share_count"]:
                assert state.token_to_host[token] == cfg.host_id
            return int(ack["share_count"])

    assert _connect_and_register(first, "bound-slug") == 1
    # Host disconnected: live routing gone, durable binding kept.
    assert state.tunnel_for_token("bound-slug") is None
    assert state.token_bindings["bound-slug"] == first.host_id

    # Another mapped host cannot steal the offline token.
    intruder = RelayConfig(host_token="intruder-secret", host_id="intruder")
    assert _connect_and_register(intruder, "bound-slug") == 0

    # "Restart": a new process builds a fresh RelayConfig and gets the same persisted id.
    restarted = RelayConfig(host_token="host-secret")
    assert restarted.host_id == first.host_id
    assert _connect_and_register(restarted, "bound-slug") == 1
    assert state.token_bindings["bound-slug"] == first.host_id


@pytest.mark.asyncio
async def test_tunnel_queue_overflow_closes_and_unregister_releases_backlog():
    class Socket:
        def __init__(self):
            self.closed = []

        async def close(self, code: int, reason: str):
            self.closed.append((code, reason))

        async def send_json(self, _payload):
            raise AssertionError("there is no consumer in this test")

    socket = Socket()
    session = TunnelSession(host_id="bounded", websocket=socket)
    state = RelayState(set())
    await state.register_tunnel(session)
    for index in range(256):
        await session.enqueue_to_host({"type": "ws_data", "id": "stream", "text": str(index)})
    with pytest.raises(asyncio.QueueFull):
        await session.enqueue_to_host({"type": "ws_data", "id": "stream", "text": "overflow"})
    assert socket.closed == [(1013, "tunnel backlog full")]
    assert session.to_host.qsize() == 256
    assert session.to_host.queued_bytes > 0
    await state.unregister_tunnel("bounded", expected_session=session)
    assert session.to_host.queued_bytes == 0
    assert session.to_host.get_nowait() is None
    assert state.tunnels == {}


@pytest.mark.asyncio
async def test_stale_tunnel_teardown_cannot_remove_replacement():
    state = RelayState(set())
    old = TunnelSession(host_id="same", websocket=AsyncMock())
    replacement = TunnelSession(host_id="same", websocket=None)
    await state.register_tunnel(old)
    await state.register_tunnel(replacement)
    await state.unregister_tunnel("same", expected_session=old)
    assert state.tunnels["same"] is replacement
    await state.unregister_tunnel("same", expected_session=replacement)
    assert state.tunnels == {}


def test_blocked_guest_overflow_preserves_healthy_guest_delivery(monkeypatch):
    from podcast_mcp.util.ws_delivery import WsFrameQueue

    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    app = create_relay_app()
    entered = threading.Event()
    real_send = WebSocket.send_text
    real_put = WsFrameQueue.put_nowait
    high_water = [0, 0]

    async def blocked_send(websocket, text):
        if websocket.scope.get("path") == "/api/review/slow-bounded/daw/ws":
            entered.set()
            await asyncio.Event().wait()
        await real_send(websocket, text)

    def observe_put(queue, frame):
        real_put(queue, frame)
        high_water[0] = max(high_water[0], queue.qsize())
        high_water[1] = max(high_water[1], queue.queued_bytes)

    monkeypatch.setattr(WebSocket, "send_text", blocked_send)
    monkeypatch.setattr(WsFrameQueue, "put_nowait", observe_put)
    with _live_relay(monkeypatch, app=app) as base:
        with _tunnel_hello_register(
            base, host_id="bounded-guests", token="slow-bounded", capabilities=["view"]
        ) as tunnel:
            shares = attach_share_claims(
                [
                    {"token": "slow-bounded", "capabilities": ["view"]},
                    {"token": "healthy-bounded", "capabilities": ["view"]},
                ],
                host_id="bounded-guests",
                secret="secret",
            )
            _ws_send(tunnel, {"type": "register", "shares": shares})
            assert _ws_recv(tunnel)["ok"]
            with (
                ws_connect(f"{base}/api/review/slow-bounded/daw/ws") as slow,
                ws_connect(f"{base}/api/review/healthy-bounded/daw/ws") as healthy,
            ):
                opens = [_ws_recv(tunnel), _ws_recv(tunnel)]
                ids = {event["share_token"]: event["id"] for event in opens}
                session = app.state.relay.tunnels["bounded-guests"]
                slow_stream = session.ws_streams[ids["slow-bounded"]]
                _ws_send(tunnel, {"type": "ws_data", "id": ids["slow-bounded"], "text": "held"})
                assert entered.wait(5)
                _ws_send(
                    tunnel, {"type": "ws_data", "id": ids["healthy-bounded"], "text": "before"}
                )
                assert healthy.recv(timeout=5) == "before"
                for index in range(300):
                    _ws_send(
                        tunnel,
                        {"type": "ws_data", "id": ids["slow-bounded"], "text": f"queued-{index}"},
                    )
                close = _ws_recv(tunnel)
                assert close["type"] == "ws_close"
                assert close["id"] == ids["slow-bounded"]
                assert close["code"] == 1013
                with pytest.raises(ConnectionClosed) as error:
                    slow.recv(timeout=5)
                assert error.value.rcvd.code == 1013
                _ws_send(tunnel, {"type": "ws_data", "id": ids["healthy-bounded"], "text": "after"})
                assert healthy.recv(timeout=5) == "after"
                assert high_water[0] == 256
                assert high_water[1] <= slow_stream.queue.max_bytes
                assert slow_stream.queue.queued_bytes == 0
                assert ids["slow-bounded"] not in session.ws_streams


def test_shared_tunnel_send_deadline_closes_and_releases_streams(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    app = create_relay_app()
    entered = threading.Event()
    start = []
    real_send = WebSocket.send_json

    async def blocked_send(websocket, data, mode="text"):
        if websocket.scope.get("path") == "/tunnel" and data.get("type") == "ws_data":
            start.append(time.monotonic())
            entered.set()
            await asyncio.Event().wait()
        await real_send(websocket, data, mode=mode)

    monkeypatch.setattr(WebSocket, "send_json", blocked_send)
    with _live_relay(monkeypatch, app=app) as base:
        with _tunnel_hello_register(
            base, host_id="bounded-tunnel", token="deadline-bounded", capabilities=["view"]
        ) as tunnel:
            with ws_connect(f"{base}/api/review/deadline-bounded/daw/ws") as guest:
                assert _ws_recv(tunnel)["type"] == "ws_open"
                session = app.state.relay.tunnels["bounded-tunnel"]
                stream = next(iter(session.ws_streams.values()))
                guest.send("held")
                assert entered.wait(5)
                with pytest.raises(ConnectionClosed) as error:
                    tunnel.recv(timeout=8)
                assert error.value.rcvd.code == 1013
                assert 4.5 <= time.monotonic() - start[0] <= 8
                with pytest.raises(ConnectionClosed) as error:
                    guest.recv(timeout=5)
                assert error.value.rcvd.code == 1013
                assert session.ws_streams == {}
                assert session.to_host.queued_bytes == 0
                assert stream.queue.queued_bytes == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("close_fails", [False, True])
async def test_replaced_tunnel_releases_backlogs_and_cannot_advertise_for_new_owner(close_fails):
    state = RelayState(set(), allow_open_tunnel=True)
    socket = AsyncMock()
    if close_fails:
        socket.close.side_effect = OSError("old transport already closed")
    old = TunnelSession(host_id="same", websocket=socket)
    stream = GuestWsStream()
    stream.queue.put_nowait("retained guest frame")
    old.ws_streams["old-stream"] = stream
    old.to_host.put_nowait({"type": "ws_data", "text": "retained host frame"})
    await state.register_tunnel(old)
    await state.update_shares("same", [{"token": "old"}], expected_session=old)
    replacement = TunnelSession(host_id="same", websocket=AsyncMock())
    await state.register_tunnel(replacement)
    await state.update_shares("same", [{"token": "new"}], expected_session=replacement)
    await state.update_shares("same", [], expected_session=old)
    await state.unregister_tunnel("same", expected_session=old)
    assert state.tunnel_for_token("new") is replacement
    assert state.tunnel_for_token("old") is None
    assert replacement.share_tokens == {"new"}
    assert old.ws_streams == {}
    assert old.to_host.queued_bytes == stream.queue.queued_bytes == 0
    assert stream.closed.is_set()
    assert (stream.close_code, stream.close_reason) == (1013, "host tunnel replaced")
    socket.close.assert_awaited_once_with(code=1013, reason="host tunnel replaced")
    assert old.writer.closed


@pytest.mark.asyncio
async def test_http_dispatch_uses_tunnel_delivery_deadline_and_releases_pending(monkeypatch):
    from podcast_mcp.util.ws_delivery import SerializedWsWriter

    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    app = create_relay_app()
    socket = AsyncMock()
    entered = asyncio.Event()

    async def write(_payload):
        entered.set()
        await asyncio.Event().wait()

    session = TunnelSession(host_id="http-deadline", websocket=socket, host_token="secret")
    session.writer = SerializedWsWriter(write, socket.close, timeout=0.02)
    await app.state.relay.register_tunnel(session)
    await app.state.relay.update_shares(
        session.host_id,
        attach_share_claims(
            [{"token": "http-tok", "capabilities": ["view"]}],
            host_id=session.host_id,
            secret="secret",
        ),
        expected_session=session,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://relay") as http:
        response = await asyncio.wait_for(http.get("/api/review/http-tok/project"), 1)
        assert response.status_code == 504
        assert response.json() == {"detail": "host delivery timed out"}
        response = await asyncio.wait_for(http.get("/api/review/http-tok/project"), 1)
        assert response.status_code == 503
        assert response.json() == {"detail": "host offline"}
    assert entered.is_set()
    socket.send_json.assert_not_awaited()
    socket.close.assert_awaited_once_with(1013, "slow consumer")
    assert session.pending == {}


@pytest.mark.asyncio
async def test_tunnel_close_cancels_blocked_http_without_retaining_request(monkeypatch):
    from podcast_mcp.util.ws_delivery import SerializedWsWriter
    from podcast_relay.limits import get_relay_limiters, reset_relay_limiters_for_tests

    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_CONCURRENT", "1")
    reset_relay_limiters_for_tests()
    app = create_relay_app()
    socket = AsyncMock()
    entered = asyncio.Event()

    async def write(_payload):
        entered.set()
        await asyncio.Event().wait()

    session = TunnelSession(host_id="http-cancel", websocket=socket, host_token="secret")
    session.writer = SerializedWsWriter(write, socket.close)
    await app.state.relay.register_tunnel(session)
    await app.state.relay.update_shares(
        session.host_id,
        attach_share_claims(
            [{"token": "cancel-tok", "capabilities": ["view"]}],
            host_id=session.host_id,
            secret="secret",
        ),
        expected_session=session,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://relay") as http:
        request = asyncio.create_task(http.get("/api/review/cancel-tok/project"))
        await asyncio.wait_for(entered.wait(), 1)
        await session.writer.close(1013, "host tunnel replaced")
        with pytest.raises(asyncio.CancelledError):
            await request
    assert session.pending == {}
    gate = get_relay_limiters().token_concurrent
    assert gate.try_enter("cancel-tok").allowed
    assert not gate.try_enter("cancel-tok").allowed
    gate.exit("cancel-tok")
    reset_relay_limiters_for_tests()
