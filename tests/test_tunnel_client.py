"""Unit tests for TunnelClient - path mapping, config loading, share building."""

from __future__ import annotations

import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from podcast_mcp.services.tunnel import (
    RelayConfig,
    TunnelClient,
    _map_local_path,
    _rewrite_share_html,
)
from podcast_mcp.util.proxy_paths import UnsafeProxyPath

# ---------------------------------------------------------------------------
# _map_local_path
# ---------------------------------------------------------------------------


def test_map_review_root():
    assert _map_local_path("r/", "abc") == "/r/abc"


def test_map_review_assets_to_gui_mount():
    assert _map_local_path("r/assets/foo.js", "abc") == "/assets/foo.js"


def test_map_review_favicon():
    assert _map_local_path("r/favicon.svg", "abc") == "/favicon.svg"


def test_map_review_subpath():
    assert _map_local_path("r/comments", "abc") == "/r/abc/comments"


def test_rewrite_share_html_prefixes_assets():
    html = b'<head></head><script src="/assets/app.js"></script><link href="/favicon.svg">'
    out = _rewrite_share_html(html, "tok").decode()
    assert 'src="/r/tok/assets/app.js"' in out
    assert 'href="/r/tok/favicon.svg"' in out
    assert '<base href="/r/tok/" />' in out


def test_rewrite_share_html_prefixes_relative_vite_assets():
    html = b'<head><script type="module" src="./assets/index.js"></script></head>'
    out = _rewrite_share_html(html, "tok").decode()
    assert '<base href="/r/tok/" />' in out
    assert 'src="/r/tok/assets/index.js"' in out


def test_map_api_review_daw_project():
    assert _map_local_path("api/review/daw/project", "tok") == "/api/review/tok/daw/project"


def test_map_api_review_daw_peaks():
    assert _map_local_path("api/review/daw/peaks/host", "tok") == "/api/review/tok/daw/peaks/host"


def test_map_api_review_daw_audio():
    assert _map_local_path("api/review/daw/audio", "tok") == "/api/review/tok/daw/audio"


def test_map_api_review_daw_ws():
    assert _map_local_path("api/review/daw/ws", "tok") == "/api/review/tok/daw/ws"


def test_map_api_review_progress_ws():
    assert _map_local_path("api/review/progress/ws", "tok") == "/api/review/tok/progress/ws"


def test_map_api_review_root():
    assert _map_local_path("api/review/", "tok") == "/api/review/tok"


def test_map_api_review_project():
    assert _map_local_path("api/review/project", "tok") == "/api/review/tok/project"


def test_map_mcp_root():
    assert _map_local_path("mcp/", "tok") == "/mcp/tok"


def test_map_mcp_subpath():
    assert _map_local_path("mcp/tools/list", "tok") == "/mcp/tok/tools/list"


def test_map_share_mcp_alias_rewrites_to_api_mcp():
    assert _map_local_path("r/mcp", "tok") == "/mcp/tok/mcp"
    assert _map_local_path("r/mcp/", "tok") == "/mcp/tok/mcp"


def test_map_unknown_prefix_rejected():
    with pytest.raises(UnsafeProxyPath):
        _map_local_path("other/foo", "tok")


@pytest.mark.parametrize(
    ("suffix", "match"),
    [
        # No relay prefix maps to /api/export/*.
        ("api/export/bounce", "unknown proxy prefix"),
        ("api/export/deliverables", "unknown proxy prefix"),
        # Traversal is rejected by the generic guard before prefix mapping.
        ("api/review/../export/bounce", "unsafe proxy path"),
        ("r/../api/export/deliverables", "unsafe proxy path"),
        ("api/review/%2e%2e/%2e%2e/api/export/bounce", "unsafe proxy path"),
    ],
)
def test_map_export_routes_rejected(suffix: str, match: str) -> None:
    """#219: the tunnel never forwards a guest request to host export jobs.

    Plain export suffixes fail prefix mapping and traversal forms fail
    ``assert_safe_proxy_path``. The post-mapping allowlist
    (``assert_allowed_local_gui_path``) is defense in depth and is covered in
    ``tests/test_proxy_paths.py``.
    """
    with pytest.raises(UnsafeProxyPath, match=match):
        _map_local_path(suffix, "tok")


