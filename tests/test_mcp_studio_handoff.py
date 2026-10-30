"""Stdio MCP tool calls run in the Studio serving the project (#1753).

A real Studio (uvicorn on a loopback socket) serves a project. The stdio server's
``call_tool`` is wrapped by ``install_studio_handoff``; its own implementation raises, so a
result can only have come from Studio. A project no Studio serves still runs here.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import json
import os
import socket
import threading
import time
from collections.abc import Callable, Iterator
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import anyio
import pytest
import uvicorn
from mcp.types import CallToolResult

from podcast_mcp.gui.bind import exclusive_listen_socket
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.server import mcp as real_mcp
from podcast_mcp.mcp.studio_handoff import install_studio_handoff
from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.services.app import StudioHost, announce_studio_host, studio_host_path
from studio_ping_helpers import ping_answering

pytestmark = pytest.mark.timeout(120)


def _wait_until(condition: Callable[[], bool], what: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    tick = threading.Event()
    while not condition():
        assert time.monotonic() < deadline, what
        tick.wait(0.02)


class _Direct:
    """What the stdio server would run locally; a handed-off call must never reach it."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._tool_manager = real_mcp._tool_manager

    async def call_tool(self, name: str, arguments: dict[str, Any], *_a: Any, **_k: Any) -> Any:
        self.calls.append((name, dict(arguments)))
        return "ran here"


@pytest.fixture
def minimal_project(tmp_workspace: Path) -> Path:
    project = EpisodeProject.create("test_episode", str(tmp_workspace))
    project.ensure_dirs()
    return save_project(project)


