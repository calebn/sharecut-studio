"""The Studio served from inside a host process: one app, one held port, a listener that can stop."""

from __future__ import annotations

import http.client
import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

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
    port = embedded.start()

    assert port > 0
    assert _health(port) == {"ok": True}
    assert embedded.status() == embedded.Serving(port)


def test_a_second_start_returns_the_same_port_and_the_same_app() -> None:
    first = embedded.start()
    app = embedded._ENGINE._app

    assert embedded.start() == first
    assert embedded._ENGINE._app is app
    assert len(_listener_threads()) == 1


def test_stop_is_safe_to_repeat_and_ends_the_server_thread() -> None:
    embedded.start()

    embedded.stop()
    embedded.stop()

    assert embedded.status() == embedded.Stopped()
    assert _listener_threads() == []


def test_start_after_stop_keeps_the_port_the_app_and_its_jobs() -> None:
    port = embedded.start()
    app = embedded._ENGINE._app
    manager = shared_job_manager()
    job = manager.adopt_agent_job(tool_id="test", label="Test", claim="before-stop")
    embedded.stop()

    assert embedded.start() == port

    assert _health(port) == {"ok": True}
    assert embedded._ENGINE._app is app
    assert shared_job_manager() is manager
    assert manager.get_job(job.id) is job


def test_stop_returns_while_an_event_stream_is_open() -> None:
    port = embedded.start()
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
    port = embedded.start()
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

    port = embedded.start()

    assert _health(port) == {"ok": True}
    assert len(calls) == 2


def test_a_server_thread_that_died_is_reported_and_start_serves_again() -> None:
    embedded.start()
    listener = embedded._ENGINE._listener
    assert listener is not None
    listener.server.should_exit = True
    listener.thread.join(10)

    assert embedded.status() == embedded.Failed("the server stopped unexpectedly")
    port = embedded.start()

    assert _health(port) == {"ok": True}
