"""A running Studio brings the host tunnel up on its own against a live relay."""

from __future__ import annotations

import contextlib
import socket
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from tests.relay_live import live_relay

from podcast_mcp.gui.bind import build_gui_server, exclusive_listen_socket
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.services.collaboration.review_shares import create_share
from podcast_mcp.services.collaboration.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SHARE_KIND_RECORD,
)
from podcast_relay.app import create_relay_app

HOST_TOKEN = "studio-host-token"


@dataclass
class Rig:
    relay_app: FastAPI
    gui_app: FastAPI
    gui_url: str


def wait_for(check: Callable[[], Any], *, timeout: float = 10.0) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    return check()


@contextlib.contextmanager
def _serve_gui(app: FastAPI) -> Iterator[str]:
    sock: socket.socket = exclusive_listen_socket("127.0.0.1", 0)
    server = build_gui_server(app, sock, log_level="warning", graceful_shutdown_sec=2)
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    try:
        assert wait_for(lambda: server.started), "GUI uvicorn failed to start"
        yield f"http://127.0.0.1:{sock.getsockname()[1]}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()


@pytest.fixture
def studio_project(tmp_workspace: Path) -> Path:
    project = EpisodeProject.create("studio_tunnel", str(tmp_workspace))
    project.ensure_dirs()
    return save_project(project)


@pytest.fixture
def rig(
    monkeypatch: pytest.MonkeyPatch, studio_project: Path
) -> Callable[[], contextlib.AbstractContextManager[Rig]]:
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", HOST_TOKEN)

    @contextlib.contextmanager
    def open_rig() -> Iterator[Rig]:
        relay_app = create_relay_app()
        with live_relay(monkeypatch, host_token=HOST_TOKEN, app=relay_app) as relay_base:
            monkeypatch.setenv("PODCAST_RELAY_URL", f"{relay_base}/tunnel")
            monkeypatch.setenv("PODCAST_RELAY_HOST_TOKEN", HOST_TOKEN)
            monkeypatch.setenv(
                "PODCAST_RELAY_PUBLIC_BASE_URL", relay_base.replace("ws://", "http://")
            )
            gui_app = create_app(served_project=studio_project)
            with _serve_gui(gui_app) as gui_url:
                yield Rig(relay_app=relay_app, gui_app=gui_app, gui_url=gui_url)

    return open_rig


def _mint_record_link(project_path: Path) -> str:
    row = create_share(
        load_project(project_path),
        review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
        kind=SHARE_KIND_RECORD,
        role="guest",
        session_id="session-1",
    )
    return str(row["token"])


def _tunnel_state(gui_url: str) -> str:
    return str(httpx.get(f"{gui_url}/api/tunnel/status", timeout=5).json()["state"])


@pytest.mark.xfail(strict=True, reason="no in-process tunnel supervisor yet")
def test_open_studio_with_live_share_registers_with_relay(rig, studio_project) -> None:
    token = _mint_record_link(studio_project)

    with rig() as studio:
        session = wait_for(lambda: studio.relay_app.state.relay.tunnel_for_token(token), timeout=3)
        assert session is not None
        assert wait_for(lambda: _tunnel_state(studio.gui_url) == "online")