def _serve(project: Path, bind_host: str, listen_on: str = "127.0.0.1") -> Iterator[Path]:
    run_app = create_app(served_project=project, bind_host=bind_host)
    try:
        sock = exclusive_listen_socket(listen_on, 0)
    except OSError as exc:
        pytest.skip(f"cannot bind {listen_on}: {exc}")
    run_app.state.listen_port = sock.getsockname()[1]
    run_app.state.listen_host = sock.getsockname()[0]
    server = uvicorn.Server(uvicorn.Config(run_app, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    _wait_until(lambda: server.started, "Studio did not start")
    try:
        yield project
    finally:
        server.should_exit = True
        thread.join(20)
        sock.close()


@pytest.fixture
def studio(minimal_project: Path) -> Iterator[Path]:
    yield from _serve(minimal_project, "127.0.0.1")


@pytest.fixture
def wildcard_studio(minimal_project: Path) -> Iterator[Path]:
    """A Studio bound to 0.0.0.0: it announces 127.0.0.1 but mounts no /mcp."""
    yield from _serve(minimal_project, "0.0.0.0", "0.0.0.0")


@pytest.fixture
def alias_studio(minimal_project: Path) -> Iterator[Path]:
    """A Studio bound to 127.0.0.2: loopback-range, but no address a client may ping."""
    yield from _serve(minimal_project, "127.0.0.2", "127.0.0.2")


def _wrapped() -> _Direct:
    server = _Direct()
    install_studio_handoff(server)
    return server


@contextlib.contextmanager
def _deadline_peer(
    project: Path,
    *,
    stalled: bool = True,
    trickle: bool = False,
    session_id: bool = False,
    ping_answers: bool = True,
    ping_error: bool = False,
    wedge_call: bool = False,
) -> Iterator[tuple[list[str], threading.Event, threading.Event]]:
    methods: list[str] = []
    initialized = threading.Event()
    stop = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args: Any) -> None:
            return None

        def reply(self, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def stream(self) -> None:
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            if session_id:
                self.send_header("Mcp-Session-Id", "deadline-session")
            self.end_headers()
            initialized.set()
            while not stop.wait(0.02):
                if trickle:
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    except OSError:
                        return

        def do_GET(self) -> None:
            if self.path == "/mcp":
                self.send_error(405)
                return
            self.reply({"instance": "deadline", "protocol": 1, "serves": True, "mcp": True})

        def do_DELETE(self) -> None:
            methods.append("DELETE")
            self.stream()

        def do_POST(self) -> None:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            method = request["method"]
            methods.append(method)
            if "id" not in request:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if method == "initialize":
                if stalled:
                    self.stream()
                    return
                result = {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "serverInfo": {"name": "deadline-peer", "version": "1"},
                }
            elif method == "ping":
                if not ping_answers:
                    self.stream()
                    return
                if ping_error:
                    error = {"code": -32601, "message": "no ping here"}
                    self.reply({"jsonrpc": "2.0", "id": request["id"], "error": error})
                    return
                result = {}
            elif method == "tools/call":
                token = request["params"].get("_meta", {}).get("progressToken")
                if wedge_call:
                    self.stream()
                    return
                if token is not None:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for step in range(7):
                        notification = {
                            "jsonrpc": "2.0",
                            "method": "notifications/progress",
                            "params": {"progressToken": token, "progress": step, "total": 7},
                        }
                        self.wfile.write(f"data: {json.dumps(notification)}\n\n".encode())
                        self.wfile.flush()
                        if stop.wait(0.1):
                            return
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {"content": [{"type": "text", "text": "finished"}]},
                    }
                    self.wfile.write(f"data: {json.dumps(response)}\n\n".encode())
                    self.wfile.flush()
                    return
                if stop.wait(0.7):
                    return
                result = {"content": [{"type": "text", "text": "finished"}]}
            else:
                result = {"tools": []}
            self.reply({"jsonrpc": "2.0", "id": request["id"], "result": result})

    peer = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    peer.daemon_threads = True
    thread = threading.Thread(target=peer.serve_forever, daemon=True)
    thread.start()
    announce_studio_host(
        project,
        StudioHost("deadline", os.getpid(), "127.0.0.1", peer.server_port, "test", "1"),
    )
    try:
        yield methods, initialized, stop
    finally:
        stop.set()
        peer.shutdown()
        peer.server_close()
        thread.join(3)


def test_deadline_peer_accepts_notifications_before_an_ordinary_request(
    minimal_project: Path,
) -> None:
    from podcast_mcp.services.app import read_studio_host

    with _deadline_peer(minimal_project, stalled=False) as (methods, _, _):
        host = read_studio_host(minimal_project)
        assert host is not None
        with contextlib.closing(HTTPConnection(host.host, host.port, timeout=2)) as connection:
            for notification in (
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/cancelled",
                    "params": {"requestId": 7, "reason": "caller cancelled"},
                },
            ):
                connection.request(
                    "POST",
                    "/mcp",
                    json.dumps(notification),
                    {"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                assert response.status == 202
                assert response.read() == b""
            connection.request(
                "POST",
                "/mcp",
                json.dumps({"jsonrpc": "2.0", "id": 8, "method": "ping"}),
                {"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            assert response.status == 200
            assert json.loads(response.read()) == {"jsonrpc": "2.0", "id": 8, "result": {}}
    assert methods == ["notifications/initialized", "notifications/cancelled", "ping"]


@pytest.mark.parametrize("trickle,session_id", [(False, False), (True, False), (True, True)])
def test_stalled_initialization_stops_without_sending_or_replaying(
    minimal_project: Path,
    monkeypatch: pytest.MonkeyPatch,
    trickle: bool,
    session_id: bool,
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    monkeypatch.setattr(handoff, "INITIALIZE_TIMEOUT_SEC", 0.5, raising=False)
    direct = _wrapped()
    with _deadline_peer(minimal_project, trickle=trickle, session_id=session_id) as (
        methods,
        _,
        stop,
    ):

        async def call() -> Any:
            task = asyncio.create_task(
                direct.call_tool("list_clips_tool", {"project_path": str(minimal_project)})
            )
            done, _ = await asyncio.wait({task}, timeout=2)
            if not done:
                stop.set()
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await asyncio.wait_for(task, 1)
            assert done, "Studio initialization did not stop before the watchdog"
            return task.result()

        result = asyncio.run(call())
    assert result.is_error
    assert "Nothing was run" in result.content[0].text
    assert "tools/call" not in methods
    assert direct.calls == []


def test_initialization_caller_cancellation_propagates_without_replay(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    monkeypatch.setattr(handoff, "INITIALIZE_TIMEOUT_SEC", 0.5, raising=False)
    direct = _wrapped()
    with _deadline_peer(minimal_project, trickle=True) as (methods, initialized, _):

        async def cancel() -> None:
            call = asyncio.create_task(
                direct.call_tool("list_clips_tool", {"project_path": str(minimal_project)})
            )
            assert await asyncio.to_thread(initialized.wait, 1)
            call.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(call, 2)

        asyncio.run(cancel())
    assert "tools/call" not in methods
    assert direct.calls == []


def _heartbeat_every(monkeypatch: pytest.MonkeyPatch, interval: float) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    monkeypatch.setattr(handoff, "HEARTBEAT_INTERVAL_SEC", interval)
    monkeypatch.setattr(handoff, "HEARTBEAT_TIMEOUT_SEC", interval)
    monkeypatch.setattr(handoff, "HEARTBEAT_MISSES", 2)


def test_studio_that_wedges_after_taking_the_call_is_reported_not_waited_on(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _heartbeat_every(monkeypatch, 0.2)
    direct = _wrapped()
    with _deadline_peer(minimal_project, stalled=False, ping_answers=False, wedge_call=True) as (
        methods,
        _,
        stop,
    ):

        async def call() -> Any:
            task = asyncio.create_task(
                direct.call_tool("list_clips_tool", {"project_path": str(minimal_project)})
            )
            done, _ = await asyncio.wait({task}, timeout=8)
            if not done:
                stop.set()
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await asyncio.wait_for(task, 1)
            assert done, "a wedged Studio was waited on past the heartbeat limit"
            return task.result()

        result = asyncio.run(call())
    assert result.is_error
    assert "stopped answering" in result.content[0].text
    assert "may have changed the project" in result.content[0].text
    assert methods.count("tools/call") == 1
    assert direct.calls == []


@pytest.mark.parametrize("ping_error", [False, True])
def test_a_long_tool_on_a_studio_that_answers_pings_is_not_cut_short(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch, ping_error: bool
) -> None:
    _heartbeat_every(monkeypatch, 0.1)
    direct = _wrapped()
    with _deadline_peer(minimal_project, stalled=False, ping_error=ping_error) as (methods, _, _):
        result = asyncio.run(
            direct.call_tool("list_clips_tool", {"project_path": str(minimal_project)})
        )
    assert not result.is_error
    assert result.content[0].text == "finished"
    assert methods.count("ping") >= 2
    assert methods.count("tools/call") == 1


@pytest.mark.parametrize("progress", [False, True])
def test_initialized_tool_can_outlast_the_initialization_deadline(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch, progress: bool
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    monkeypatch.setattr(handoff, "INITIALIZE_TIMEOUT_SEC", 0.5, raising=False)
    direct = _wrapped()
    context = _Context() if progress else None
    with _deadline_peer(minimal_project, stalled=False) as (methods, _, _):
        result = asyncio.run(
            direct.call_tool(
                "list_clips_tool",
                {"project_path": str(minimal_project)},
                context,
            )
        )
    assert not result.is_error
    assert result.content[0].text == "finished"
    assert methods.count("tools/call") == 1
    assert direct.calls == []
    if context is not None:
        assert [report[0] for report in context.reports] == list(range(7))


def test_same_file_alias_tool_call_runs_in_studio(studio: Path) -> None:
    alias = studio.with_name("project-alias.json")
    alias.hardlink_to(studio)
    assert alias.resolve() != studio.resolve()
    assert alias.samefile(studio)
    before = studio.read_bytes()
    server = _wrapped()

    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(alias)}))

    assert isinstance(result, CallToolResult)
    assert not result.is_error
    assert server.calls == []
    assert studio.read_bytes() == before


def test_tool_call_runs_in_the_studio_serving_the_project(studio: Path) -> None:
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert isinstance(result, CallToolResult)
    assert not result.is_error
    assert server.calls == []
    assert json.loads(result.content[0].text) is not None  # type: ignore[union-attr]


def test_a_live_studio_answers_the_mcp_ping_the_heartbeat_sends(studio: Path) -> None:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    from podcast_mcp.mcp.studio_handoff import _studio_mcp_url
    from podcast_mcp.services.app import locate_studio

    host = locate_studio(studio)
    assert host is not None

    async def ping() -> None:
        async with (
            streamable_http_client(_studio_mcp_url(host)) as (read, write, *_),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            with anyio.fail_after(10):
                await session.send_ping()

    asyncio.run(ping())


def test_a_studio_that_serves_no_mcp_refuses_the_call(wildcard_studio: Path) -> None:
    from podcast_mcp.services.app import locate_studio

    host = locate_studio(wildcard_studio)
    assert host is not None
    assert host.mcp is False
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("list_clips_tool", {"project_path": str(wildcard_studio)})
    )
    assert isinstance(result, CallToolResult)
    assert result.is_error
    text = result.content[0].text  # type: ignore[union-attr]
    assert f"pid {host.pid}" in text
    assert "list_clips_tool" in text
    assert "PODCAST_NO_STUDIO_HANDOFF=1" in text
    assert "does not serve MCP" in text
    assert "--host 127.0.0.1" in text
    assert server.calls == []


def test_a_studio_that_serves_no_mcp_is_bypassed_when_handoff_is_off(
    wildcard_studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_NO_STUDIO_HANDOFF", "1")
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("list_clips_tool", {"project_path": str(wildcard_studio)})
    )
    assert result == "ran here"
    assert server.calls == [("list_clips_tool", {"project_path": str(wildcard_studio)})]


def test_a_studio_on_127_0_0_2_refuses_the_call_and_nothing_runs(alias_studio: Path) -> None:
    before = alias_studio.read_bytes()
    server = _wrapped()
    result = asyncio.run(server.call_tool("add_chapter_tool", {"project_path": str(alias_studio)}))
    assert isinstance(result, CallToolResult)
    assert result.is_error
    text = result.content[0].text  # type: ignore[union-attr]
    for needed in (
        f"pid {os.getpid()}",
        "127.0.0.2",
        "--host 127.0.0.1",
        "PODCAST_NO_STUDIO_HANDOFF=1",
        str(studio_host_path(alias_studio)),
    ):
        assert needed in text
    assert "/mcp" not in text
    assert server.calls == []
    assert alias_studio.read_bytes() == before


def test_a_studio_on_127_0_0_2_is_bypassed_when_handoff_is_off(
    alias_studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_NO_STUDIO_HANDOFF", "1")
    server = _wrapped()
    result = asyncio.run(server.call_tool("add_chapter_tool", {"project_path": str(alias_studio)}))
    assert result == "ran here"
    assert [name for name, _ in server.calls] == ["add_chapter_tool"]


def test_a_probe_that_fails_unexpectedly_never_runs_the_call_here(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    failure = OSError(errno.ENETUNREACH, "unreachable")
    announce_studio_host(
        minimal_project,
        StudioHost(
            "a1", os.getpid(), "192.0.2.2", 8765, "tok", "0.1.1", hostname=socket.gethostname()
        ),
    )

    def dial(*_args: Any, **_kwargs: Any) -> socket.socket:
        raise failure

    monkeypatch.setattr(socket, "create_connection", dial)
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("add_chapter_tool", {"project_path": str(minimal_project)})
    )
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert server.calls == []


def test_an_undialable_announced_address_never_runs_the_call_here(
    minimal_project: Path,
) -> None:
    announce_studio_host(
        minimal_project,
        StudioHost(
            "a1",
            os.getpid(),
            "fe80::1%" + "a" * 80,
            8765,
            "tok",
            "0.1.1",
            hostname=socket.gethostname(),
        ),
    )
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("add_chapter_tool", {"project_path": str(minimal_project)})
    )
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert server.calls == []


def test_a_wildcard_studio_is_still_found_on_loopback(
    wildcard_studio: Path,
) -> None:
    from podcast_mcp.services.app import locate_studio

    host = locate_studio(wildcard_studio)
    assert host is not None
    assert host.host == "127.0.0.1"
    assert host.hostname == ""


def test_a_loopback_studio_announces_its_mcp(studio: Path) -> None:
    from podcast_mcp.services.app import locate_studio

    host = locate_studio(studio)
    assert host is not None
    assert host.mcp is True


def test_the_default_project_env_is_handed_off_too(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_MCP_PROJECT", str(studio))
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {}))
    assert isinstance(result, CallToolResult)
    assert server.calls == []


def test_a_project_no_studio_serves_runs_here(minimal_project: Path) -> None:
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("list_clips_tool", {"project_path": str(minimal_project)})
    )
    assert result == "ran here"
    assert server.calls == [("list_clips_tool", {"project_path": str(minimal_project)})]


def test_opting_out_runs_here_even_with_a_studio(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_NO_STUDIO_HANDOFF", "1")
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert result == "ran here"


def test_a_tool_without_a_project_runs_here(studio: Path) -> None:
    server = _wrapped()
    names = [t.name for t in real_mcp._tool_manager.list_tools()]
    no_project = next(
        n
        for n in names
        if "project_path"
        not in (real_mcp._tool_manager.get_tool(n).parameters or {}).get("properties", {})
    )
    assert asyncio.run(server.call_tool(no_project, {})) == "ran here"


def test_studio_that_stops_answering_after_the_send_reports_a_possible_change(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    class _Session:
        def __init__(self, *_a: Any) -> None: ...

        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *_a: Any) -> None:
            return None

        async def initialize(self) -> None:
            return None

        async def call_tool(self, *_a: Any) -> Any:
            raise ConnectionError("Studio went away")

    class _Streams:
        async def __aenter__(self) -> tuple[None, None]:
            return None, None

        async def __aexit__(self, *_a: Any) -> None:
            return None

    monkeypatch.setattr(handoff, "ClientSession", _Session)
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url, **_kw: _Streams())
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert "may have changed the project" in result.content[0].text  # type: ignore[union-attr]
    assert "(ConnectionError)" in result.content[0].text  # type: ignore[union-attr]
    assert server.calls == []


def _text(result: Any) -> str:
    return result.content[0].text  # type: ignore[no-any-return]


def test_studio_that_cannot_be_reached_before_the_send_stops_the_call(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    class _Unreachable:
        async def __aenter__(self) -> Any:
            raise ConnectionRefusedError("nobody home")

        async def __aexit__(self, *_a: Any) -> None:
            return None

    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url, **_kw: _Unreachable())
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert "did not take list_clips_tool" in _text(result)
    assert server.calls == []


def test_studio_whose_initialize_fails_after_a_good_ping_stops_the_call(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    class _Session:
        def __init__(self, *_a: Any) -> None: ...

        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *_a: Any) -> None:
            return None

        async def initialize(self) -> None:
            raise ConnectionError("initialize failed")

    class _Streams:
        async def __aenter__(self) -> tuple[None, None]:
            return None, None

        async def __aexit__(self, *_a: Any) -> None:
            return None

    monkeypatch.setattr(handoff, "ClientSession", _Session)
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url, **_kw: _Streams())
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert isinstance(result, CallToolResult)
    assert result.is_error
    text = _text(result)
    assert "did not take list_clips_tool" in text
    assert "Nothing was run" in text
    assert "may have changed the project" not in text
    assert server.calls == []


def test_a_listener_answering_the_ping_with_an_empty_list_stops_the_call(
    minimal_project: Path,
) -> None:
    with ping_answering(200, b"[]") as port:
        announce_studio_host(
            minimal_project, StudioHost("x", os.getpid(), "127.0.0.1", port, "tok", "0")
        )
        server = _wrapped()
        result = asyncio.run(
            server.call_tool("list_clips_tool", {"project_path": str(minimal_project)})
        )
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert "not a Studio reply" in _text(result)
    assert server.calls == []


@pytest.mark.parametrize("status", [404, 503])
def test_a_live_studio_http_error_stops_the_call_without_running_it_here(
    minimal_project: Path, status: int
) -> None:
    with ping_answering(status, b"service unavailable") as port:
        announce_studio_host(
            minimal_project, StudioHost("x", os.getpid(), "127.0.0.1", port, "tok", "0")
        )
        server = _wrapped()
        result = asyncio.run(
            server.call_tool("list_clips_tool", {"project_path": str(minimal_project)})
        )
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert "not a Studio reply" in _text(result)
    assert server.calls == []


def test_relative_file_arguments_are_made_absolute_before_the_send(
    studio: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    seen: dict[str, Any] = {}

    class _Session:
        def __init__(self, *_a: Any) -> None: ...

        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *_a: Any) -> None:
            return None

        async def initialize(self) -> None:
            return None

        async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
            seen.update(arguments)
            return CallToolResult(content=[])

    class _Streams:
        async def __aenter__(self) -> tuple[None, None]:
            return None, None

        async def __aexit__(self, *_a: Any) -> None:
            return None

    monkeypatch.setattr(handoff, "ClientSession", _Session)
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url, **_kw: _Streams())
    monkeypatch.chdir(tmp_path)
    server = _wrapped()
    asyncio.run(
        server.call_tool(
            "track_add",
            {"project_path": str(studio), "file_path": "a.wav", "track_id": "relative-id"},
        )
    )
    assert seen["file_path"] == str(tmp_path / "a.wav")
    assert seen["track_id"] == "relative-id"
    assert "project_path" not in seen


class _Context:
    """A stdio request context whose client sent a progressToken."""

    progress_token = "tok"

    def __init__(self, fail: bool = False) -> None:
        self.reports: list[tuple[float, float | None, str | None]] = []
        self.fail = fail

    async def report_progress(
        self, progress: float, total: float | None = None, message: str | None = None
    ) -> None:
        if self.fail:
            raise RuntimeError("client went away")
        self.reports.append((progress, total, message))


def test_studio_progress_reaches_the_client_that_asked_for_it(studio: Path) -> None:
    context = _Context()
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("list_clips_tool", {"project_path": str(studio)}, context)
    )
    assert isinstance(result, CallToolResult)
    assert not result.is_error
    assert server.calls == []
    assert [r[2] for r in context.reports] == ["list_clips_tool", "done"], context.reports


