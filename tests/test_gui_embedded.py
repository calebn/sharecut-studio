"""The Studio served from inside a host process: one app, one held port, one start, a final stop."""

from __future__ import annotations

import asyncio
import contextlib
import http.client
import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

from podcast_mcp.gui import embedded
from podcast_mcp.gui.bind import BOOT_TOKEN_ENV, BOOT_TOKEN_HEADER
from podcast_mcp.services.jobs import shared_job_manager


@pytest.fixture(autouse=True)
def engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    monkeypatch.setattr(embedded, "_ENGINE", embedded._Engine())
    monkeypatch.setenv(BOOT_TOKEN_ENV, "boot-token-for-tests")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    yield
    embedded.stop()


def _health(port: int, token: str = "boot-token-for-tests") -> dict[str, bool]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/health", headers={BOOT_TOKEN_HEADER: token}
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def _listener_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == "sharecut-embedded"]


def test_start_serves_the_studio_on_a_loopback_port() -> None:
    port = embedded.start().port

    assert port > 0
    assert _health(port) == {"ok": True}
    assert embedded.status() == embedded.Serving(port)


def test_a_second_start_returns_the_same_port_and_the_same_app() -> None:
    first = embedded.start().port
    app = embedded._ENGINE._app

    assert embedded.start().port == first
    assert embedded._ENGINE._app is app
    assert len(_listener_threads()) == 1


def test_stop_is_safe_to_repeat_and_ends_the_server_thread() -> None:
    embedded.start()

    embedded.stop()
    embedded.stop()

    assert embedded.status() == embedded.Stopped("the engine was stopped; reopen the app")
    assert _listener_threads() == []


def test_start_after_stop_is_refused_and_the_port_is_released() -> None:
    port = embedded.start().port
    embedded.stop()

    with pytest.raises(embedded.EmbeddedStartError) as refused:
        embedded.start()

    assert str(refused.value) == "the engine was stopped; reopen the app"
    assert embedded.status() == embedded.Stopped("the engine was stopped; reopen the app")
    assert _listener_threads() == []
    with pytest.raises(OSError):
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2)


def test_stop_before_any_start_leaves_the_engine_able_to_start() -> None:
    embedded.stop()

    assert embedded.status() == embedded.Idle()
    assert _health(embedded.start().port) == {"ok": True}


def test_stop_returns_while_an_event_stream_is_open() -> None:
    port = embedded.start().port
    job = shared_job_manager().adopt_agent_job(tool_id="test", label="Test", claim="streaming")
    stream = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    stream.request("GET", f"/api/pipeline/events?job_id={job.id}")
    response = stream.getresponse()
    assert response.status == 200
    assert response.getheader("content-type", "").startswith("text/event-stream")

    started = time.monotonic()
    embedded.stop()

    assert time.monotonic() - started < 4
    assert _listener_threads() == []
    stream.close()


def test_the_host_mcp_is_not_mounted_even_on_a_trusted_host() -> None:
    port = embedded.start().port
    app = embedded._ENGINE._app
    request = urllib.request.Request(f"http://127.0.0.1:{port}/mcp", data=b"{}", method="POST")

    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(request, timeout=10)

    assert refused.value.code == 404
    assert app.state.host_mcp_session_manager is None


