"""Run the relay on a real uvicorn port for tests that need live WebSockets."""

from __future__ import annotations

import contextlib
import socket
import threading
from collections.abc import Iterator

import pytest
import uvicorn
from fastapi import FastAPI

from podcast_relay.app import create_relay_app


@contextlib.contextmanager
def live_relay(
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
    startup_complete = threading.Event()

    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets: list[socket.socket] | None = None) -> None:
            await super().startup(sockets=sockets)
            startup_complete.set()

    server = ReadyServer(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        assert startup_complete.wait(timeout=2) and server.started, "relay uvicorn failed to start"
        yield f"ws://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)
