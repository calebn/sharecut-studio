"""Coverage for TunnelClient.run and run_tunnel_sync (mocked websockets)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from podcast_mcp.services.tunnel import (
    RelayConfig,
    TunnelClient,
    run_tunnel_sync,
)


class _FakeWs:
    def __init__(self, incoming: list[dict]) -> None:
        self._incoming = list(incoming)
        self.sent: list[dict] = []

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def recv(self) -> str:
        if not self._incoming:
            raise asyncio.CancelledError()
        return json.dumps(self._incoming.pop(0))

    async def __aenter__(self) -> _FakeWs:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None


@pytest.mark.asyncio
async def test_run_hello_register_http_ping_error():
    cfg = RelayConfig(host_token="tok", host_id="hid")
    client = TunnelClient(cfg, project_path=None)

    fake = _FakeWs(
        [
            {"type": "hello", "ok": True, "host_id": "hid"},
            {"type": "register", "ok": True, "share_count": 0},
            {
                "type": "http",
                "id": "r1",
                "method": "GET",
                "path": "r/",
                "query": "",
                "headers": {},
                "share_token": "s",
                "body_b64": "",
            },
            {"type": "ping"},
            {"type": "error", "detail": "boom"},
            {"type": "unknown"},
        ]
    )

    class _Resp:
        status_code = 200
        headers: ClassVar[dict[str, str]] = {"content-type": "text/plain"}

        async def aread(self) -> bytes:
            return b"ok"

        async def aiter_bytes(self, chunk_size: int = 65536):
            yield b"ok"

        async def aiter_raw(self, chunk_size: int = 65536):
            yield b"ok"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    mock_http = AsyncMock()
    mock_http.stream = MagicMock(return_value=_Resp())
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=None)

    with (
        patch("websockets.connect", return_value=fake),
        patch("httpx.AsyncClient", return_value=mock_http),
        pytest.raises(asyncio.CancelledError),
    ):
        await client.run(max_attempts=1)

    # Proxy runs as a task; give it a turn to finish after recv empties.
    await asyncio.sleep(0.05)
    types = [m["type"] for m in fake.sent]
    assert types[0] == "hello"
    assert types[1] == "register"
    assert "http_response" in types
    assert "pong" in types


@pytest.mark.asyncio
async def test_run_rejects_bad_hello():
    cfg = RelayConfig(host_token="tok")
    client = TunnelClient(cfg)
    fake = _FakeWs([{"type": "hello", "ok": False, "detail": "nope"}])
    with patch("websockets.connect", return_value=fake):
        with pytest.raises(RuntimeError, match="rejected"):
            await client.run(max_attempts=1)


@pytest.mark.asyncio
async def test_run_reconnects_after_disconnect():
    cfg = RelayConfig(host_token="tok", host_id="hid")
    client = TunnelClient(cfg, project_path=None)
    connects: list[_FakeWs] = []

    def _connect(*_a, **_k):
        n = len(connects)
        if n == 0:
            fake = _FakeWs(
                [
                    {"type": "hello", "ok": True, "host_id": "hid"},
                    {"type": "register", "ok": True, "share_count": 0},
                ]
            )

            async def _recv_fail() -> str:
                if fake._incoming:
                    return json.dumps(fake._incoming.pop(0))
                raise ConnectionError("relay dropped")

            fake.recv = _recv_fail  # type: ignore[method-assign]
            connects.append(fake)
            return fake
        fake = _FakeWs(
            [
                {"type": "hello", "ok": True, "host_id": "hid"},
                {"type": "register", "ok": True, "share_count": 0},
            ]
        )
        connects.append(fake)
        return fake

    with (
        patch("websockets.connect", side_effect=_connect),
        patch("httpx.AsyncClient") as mock_http_cls,
        patch("asyncio.sleep", new_callable=AsyncMock),
    ):
        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=None)
        mock_http_cls.return_value = mock_http
        with pytest.raises(asyncio.CancelledError):
            await client.run(max_attempts=2, initial_delay_sec=0.01)

    assert len(connects) == 2
    assert any(m["type"] == "hello" for m in connects[0].sent)
    assert any(m["type"] == "register" for m in connects[0].sent)
    assert any(m["type"] == "hello" for m in connects[1].sent)
    assert any(m["type"] == "register" for m in connects[1].sent)


@pytest.mark.asyncio
async def test_run_reconnects_after_clean_session_end():
    cfg = RelayConfig(host_token="tok", host_id="hid")
    client = TunnelClient(cfg)
    calls = {"n": 0}

    async def _once(_self: TunnelClient) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            return
        raise asyncio.CancelledError()

    with (
        patch.object(TunnelClient, "_run_once", _once),
        patch("asyncio.sleep", new_callable=AsyncMock),
        pytest.raises(asyncio.CancelledError),
    ):
        await client.run(max_attempts=2, initial_delay_sec=0.01)
    assert calls["n"] == 2


def test_notify_after_mutation_decorator(tmp_path: Path):
    from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation

    calls: list[str] = []

    @notify_after_mutation
    def tool(project_path: str) -> str:
        calls.append(project_path)
        return "ok"

    with patch("podcast_mcp.mcp.tools.agent_notify.agent_mutated") as mutated:
        assert tool(str(tmp_path)) == "ok"
        mutated.assert_called_once_with(str(tmp_path))
    assert calls == [str(tmp_path)]


def test_notify_document_changed_oserror(tmp_path: Path):
    from podcast_mcp.services.document_sync.service import (
        notify_comments_changed,
        notify_document_changed,
    )

    missing = tmp_path / "nope.project.json"
    notify_document_changed(missing)  # best-effort; must not raise
    notify_comments_changed(missing)


def test_run_tunnel_sync_wires_config(tmp_path: Path):
    cfg_path = tmp_path / "relay.yaml"
    cfg_path.write_text("relay_url: ws://x/tunnel\nhost_token: t\n", encoding="utf-8")

    async def fake_run(self):
        return None

    with patch.object(TunnelClient, "run", fake_run):
        run_tunnel_sync(
            project_path=None,
            relay_url="wss://override.example/tunnel",
            host_token="ht",
            local_gui_url="http://127.0.0.1:9999",
            config_path=cfg_path,
        )


def test_build_shares_load_error(tmp_path: Path):
    bad = tmp_path / "missing.json"
    cfg = RelayConfig()
    client = TunnelClient(cfg, project_path=bad)
    assert client._build_shares() == []