def test_a_failed_start_records_the_reason_and_leaves_no_thread(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def broken(*, host_mcp: bool) -> None:
        raise RuntimeError("the web bundle is missing\nsecond line")

    monkeypatch.setattr("podcast_mcp.gui.server.create_app", broken)

    with pytest.raises(
        embedded.EmbeddedStartError, match="RuntimeError: the web bundle is missing"
    ):
        embedded.start()

    assert embedded.status() == embedded.Failed("RuntimeError: the web bundle is missing")
    assert _listener_threads() == []
    log = (tmp_path / "home" / "Library" / "Logs" / "ShareCut Studio" / "engine.log").read_text()
    assert "embedded start failed" in log
    assert "RuntimeError: the web bundle is missing" in log


def test_a_second_failed_start_appends_to_the_engine_log(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def broken(*, host_mcp: bool) -> None:
        raise RuntimeError("attempt")

    monkeypatch.setattr("podcast_mcp.gui.server.create_app", broken)
    for _ in range(2):
        with pytest.raises(embedded.EmbeddedStartError):
            embedded.start()

    log = (tmp_path / "home" / "Library" / "Logs" / "ShareCut Studio" / "engine.log").read_text()
    assert log.count("embedded start failed") == 2


def test_an_unwritable_log_directory_does_not_mask_the_start_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def broken(*, host_mcp: bool) -> None:
        raise RuntimeError("the web bundle is missing")

    monkeypatch.setattr("podcast_mcp.gui.server.create_app", broken)
    logs = tmp_path / "home" / "Library" / "Logs"
    logs.parent.mkdir(parents=True, exist_ok=True)
    logs.write_text("a file where the log directory should be")

    with pytest.raises(
        embedded.EmbeddedStartError, match="RuntimeError: the web bundle is missing"
    ):
        embedded.start()

    assert embedded.status() == embedded.Failed("RuntimeError: the web bundle is missing")


def test_a_failed_start_can_be_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.gui import server

    real = server.create_app
    calls: list[int] = []

    def flaky(*, host_mcp: bool) -> FastAPI:
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("first attempt")
        return real(host_mcp=host_mcp)

    monkeypatch.setattr(server, "create_app", flaky)
    with pytest.raises(embedded.EmbeddedStartError):
        embedded.start()

    port = embedded.start().port

    assert _health(port) == {"ok": True}
    assert len(calls) == 2


def _app_with_lifespan(monkeypatch: pytest.MonkeyPatch, lifespan: Any) -> None:
    def build(*, host_mcp: bool) -> FastAPI:
        app = FastAPI(lifespan=lifespan)
        app.add_api_route("/ping", lambda: {"pong": True})
        return app

    monkeypatch.setattr("podcast_mcp.gui.server.create_app", build)


def test_a_lifespan_that_raises_fails_the_start_and_the_held_port_survives_a_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: list[int] = []

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("lifespan failed")
        yield

    _app_with_lifespan(monkeypatch, lifespan)
    with pytest.raises(embedded.EmbeddedStartError, match="the server stopped while starting"):
        embedded.start()
    held = embedded._ENGINE._socket
    assert held is not None
    port = held.getsockname()[1]
    assert embedded.status() == embedded.Failed("the server stopped while starting")
    assert _listener_threads() == []

    assert embedded.start().port == port

    with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=10) as response:
        assert json.loads(response.read()) == {"pong": True}


def test_a_startup_that_outlives_the_deadline_fails_the_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    released = threading.Event()
    real_close = embedded._Listener.close

    def close_and_release(self: embedded._Listener) -> None:
        released.set()
        real_close(self)

    @contextlib.asynccontextmanager
    async def blocked(_app: FastAPI) -> AsyncIterator[None]:
        await asyncio.to_thread(released.wait, 10)
        yield

    monkeypatch.setattr(embedded._Listener, "close", close_and_release)
    _app_with_lifespan(monkeypatch, blocked)
    monkeypatch.setattr(embedded, "_ENGINE", embedded._Engine(start_timeout_sec=0.1))

    with pytest.raises(embedded.EmbeddedStartError, match="the server did not start in time"):
        embedded.start()

    assert embedded.status() == embedded.Failed("the server did not start in time")
    assert _listener_threads() == []


def test_a_server_thread_that_died_ends_the_engine_for_good() -> None:
    embedded.start()
    listener = embedded._ENGINE._listener
    assert listener is not None
    listener.server.should_exit = True
    listener.thread.join(10)

    stopped = embedded.Stopped("the server stopped unexpectedly; reopen the app")
    assert embedded.status() == stopped
    with pytest.raises(embedded.EmbeddedStartError, match="the server stopped unexpectedly"):
        embedded.start()
