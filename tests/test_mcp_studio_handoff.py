"""Stdio MCP tool calls run in the Studio serving the project (#1753).

A real Studio (uvicorn on a loopback socket) serves a project. The stdio server's
``call_tool`` is wrapped by ``install_studio_handoff``; its own implementation raises, so a
result can only have come from Studio. A project no Studio serves still runs here.
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
import socket
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

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


def test_tool_call_runs_in_the_studio_serving_the_project(studio: Path) -> None:
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert isinstance(result, CallToolResult)
    assert not result.is_error
    assert server.calls == []
    assert json.loads(result.content[0].text) is not None  # type: ignore[union-attr]


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
        "cannot hand work to",
        "Nothing was run",
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


@pytest.mark.parametrize(
    "failure", [ValueError("bad scope id"), OSError(errno.ENETUNREACH, "unreachable")]
)
def test_a_probe_that_fails_unexpectedly_never_runs_the_call_here(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch, failure: BaseException
) -> None:
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


def test_a_wildcard_studio_is_still_found_and_keeps_its_own_refusal(
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
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url: _Streams())
    server = _wrapped()
    result = asyncio.run(server.call_tool("list_clips_tool", {"project_path": str(studio)}))
    assert isinstance(result, CallToolResult)
    assert result.is_error
    assert "may have changed the project" in result.content[0].text  # type: ignore[union-attr]
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

    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url: _Unreachable())
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
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url: _Streams())
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
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url: _Streams())
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
    monkeypatch.setattr(handoff, "streamable_http_client", lambda _url: _Streams())


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