def test_map_local_path_rec_prefixes():
    assert _map_local_path("rec/", "abc") == "/rec/abc"
    assert _map_local_path("rec/assets/foo.js", "abc") == "/assets/foo.js"
    assert _map_local_path("api/rec/bootstrap", "tok") == "/api/rec/tok/bootstrap"
    assert _map_local_path("api/rec/ws", "tok") == "/api/rec/tok/ws"


def test_rewrite_share_html_rec_prefix():
    html = b'<head></head><script src="/assets/app.js"></script>'
    out = _rewrite_share_html(html, "tok", prefix="rec").decode()
    assert 'src="/rec/tok/assets/app.js"' in out
    assert '<base href="/rec/tok/" />' in out


def test_map_rejects_asset_traversal():
    with pytest.raises(UnsafeProxyPath):
        _map_local_path("r/assets/../../api/pipeline/run", "tok")


def test_map_rejects_encoded_dotdot():
    with pytest.raises(UnsafeProxyPath):
        _map_local_path("r/assets/%2e%2e/api/project", "tok")


def test_map_rejects_backslash():
    with pytest.raises(UnsafeProxyPath):
        _map_local_path("r/assets\\..\\api/project", "tok")


def test_map_rejects_review_dotdot_rest():
    with pytest.raises(UnsafeProxyPath):
        _map_local_path("api/review/../../../api/pipeline/run", "tok")


# ---------------------------------------------------------------------------
# TunnelClient._build_shares
# ---------------------------------------------------------------------------


def test_build_shares_no_project():
    cfg = RelayConfig()
    client = TunnelClient(cfg, project_path=None)
    assert client._build_shares() == []


def test_build_shares_with_project(minimal_project, published_share):
    from podcast_mcp.edits.share_capabilities import DEFAULT_CAPABILITIES

    published_share(capabilities=[], label="test")

    cfg = RelayConfig()
    tc = TunnelClient(cfg, project_path=minimal_project)
    shares = tc._build_shares()
    assert len(shares) == 1
    assert "token" in shares[0]
    assert shares[0]["capabilities"] == list(DEFAULT_CAPABILITIES)
    assert "mcp" not in shares[0]["capabilities"]


def test_build_shares_skips_revoked(minimal_project, published_share):
    from podcast_mcp.edits.review_shares import revoke_share
    from podcast_mcp.edits.share_capabilities import DEFAULT_CAPABILITIES

    ws, _, row = published_share(capabilities=list(DEFAULT_CAPABILITIES), label="test2")
    revoke_share(ws.project, row["token"])

    cfg = RelayConfig()
    tc = TunnelClient(cfg, project_path=minimal_project)
    assert tc._build_shares() == []


# ---------------------------------------------------------------------------
# TunnelClient._proxy_http
# ---------------------------------------------------------------------------


class _StreamResp:
    def __init__(self, status: int, content: bytes, headers: dict[str, str]) -> None:
        self.status_code = status
        self.headers = headers
        self._content = content

    async def aread(self) -> bytes:
        return self._content

    async def aiter_bytes(self, chunk_size: int = 65536):
        data = self._content
        for i in range(0, len(data), chunk_size):
            yield data[i : i + chunk_size]

    async def aiter_raw(self, chunk_size: int = 65536):
        data = self._content
        for i in range(0, len(data), chunk_size):
            yield data[i : i + chunk_size]

    async def __aenter__(self) -> _StreamResp:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None


def _stream_client(status: int, content: bytes, headers: dict[str, str]):
    """Build an httpx-like client whose ``.stream`` yields ``content``."""
    resp = _StreamResp(status, content, headers)
    mock_client = AsyncMock()
    mock_client.stream = MagicMock(return_value=resp)
    return mock_client


