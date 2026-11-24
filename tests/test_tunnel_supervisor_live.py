"""A running Studio brings the host tunnel up on its own against a live relay."""

from __future__ import annotations

import asyncio
import contextlib
import json
import signal
import socket
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from tests.polling import wait_for
from tests.record_links import make_project, mint_record_link
from tests.relay_live import live_relay

from podcast_mcp.config.runtime import RelayConfig, load_relay_config, relay_host_id_path
from podcast_mcp.gui.bind import build_gui_server, exclusive_listen_socket
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project
from podcast_mcp.services.collaboration import tunnel_supervisor
from podcast_mcp.services.collaboration.review_shares import usable_share_tokens
from podcast_mcp.services.collaboration.tunnel import TunnelClient
from podcast_mcp.services.collaboration.tunnel_status import (
    StatusFileListener,
    read_tunnel_status,
    studio_status_path,
    tunnel_status_path,
)
from podcast_mcp.services.collaboration.tunnel_supervisor import Idle, IdleReason
from podcast_relay.app import create_relay_app

HOST_TOKEN = "studio-host-token"


@dataclass
class Relay:
    app: FastAPI
    http_base: str


@dataclass
class Studio:
    app: FastAPI
    url: str
    server: object
    thread: threading.Thread


@pytest.fixture(autouse=True)
def _fast_ticks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tunnel_supervisor, "POLL_SEC", 0.05)


@pytest.fixture
def project(tmp_workspace: Path) -> Path:
    return make_project(tmp_workspace, "studio_tunnel")


@pytest.fixture
def relay(monkeypatch: pytest.MonkeyPatch) -> Iterator[Relay]:
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", HOST_TOKEN)
    app = create_relay_app()
    with live_relay(monkeypatch, host_token=HOST_TOKEN, app=app) as ws_base:
        http_base = ws_base.replace("ws://", "http://")
        monkeypatch.setenv("PODCAST_RELAY_URL", f"{ws_base}/tunnel")
        monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", HOST_TOKEN)
        monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", http_base)
        yield Relay(app, http_base)


@contextlib.contextmanager
def _open_studio(project: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Studio]:
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")
    app = create_app(served_project=project)
    sock: socket.socket = exclusive_listen_socket("127.0.0.1", 0)
    server = build_gui_server(app, sock, log_level="warning")
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    try:
        assert wait_for(lambda: server.started), "GUI uvicorn failed to start"
        yield Studio(app, f"http://127.0.0.1:{sock.getsockname()[1]}", server, thread)
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()