def _fake_studio_session(monkeypatch: pytest.MonkeyPatch, seen: dict[str, Any], ticks: int) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff

    class _Session:
        def __init__(self, *_a: Any) -> None: ...

        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *_a: Any) -> None:
            return None

        async def initialize(self) -> None:
            return None

        async def call_tool(
            self,
            name: str,
            arguments: dict[str, Any],
            read_timeout_seconds: float | None = None,
            progress_callback: Any = None,
        ) -> Any:
            seen["kwargs"] = {} if progress_callback is None else {"progress_callback": 1}
            callback = progress_callback
            for step in range(ticks):
                if callback is not None:
                    await callback(float(step), float(ticks), f"step {step}")
            return CallToolResult(content=[])

    class _Streams:
        async def __aenter__(self) -> tuple[None, None]:
            return None, None

        async def __aexit__(self, *_a: Any) -> None:
            return None

    monkeypatch.setattr(handoff, "ClientSession", _Session)
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url, **_kw: _Streams())


def test_progress_is_relayed_in_order_with_total_and_message(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, Any] = {}
    _fake_studio_session(monkeypatch, seen, ticks=3)
    context = _Context()
    server = _wrapped()
    asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}, context))
    assert context.reports == [(0.0, 3.0, "step 0"), (1.0, 3.0, "step 1"), (2.0, 3.0, "step 2")]