@pytest.mark.asyncio
async def test_proxy_http_success():
    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    await tc._proxy_http(
        _stream_client(200, b'{"ok":true}', {"content-type": "application/json"}),
        {
            "id": "req1",
            "method": "GET",
            "path": "api/review/project",
            "query": "",
            "headers": {},
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    assert sent[0]["type"] == "http_response"
    assert sent[0]["id"] == "req1"
    assert sent[0]["status"] == 200
    assert sent[-1]["eof"] is True


@pytest.mark.asyncio
async def test_proxy_http_strips_gzip_content_length_mismatch():
    """Decoded body must not keep compressed Content-Length (breaks HTTP/2)."""
    import gzip

    plain = b'{"ok":true}'
    raw = gzip.compress(plain)
    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    # Mock returns already-decoded body the way httpx aiter_bytes would after
    # reading a gzip response (headers still advertise compressed length).
    await tc._proxy_http(
        _stream_client(
            200,
            plain,
            {
                "content-type": "application/json",
                "content-encoding": "gzip",
                "content-length": str(len(raw)),
            },
        ),
        {
            "id": "gz1",
            "method": "GET",
            "path": "api/review/project",
            "query": "",
            "headers": {"accept-encoding": "gzip"},
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    assert sent[0]["status"] == 200
    hdrs = {k.lower(): v for k, v in sent[0]["headers"].items()}
    assert "content-encoding" not in hdrs
    assert "content-length" not in hdrs
    body = b"".join(base64.b64decode(p["body_b64"]) for p in sent if p.get("body_b64"))
    assert body == plain


@pytest.mark.asyncio
async def test_proxy_http_unsafe_path():
    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    await tc._proxy_http(
        AsyncMock(),
        {
            "id": "bad1",
            "method": "GET",
            "path": "other/unsafe",
            "query": "",
            "headers": {},
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    assert len(sent) == 1
    assert sent[0]["type"] == "http_response"
    assert sent[0]["status"] == 400
    assert sent[0]["eof"] is True
    assert b"unsafe proxy path" in base64.b64decode(sent[0]["body_b64"])


@pytest.mark.asyncio
async def test_proxy_http_does_not_follow_redirects():
    """object storage bypass needs 302 Location to reach the browser unchanged."""
    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    client = _stream_client(
        302,
        b"",
        {
            "location": "https://media.example.test/example-bucket/x.mp3",
            "content-length": "0",
        },
    )
    await tc._proxy_http(
        client,
        {
            "id": "redir",
            "method": "GET",
            "path": "api/review/tok/audio",
            "query": "",
            "headers": {},
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    client.stream.assert_called()
    kwargs = client.stream.call_args.kwargs
    assert kwargs.get("follow_redirects") is False
    assert sent[0]["status"] == 302
    assert sent[0]["headers"]["location"] == "https://media.example.test/example-bucket/x.mp3"


@pytest.mark.asyncio
async def test_proxy_http_event_stream_uses_unbuffered_aiter_bytes():
    """SSE frames must not wait for the 512 KiB HTTP chunker."""
    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []
    chunk_sizes: list[int | None] = []

    class _SseResp(_StreamResp):
        async def aiter_bytes(self, chunk_size: int = 65536):
            chunk_sizes.append(chunk_size)
            async for piece in super().aiter_bytes(chunk_size):
                yield piece

    sse = (
        b'event: message\ndata: {"method":"notifications/progress"}\n\n'
        b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'
    )
    resp = _SseResp(200, sse, {"content-type": "text/event-stream"})
    mock_client = AsyncMock()
    mock_client.stream = MagicMock(return_value=resp)

    async def _send(payload: dict) -> None:
        sent.append(payload)

    await tc._proxy_http(
        mock_client,
        {
            "id": "sse1",
            "method": "POST",
            "path": "mcp/mcp",
            "query": "",
            "headers": {"accept": "text/event-stream"},
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    from podcast_mcp.services.tunnel import _RESPONSE_CHUNK

    assert chunk_sizes == [65536]
    assert _RESPONSE_CHUNK not in chunk_sizes
    assert sent[0]["status"] == 200
    body = b"".join(base64.b64decode(p["body_b64"]) for p in sent if p.get("body_b64"))
    assert b"notifications/progress" in body


@pytest.mark.asyncio
async def test_proxy_http_error_returns_502():
    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    mock_client = AsyncMock()
    mock_client.stream = MagicMock(side_effect=Exception("connection refused"))

    await tc._proxy_http(
        mock_client,
        {
            "id": "req2",
            "method": "GET",
            "path": "r/",
            "query": "",
            "headers": {},
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    assert sent[0]["status"] == 502
    assert sent[0]["id"] == "req2"


@pytest.mark.asyncio
async def test_proxy_http_rewrites_share_html_assets():
    import base64

    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    await tc._proxy_http(
        _stream_client(
            200,
            b'<script src="/assets/app.js"></script>',
            {"content-type": "text/html; charset=utf-8"},
        ),
        {
            "id": "req5",
            "method": "GET",
            "path": "r/",
            "query": "",
            "headers": {},
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    body = base64.b64decode(sent[0]["body_b64"]).decode()
    assert 'src="/r/tok/assets/app.js"' in body


@pytest.mark.asyncio
async def test_proxy_http_strips_forwarded_headers():
    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    client = _stream_client(200, b"ok", {"content-type": "text/plain"})

    await tc._proxy_http(
        client,
        {
            "id": "req4",
            "method": "GET",
            "path": "r/",
            "query": "",
            "headers": {
                "accept": "text/html",
                "x-forwarded-proto": "https",
                "x-forwarded-host": "sudo.science",
                "forwarded": "proto=https",
                "host": "sudo.science",
            },
            "share_token": "tok",
            "body_b64": "",
        },
        send=_send,
    )
    assert client.stream.call_args[1]["headers"] == {"accept": "text/html"}
    assert sent


@pytest.mark.asyncio
async def test_proxy_http_with_body():
    import base64

    cfg = RelayConfig(local_gui_url="http://gui.test")
    tc = TunnelClient(cfg)
    sent: list[dict] = []

    async def _send(payload: dict) -> None:
        sent.append(payload)

    client = _stream_client(200, b"", {})
    body = base64.b64encode(b'{"body":"data"}').decode("ascii")

    await tc._proxy_http(
        client,
        {
            "id": "req3",
            "method": "POST",
            "path": "api/review/comments",
            "query": "foo=bar",
            "headers": {"content-type": "application/json"},
            "share_token": "tok",
            "body_b64": body,
        },
        send=_send,
    )
    assert sent[0]["status"] == 200
    assert client.stream.call_args[1]["content"] == b'{"body":"data"}'


@pytest.mark.asyncio
async def test_proxy_ws_empty_stream_id():
    client = TunnelClient(RelayConfig())
    sent: list[dict] = []

    async def send(payload: dict) -> None:
        sent.append(payload)

    await client._proxy_ws(
        {"id": "", "path": "api/review/daw/ws", "share_token": "tok"},
        send=send,
        streams={},
    )
    assert sent == []


@pytest.mark.asyncio
async def test_proxy_ws_unsafe_path():
    client = TunnelClient(RelayConfig())
    sent: list[dict] = []

    async def send(payload: dict) -> None:
        sent.append(payload)

    await client._proxy_ws(
        {
            "id": "sid1",
            "path": "other/unsafe",
            "share_token": "tok",
        },
        send=send,
        streams={},
    )
    assert sent[0]["type"] == "ws_close"
    assert sent[0]["code"] == 4400


@pytest.mark.asyncio
async def test_proxy_ws_connect_failure_sends_close():
    client = TunnelClient(RelayConfig(local_gui_url="http://127.0.0.1:1"))
    sent: list[dict] = []

    async def send(payload: dict) -> None:
        sent.append(payload)

    streams: dict = {}
    await client._proxy_ws(
        {
            "id": "sid2",
            "path": "api/review/daw/ws",
            "share_token": "tok",
        },
        send=send,
        streams=streams,
    )
    assert "sid2" not in streams
    assert any(m.get("type") == "ws_close" and m.get("id") == "sid2" for m in sent)


@pytest.mark.asyncio
async def test_proxy_ws_https_base_url_conversion():
    client = TunnelClient(RelayConfig(local_gui_url="https://127.0.0.1:1"))
    sent: list[dict] = []

    async def send(payload: dict) -> None:
        sent.append(payload)

    await client._proxy_ws(
        {
            "id": "sid-https",
            "path": "api/review/daw/ws",
            "share_token": "tok",
        },
        send=send,
        streams={},
    )
    assert any(m.get("type") == "ws_close" for m in sent)


@pytest.mark.asyncio
async def test_proxy_ws_successful_bridge():
    """Cover the happy-path pump loops with a controlled fake local socket."""
    import asyncio

    import websockets

    client = TunnelClient(RelayConfig(local_gui_url="http://127.0.0.1:8765"))
    sent: list[dict] = []

    async def send(payload: dict) -> None:
        sent.append(payload)

    class _FakeLocal:
        def __init__(self) -> None:
            self.received: list[str] = []
            self._hold = asyncio.Event()

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            yield '{"ok":true}'
            yield b'{"bin":true}'
            # Stay open until relay pushes close via queue
            await self._hold.wait()
            return

        async def send(self, text: str) -> None:
            self.received.append(text)
            self._hold.set()

    fake_holder: dict[str, _FakeLocal] = {}

    class _Ctx:
        async def __aenter__(self):
            fake = _FakeLocal()
            fake_holder["ws"] = fake
            return fake

        async def __aexit__(self, *a):
            return False

    with patch.object(websockets, "connect", return_value=_Ctx()):
        streams: dict = {}
        task = asyncio.create_task(
            client._proxy_ws(
                {
                    "id": "sid-ok",
                    "path": "api/review/daw/ws",
                    "share_token": "tok",
                },
                send=send,
                streams=streams,
            )
        )
        for _ in range(100):
            if "sid-ok" in streams and any(m.get("type") == "ws_data" for m in sent):
                break
            await asyncio.sleep(0.01)
        streams["sid-ok"].put_nowait('{"from":"relay"}')
        streams["sid-ok"].put_nowait(None)
        await asyncio.wait_for(task, timeout=3.0)

    texts = [m.get("text") for m in sent if m.get("type") == "ws_data"]
    assert '{"ok":true}' in texts
    assert '{"bin":true}' in texts
    assert fake_holder["ws"].received == ['{"from":"relay"}']
    assert any(m.get("type") == "ws_close" and m.get("id") == "sid-ok" for m in sent)
    assert "sid-ok" not in streams


@pytest.mark.asyncio
async def test_proxy_ws_non_http_base_url():
    client = TunnelClient(RelayConfig(local_gui_url="ws://127.0.0.1:1"))
    sent: list[dict] = []

    async def send(payload: dict) -> None:
        sent.append(payload)

    await client._proxy_ws(
        {
            "id": "sid-ws",
            "path": "api/review/daw/ws",
            "share_token": "tok",
        },
        send=send,
        streams={},
    )
    assert any(m.get("type") == "ws_close" for m in sent)


@pytest.mark.asyncio
async def test_run_once_ws_dispatch_paths():
    """Drive _run_once through ws_open/data/close + ping/error/unknown."""
    import asyncio
    import json as _json

    import websockets

    client = TunnelClient(RelayConfig(host_token="t", relay_url="ws://relay"))
    messages = [
        {"type": "hello", "ok": True, "host_id": "h"},
        {"type": "register", "ok": True, "share_count": 0},
        {
            "type": "ws_open",
            "id": "s1",
            "path": "api/review/daw/ws",
            "share_token": "tok",
        },
        {"type": "ws_data", "id": "s1", "text": "hello-guest"},
        {"type": "ws_close", "id": "s1"},
        {
            "type": "ws_open",
            "id": "s2",
            "path": "other/bad",
            "share_token": "tok",
        },
        {"type": "ws_data", "id": "missing", "text": "x"},
        {"type": "ws_close", "id": "missing"},
        {"type": "ping"},
        {"type": "error", "detail": "nope"},
        {"type": "weird"},
    ]
    outbox: list[str] = []
    idx = {"i": 0}

    class _FakeLocal:
        def __init__(self) -> None:
            self._done = asyncio.Event()

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            yield '{"snap":1}'
            await self._done.wait()
            return

        async def send(self, text: str) -> None:
            if text == "hello-guest":
                self._done.set()

    class _LocalCtx:
        async def __aenter__(self):
            return _FakeLocal()

        async def __aexit__(self, *a):
            return False

    class _RelayWs:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def send(self, data: str) -> None:
            outbox.append(data)

        async def recv(self) -> str:
            i = idx["i"]
            if i >= len(messages):
                raise RuntimeError("test-end")
            idx["i"] = i + 1
            # Pace after ws_open so _proxy_ws can register the stream
            if messages[i].get("type") in {"ws_data", "ws_close"} and messages[i].get("id") == "s1":
                await asyncio.sleep(0.05)
            return _json.dumps(messages[i])

    def _connect(url, **kwargs):
        if "relay" in str(url):
            return _RelayWs()
        return _LocalCtx()

    with patch.object(websockets, "connect", side_effect=_connect):
        with pytest.raises(RuntimeError, match="test-end"):
            await asyncio.wait_for(client._run_once(), timeout=5.0)
        await asyncio.sleep(0.1)

    joined = "\n".join(outbox)
    assert "hello" in joined
    assert "register" in joined
    assert "pong" in joined
    assert "ws_close" in joined
    assert "snap" in joined or "ws_data" in joined