@pytest.fixture
def open_studio(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> Callable[[], contextlib.AbstractContextManager[Studio]]:
    return lambda: _open_studio(project, monkeypatch)


def _state(studio: Studio) -> str:
    return str(httpx.get(f"{studio.url}/api/tunnel/status", timeout=5).json()["state"])


def _plan(studio: Studio) -> object:
    return studio.app.state.tunnel.plan


def _session(relay: Relay, token: str) -> object:
    return relay.app.state.relay.tunnel_for_token(token)


def test_open_studio_with_live_share_registers_with_relay(relay, project, open_studio) -> None:
    token = mint_record_link(project)

    with open_studio() as studio:
        assert wait_for(lambda: _session(relay, token)) is not None
        assert wait_for(lambda: _state(studio) == "online")


def test_share_minted_after_connect_routes_without_reconnect(relay, project, open_studio) -> None:
    first = mint_record_link(project)

    with open_studio() as studio:
        session = wait_for(lambda: _session(relay, first))
        assert session is not None
        episode = load_project(project)
        before = usable_share_tokens(episode)

        res = httpx.post(f"{studio.url}/api/shares/record", json={"path": str(project)}, timeout=10)
        assert res.status_code == 200, res.text
        minted = usable_share_tokens(episode) - before
        assert minted

        assert wait_for(lambda: all(_session(relay, t) is session for t in minted))


def test_no_tunnel_without_relay_config(relay, project, open_studio, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_RELAY_URL")
    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKEN")
    token = mint_record_link(project)

    with open_studio() as studio:
        assert wait_for(lambda: _plan(studio) == Idle(IdleReason.NOT_SET_UP))
        assert _session(relay, token) is None
        assert _state(studio) == "not_set_up"
        assert not relay_host_id_path().exists()


def test_no_tunnel_without_live_shares_then_starts_on_mint(relay, project, open_studio) -> None:
    with open_studio() as studio:
        assert wait_for(lambda: _plan(studio) == Idle(IdleReason.NO_LIVE_LINKS))
        assert _state(studio) == "off"
        assert relay.app.state.relay.tunnels == {}

        token = mint_record_link(project)

        assert wait_for(lambda: _session(relay, token)) is not None


class StandInCli:
    """A real TunnelClient with the CLI's status file, running on its own thread until stopped."""

    def __init__(self, cfg: RelayConfig, project: Path) -> None:
        self._cfg = cfg
        self._project = project
        self._ready = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._run: asyncio.Future[None] | None = None
        self._thread = threading.Thread(target=asyncio.run, args=(self._main(),), daemon=True)
        self._thread.start()
        assert self._ready.wait(5)

    async def _main(self) -> None:
        client = TunnelClient(
            self._cfg,
            self._project,
            listeners=[StatusFileListener(tunnel_status_path(self._cfg))],
        )
        self._loop = asyncio.get_running_loop()
        self._run = asyncio.ensure_future(client.run())
        self._ready.set()
        with contextlib.suppress(asyncio.CancelledError):
            await self._run

    def stop(self) -> None:
        if self._thread.is_alive() and self._loop is not None and self._run is not None:
            self._loop.call_soon_threadsafe(self._run.cancel)
        self._thread.join(timeout=10)


def test_studio_yields_to_live_cli_tunnel(relay, project, open_studio) -> None:
    token = mint_record_link(project)
    cfg = load_relay_config()
    cli = StandInCli(cfg, project)
    try:
        cli_session = wait_for(lambda: _session(relay, token))
        assert cli_session is not None
        assert wait_for(lambda: _cli_state() == "online")

        with open_studio() as studio:
            assert wait_for(lambda: _plan(studio) == Idle(IdleReason.ELSEWHERE))
            assert _session(relay, token) is cli_session
            assert not studio_status_path(cfg).exists()

            cli.stop()

            session = wait_for(lambda: _session(relay, token) not in (None, cli_session))
            assert session
    finally:
        cli.stop()


def _cli_state() -> str:
    return str(read_tunnel_status(relay_configured=True)["state"])


def test_quit_with_open_guest_stream_completes(relay, project, open_studio) -> None:
    token = mint_record_link(project)
    cfg = load_relay_config()

    with open_studio() as studio:

        async def hold() -> StreamingResponse:
            async def stream() -> AsyncIterator[bytes]:
                yield b"data: open\n\n"
                await asyncio.Event().wait()

            return StreamingResponse(stream(), media_type="text/event-stream")

        studio.app.add_api_route("/api/rec/{token}/hold", hold, methods=["GET"])
        assert wait_for(lambda: _session(relay, token)) is not None
        opened = threading.Event()

        def guest() -> None:
            with (
                httpx.Client(timeout=30) as client,
                client.stream("GET", f"{relay.http_base}/api/rec/{token}/hold") as res,
            ):
                for _ in res.iter_bytes():
                    opened.set()

        guest_thread = threading.Thread(target=guest, daemon=True)
        guest_thread.start()
        assert opened.wait(10), "guest stream never opened through the relay"

        studio.server.handle_exit(signal.SIGTERM, None)  # type: ignore[attr-defined]
        studio.thread.join(timeout=10)

        assert not studio.thread.is_alive()
    assert _file_phase(studio_status_path(cfg)) == "stopped"


def _file_phase(path: Path) -> str:
    return str(json.loads(path.read_text(encoding="utf-8"))["phase"])


def test_studio_with_a_named_service_and_no_key_signs_in_and_serves(
    relay, project, open_studio, monkeypatch, tmp_path
) -> None:
    from tests.relay_enroll import enable_enrollment

    enable_enrollment(monkeypatch, tmp_path)
    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKEN")
    enrolling = create_relay_app()
    token = mint_record_link(project)
    with live_relay(monkeypatch, host_token=HOST_TOKEN, app=enrolling) as ws_base:
        monkeypatch.setenv("PODCAST_RELAY_URL", f"{ws_base}/tunnel")
        monkeypatch.setenv("PODCAST_RELAY_PUBLIC_BASE_URL", ws_base.replace("ws://", "http://"))

        with open_studio() as studio:
            session = wait_for(lambda: enrolling.state.relay.tunnel_for_token(token))
            assert session is not None
            assert wait_for(lambda: _state(studio) == "online")
            assert session.host_token == ""
            assert session.install_id == "install-1"
            assert session.install_id != load_relay_config().host_id