def test_no_progress_is_asked_for_without_a_client_token(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, Any] = {}
    _fake_studio_session(monkeypatch, seen, ticks=2)
    server = _wrapped()
    asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert "progress_callback" not in seen["kwargs"]
    seen.clear()
    bare = type("Bare", (), {"report_progress": _Context.report_progress})()
    asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}, bare))
    assert seen["kwargs"] == {}


def test_a_client_that_stops_listening_does_not_fail_the_call(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, Any] = {}
    _fake_studio_session(monkeypatch, seen, ticks=2)
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("list_clips_tool", {"project_path": str(studio)}, _Context(fail=True))
    )
    assert isinstance(result, CallToolResult)
    assert not result.is_error


def test_a_context_that_cannot_say_if_progress_was_asked_still_sends_the_call(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Outside:
        @property
        def request_context(self) -> Any:
            raise ValueError("Context is not available outside of a request")

    seen: dict[str, Any] = {}
    _fake_studio_session(monkeypatch, seen, ticks=1)
    server = _wrapped()
    result = asyncio.run(
        server.call_tool("list_clips_tool", {"project_path": str(studio)}, _Outside())
    )
    assert isinstance(result, CallToolResult)
    assert not result.is_error
    assert server.calls == []
    assert "progress_callback" not in seen["kwargs"]


def test_a_stdio_mutation_appears_on_an_open_studio_socket(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The J8 bar (#1848): an agent's edit reaches an open tab at once, not on a poll."""
    import urllib.parse

    from websockets.sync.client import connect

    from podcast_mcp.services.app import read_studio_host

    host = read_studio_host(studio)
    assert host is not None
    url = (
        f"ws://127.0.0.1:{host.port}/api/host/ws?document_client_id=tab&client_id=tab-1"
        f"&role=viewer&path={urllib.parse.quote(str(studio))}"
    )
    server = _wrapped()
    with connect(url, open_timeout=10) as tab:

        def next_document_frame() -> dict[str, Any]:
            for _ in range(40):
                frame = json.loads(tab.recv(timeout=10))
                if frame.get("plane") == "document":
                    return frame
            raise AssertionError("no document frame")

        assert next_document_frame()["type"] == "Snapshot"
        result = asyncio.run(
            server.call_tool(
                "add_chapter_tool", {"project_path": str(studio), "at_time": 1.0, "title": "Intro"}
            )
        )
        assert isinstance(result, CallToolResult) and not result.is_error
        assert server.calls == []  # it ran in Studio, not in the stdio process
        frame = next_document_frame()

    assert frame["type"] == "Applied"
    assert frame["command"]["type"] == "AddChapter"


def test_a_studio_that_stays_silent_is_reported_not_bypassed(
    studio: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import podcast_mcp.mcp.studio_handoff as handoff
    from podcast_mcp.services.app import StudioHost, StudioUnresponsive

    def silent(_project: Path) -> None:
        raise StudioUnresponsive(StudioHost("a", 4321, "127.0.0.1", 9, "t", "0"))

    monkeypatch.setattr(handoff, "locate_studio", silent)
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert "did not answer in time" in result.content[0].text  # type: ignore[union-attr]
    assert server.calls == []


@pytest.mark.parametrize(
    ("address", "expected"),
    [("::1", "http://[::1]:8818/mcp"), ("127.0.0.1", "http://127.0.0.1:8818/mcp")],
)
def test_the_studio_mcp_url_brackets_an_ipv6_address(address: str, expected: str) -> None:
    from podcast_mcp.mcp.studio_handoff import _studio_mcp_url

    assert _studio_mcp_url(StudioHost("i", 1, address, 8818, "t", "v")) == expected
