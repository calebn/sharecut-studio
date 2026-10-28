"""The Studio announcement and the settings check behind the CLI handoff (#1733)."""

from __future__ import annotations

import contextlib
import errno
import http.client
import io
import json
import os
import socket
import socketserver
import struct
import sys
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from podcast_mcp.cli import context as cli_context
from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.services.app import (
    DIRECT_ENV_VAR,
    StudioBadReply,
    StudioHost,
    StudioUnresponsive,
    announce_studio_host,
    env_differences,
    locate_studio,
    read_studio_host,
    studio_host_path,
    withdraw_studio_host,
)
from podcast_mcp.services.app import studio_host as studio_host_module
from podcast_mcp.services.app.studio_host import (
    HANDOFF_PROTOCOL,
    HandoffLost,
    HandoffRefused,
    hand_off,
    handoff_env,
)
from podcast_mcp.util import process
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import (
    project_commit_lock,
    project_state_lock,
    render_cancel_scope,
)
from studio_ping_helpers import ping_answering


@pytest.fixture
def project(tmp_workspace: Path) -> Path:
    episode = EpisodeProject.create("t", str(tmp_workspace))
    episode.ensure_dirs()
    return save_project(episode)


def _host(instance: str = "a1", host: str = "127.0.0.1", port: int = 8765) -> StudioHost:
    return StudioHost(instance, os.getpid(), host, port, "tok", "0.1.1")


def test_a_withdrawal_removes_only_its_own_runs_announcement(project: Path) -> None:
    announce_studio_host(project, _host("first"))
    withdraw_studio_host(project, "someone-else")
    assert read_studio_host(project) == _host("first")
    withdraw_studio_host(project, "first")
    assert read_studio_host(project) is None


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        json.dumps({"instance": "a"}),
        json.dumps({"instance": "a", "pid": 1, "host": "evil.example", "port": 80, "token": "t"}),
        json.dumps({"instance": "a", "pid": 1, "host": "127.0.0.1", "port": 0, "token": "t"}),
        json.dumps({"instance": "a", "pid": 1, "host": "127.0.0.1", "port": 80, "token": ""}),
    ],
)
def test_an_announcement_that_is_not_a_local_studio_is_ignored(project: Path, content: str) -> None:
    path = studio_host_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    assert read_studio_host(project) is None
    assert locate_studio(project) is None


def test_opting_out_never_contacts_studio(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    announce_studio_host(project, _host())
    monkeypatch.setenv(DIRECT_ENV_VAR, "1")
    assert locate_studio(project) is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX process absence requires os.kill(pid, 0)")
def test_a_reaped_studio_process_is_absent_without_pinging(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    child = process.popen([sys.executable, "-c", "pass"])
    try:
        pid = child.pid
        assert child.wait(timeout=5) == 0
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
        announce_studio_host(project, StudioHost("a1", pid, "127.0.0.1", 8765, "tok", "0.1.1"))
        monkeypatch.setattr(
            studio_host_module,
            "_ping",
            lambda *_args: pytest.fail("a confirmed dead Studio PID must not be pinged"),
        )
        assert locate_studio(project) is None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()


@pytest.mark.parametrize("pid", [0, -1, 1234])
def test_unknown_studio_owner_keeps_timeout_protection(
    project: Path, monkeypatch: pytest.MonkeyPatch, pid: int
) -> None:
    announce_studio_host(project, StudioHost("a1", pid, "127.0.0.1", 8765, "tok", "0.1.1"))
    seen: list[int] = []

    def uncertain(_pid: int, _signal: int) -> None:
        seen.append(_pid)
        raise PermissionError("owner cannot be probed")

    def timeout(_host: StudioHost, _project: str) -> tuple[int, object]:
        raise TimeoutError

    monkeypatch.setattr(os, "kill", uncertain)
    monkeypatch.setattr(studio_host_module, "_ping", timeout)
    with pytest.raises(StudioUnresponsive):
        locate_studio(project)
    assert seen == ([pid] if pid > 0 and sys.platform != "win32" else [])


def test_only_settings_the_caller_set_must_match_and_values_stay_local() -> None:
    caller = {
        "PODCAST_BATCH": "1",
        "PODCAST_SESSION_TOKEN": "secret",
        "PODCAST_SIDECAR_PORT": "9",
        "PODCAST_NO_STUDIO_HANDOFF": "",
        "HOME": "/x",
    }
    settings = handoff_env(caller)
    assert settings == {"PODCAST_BATCH": "1"}
    assert env_differences(settings, {"PODCAST_BATCH": "1", "PODCAST_OTHER": "2"}) == []
    assert env_differences(settings, {"PODCAST_BATCH": "0"}) == ["PODCAST_BATCH"]
    assert env_differences(settings, {}) == ["PODCAST_BATCH"]


def test_waiting_for_the_project_stops_when_the_command_is_cancelled(project: Path) -> None:
    episode = EpisodeProject.model_validate_json(project.read_text(encoding="utf-8"))
    holding, release = threading.Event(), threading.Event()

    def hold() -> None:
        with project_commit_lock(episode):
            holding.set()
            release.wait(30)

    holder = threading.Thread(target=hold)
    holder.start()
    assert holding.wait(10)
    cancelled = threading.Event()
    outcome: list[BaseException] = []

    def waiter() -> None:
        try:
            with render_cancel_scope(cancelled.is_set), project_commit_lock(episode):
                outcome.append(AssertionError("took the lock while it was held"))
        except CancelledProgress as exc:
            outcome.append(exc)

    waiting = threading.Thread(target=waiter)
    waiting.start()
    cancelled.set()
    waiting.join(10)
    release.set()
    holder.join(10)
    assert [type(exc) for exc in outcome] == [CancelledProgress]
    assert project_state_lock(episode).acquire(blocking=False)
    project_state_lock(episode).release()


def test_each_thread_configures_its_own_progress_reporter() -> None:
    seen: dict[str, object] = {}

    def run(name: str, *, progress: bool) -> None:
        cli_context.configure(progress=progress)
        seen[name] = cli_context.get_progress()
        cli_context.reset_progress()

    first = threading.Thread(target=run, args=("a",), kwargs={"progress": False})
    second = threading.Thread(target=run, args=("b",), kwargs={"progress": False})
    first.start()
    second.start()
    first.join(10)
    second.join(10)
    assert seen["a"] is not seen["b"]


@pytest.mark.skipif(not hasattr(os, "getuid"), reason="POSIX file modes")
def test_announcement_readable_by_others_is_not_trusted(project: Path) -> None:
    announce_studio_host(project, _host())
    assert read_studio_host(project) is not None
    studio_host_path(project).chmod(0o644)
    assert read_studio_host(project) is None


def test_relayed_output_loses_terminal_control_characters() -> None:
    from podcast_mcp.services.app.studio_host import _plain

    assert _plain("ok\x1b]0;pwned\x07 line\n\ttab\r") == "ok]0;pwned line\n\ttab\r"


def test_quit_signal_cancels_handed_off_commands_before_uvicorn_drains() -> None:
    from types import SimpleNamespace

    from podcast_mcp.gui.bind import _cancel_handed_off_commands_on_exit
    from podcast_mcp.gui.routes import handoff

    state = handoff.StudioHostState("127.0.0.1")
    run = handoff._Run(id="r1")
    state.runs["r1"] = run
    app = SimpleNamespace(state=SimpleNamespace(studio_host=state))
    seen: list[int] = []
    server = SimpleNamespace(handle_exit=lambda sig, frame: seen.append(sig))

    _cancel_handed_off_commands_on_exit(server, app)
    server.handle_exit(2, None)

    assert run.cancel.is_set()
    assert seen == [2]


def test_workspace_folder_finds_the_same_announcement_as_the_project_file(project: Path) -> None:
    announce_studio_host(project, _host())
    assert studio_host_path(project.parent) == studio_host_path(project)
    assert read_studio_host(project.parent) is not None


@pytest.fixture
def quick_ping(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(studio_host_module, "PING_TIMEOUT_SEC", 0.5)


@pytest.fixture
def silent_listener() -> Iterator[int]:
    """Something that accepts connections on loopback and never answers."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    yield sock.getsockname()[1]
    sock.close()


def test_a_studio_that_accepts_and_stays_silent_is_never_bypassed(
    project: Path, silent_listener: int, quick_ping: None
) -> None:
    announce_studio_host(project, _host(port=silent_listener))
    with pytest.raises(StudioUnresponsive, match="did not answer in time"):
        locate_studio(project)


def test_a_studio_that_goes_silent_after_the_ping_is_lost_not_bypassed(
    project: Path, silent_listener: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(studio_host_module, "STREAM_SILENCE_TIMEOUT_SEC", 0.2)
    host = _host(port=silent_listener)
    with pytest.raises(HandoffLost, match="did not answer in time"):
        hand_off(
            host,
            argv=["status"],
            project=str(project),
            cwd=str(project),
            out=io.StringIO(),
            err=io.StringIO(),
        )


def test_a_dropped_handoff_response_is_uncertain_even_before_start_event(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class DroppedResponse:
        def request(self, *_args: object, **_kwargs: object) -> None:
            return None

        def getresponse(self) -> None:
            raise http.client.RemoteDisconnected("response dropped")

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_connection", lambda *_args: DroppedResponse())
    with pytest.raises(HandoffLost, match="may have changed the project"):
        hand_off(
            _host(),
            argv=["comment", "add"],
            project=str(project),
            cwd=str(project.parent),
            out=io.StringIO(),
            err=io.StringIO(),
        )


@pytest.mark.parametrize(
    ("status", "code", "expected"),
    [
        (409, "protocol", HandoffRefused),
        (429, "too_many", HandoffRefused),
        (409, "unexpected", HandoffLost),
        (503, "protocol", HandoffLost),
    ],
)
def test_only_defined_pre_execution_responses_are_refusals(
    project: Path,
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    code: str,
    expected: type[Exception],
) -> None:
    class Response:
        def __init__(self) -> None:
            self.status = status

        def read(self) -> bytes:
            return json.dumps({"code": code, "detail": "Studio declined."}).encode()

    class Connection:
        def request(self, *_args: object, **_kwargs: object) -> None:
            return None

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_connection", lambda *_args: Connection())
    with pytest.raises(expected) as caught:
        hand_off(
            _host(),
            argv=["comment", "add"],
            project=str(project),
            cwd=str(project.parent),
            out=io.StringIO(),
            err=io.StringIO(),
        )
    if expected is HandoffLost:
        assert "may have changed the project" in str(caught.value)
    else:
        assert caught.value.code == code


def test_a_deeply_nested_refusal_body_is_reported_as_uncertain(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = b"[" * 10000

    class Response:
        status = 503

        def read(self) -> bytes:
            return body

    class Connection:
        def request(self, *_args: object, **_kwargs: object) -> None:
            return None

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_connection", lambda *_args: Connection())
    with pytest.raises(HandoffLost, match="may have changed the project"):
        hand_off(
            _host(),
            argv=["comment", "add"],
            project=str(project),
            cwd=str(project.parent),
            out=io.StringIO(),
            err=io.StringIO(),
        )


def test_post_transport_error_does_not_expose_exception_text(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Connection:
        def request(self, *_args: object, **_kwargs: object) -> None:
            raise OSError("private transport detail")

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_connection", lambda *_args: Connection())
    with pytest.raises(HandoffLost) as caught:
        hand_off(
            _host(),
            argv=["comment", "add"],
            project=str(project),
            cwd=str(project.parent),
            out=io.StringIO(),
            err=io.StringIO(),
        )
    assert "may have changed the project" in str(caught.value)
    assert "private transport detail" not in str(caught.value)


def test_a_studio_nothing_listens_for_is_a_stale_announcement(project: Path) -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    announce_studio_host(project, _host(port=port))
    assert locate_studio(project) is None


@pytest.mark.timeout(8)
@pytest.mark.parametrize("framing", ["content-length", "close-delimited"])
def test_a_ping_body_reset_after_headers_is_never_bypassed(
    project: Path, monkeypatch: pytest.MonkeyPatch, framing: str
) -> None:
    headers_received = threading.Event()
    responses: list[http.client.HTTPResponse] = []
    original_getresponse = http.client.HTTPConnection.getresponse

    def getresponse(conn: http.client.HTTPConnection) -> http.client.HTTPResponse:
        response = original_getresponse(conn)
        responses.append(response)
        headers_received.set()
        return response

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            request = b""
            while b"\r\n\r\n" not in request:
                piece = self.request.recv(4096)
                if not piece:
                    return
                request += piece
            header = (
                b"Content-Length: 100\r\n"
                if framing == "content-length"
                else b"Connection: close\r\n"
            )
            self.request.sendall(b"HTTP/1.1 200 OK\r\n" + header + b'\r\n{"')
            if headers_received.wait(3):
                linger_format = "hh" if sys.platform == "win32" else "ii"
                self.request.setsockopt(
                    socket.SOL_SOCKET, socket.SO_LINGER, struct.pack(linger_format, 1, 0)
                )
                self.request.close()

    monkeypatch.setattr(http.client.HTTPConnection, "getresponse", getresponse)
    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            announce_studio_host(project, _host(port=server.server_address[1]))
            with pytest.raises(StudioBadReply):
                locate_studio(project)
        finally:
            server.shutdown()
            thread.join(3)
    assert headers_received.is_set()
    assert len(responses) == 1
    assert responses[0].isclosed()


def test_a_ping_body_timeout_before_deadline_still_retries(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    responses: list[http.client.HTTPResponse] = []

    def read(response: http.client.HTTPResponse, _size: int) -> bytes:
        responses.append(response)
        raise TimeoutError("body read timed out")

    monkeypatch.setattr(http.client.HTTPResponse, "read", read)
    with ping_answering(200, b"{}") as port:
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioUnresponsive) as caught:
            locate_studio(project)
    assert type(caught.value) is StudioUnresponsive
    assert len(responses) == 2
    assert all(response.isclosed() for response in responses)


def test_a_studio_slow_to_answer_once_is_pinged_again(project: Path, quick_ping: None) -> None:
    pings = {"count": 0}
    second_arrived = threading.Event()
    instance = "slow-once"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            pings["count"] += 1
            if pings["count"] == 1:
                second_arrived.wait(10)
                return
            second_arrived.set()
            body = json.dumps(
                {"instance": instance, "protocol": HANDOFF_PROTOCOL, "serves": True}
            ).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: object) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        announce_studio_host(project, _host(instance, port=server.server_address[1]))
        located = locate_studio(project)
    finally:
        second_arrived.set()
        server.shutdown()
        server.server_close()
        thread.join(10)
    assert located is not None
    assert located.instance == instance
    assert pings["count"] == 2


@contextlib.contextmanager
def _trickling_ping(framing: str) -> Iterator[tuple[int, list[None], threading.Event]]:
    stop = threading.Event()
    requests: list[None] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append(None)
            self.close_connection = True
            if framing == "headers":
                prefix = b"HTTP/1.1 200 OK\r\nX-Pad: "
                piece = b"x"
            else:
                headers = {
                    "content-length": b"Content-Length: 1000000\r\n",
                    "chunked": b"Transfer-Encoding: chunked\r\n",
                    "close-delimited": b"Connection: close\r\n",
                }
                prefix = b"HTTP/1.1 200 OK\r\n" + headers[framing] + b"\r\n"
                piece = b"1\r\nx\r\n" if framing == "chunked" else b"x"
            try:
                self.connection.sendall(prefix)
                while not stop.wait(0.025):
                    self.connection.sendall(piece)
            except OSError:
                pass

        def do_POST(self) -> None:
            self.do_GET()

        def log_message(self, *_args: object) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server.server_port, requests, stop
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        thread.join(3)


@pytest.mark.timeout(12)
@pytest.mark.parametrize("framing", ["headers", "content-length", "chunked", "close-delimited"])
def test_a_trickling_ping_expires_both_attempts_without_bypassing_studio(
    project: Path, quick_ping: None, framing: str
) -> None:
    with _trickling_ping(framing) as (port, requests, stop):
        announce_studio_host(project, _host(port=port))
        outcome: list[BaseException | StudioHost | None] = []

        def locate() -> None:
            try:
                outcome.append(locate_studio(project))
            except BaseException as exc:
                outcome.append(exc)

        worker = threading.Thread(target=locate)
        worker.start()
        try:
            worker.join(3)
            assert not worker.is_alive(), "trickling bytes kept Studio discovery blocked"
            assert len(requests) == 2
            assert len(outcome) == 1
            assert type(outcome[0]) is StudioUnresponsive
        finally:
            stop.set()
            worker.join(3)
            assert not worker.is_alive(), "Studio discovery did not stop after the peer closed"


def test_cancel_posts_the_run_and_token_to_studio() -> None:
    requests: list[tuple[str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            requests.append((self.path, self.headers.get("X-Sharecut-Handoff-Token")))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_args: object) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        studio_host_module._cancel(_host(port=server.server_port), "run with & spaces")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)
    assert requests == [("/api/handoff/cancel?run=run%20with%20%26%20spaces", "tok")]


@pytest.mark.timeout(8)
@pytest.mark.parametrize("framing", ["headers", "content-length", "chunked", "close-delimited"])
def test_cancel_acknowledgment_has_one_deadline_and_closes_response(
    quick_ping: None, monkeypatch: pytest.MonkeyPatch, framing: str
) -> None:
    responses: list[http.client.HTTPResponse] = []
    original_getresponse = http.client.HTTPConnection.getresponse

    def getresponse(conn: http.client.HTTPConnection) -> http.client.HTTPResponse:
        response = original_getresponse(conn)
        responses.append(response)
        return response

    monkeypatch.setattr(http.client.HTTPConnection, "getresponse", getresponse)
    with _trickling_ping(framing) as (port, requests, stop):
        outcome: list[BaseException | None] = []

        def cancel() -> None:
            try:
                outcome.append(studio_host_module._cancel(_host(port=port), "active-run"))
            except BaseException as exc:
                outcome.append(exc)

        worker = threading.Thread(target=cancel)
        worker.start()
        try:
            worker.join(2)
            assert not worker.is_alive(), "trickling bytes kept Studio cancellation blocked"
            assert len(requests) == 1
            assert outcome == [None]
            assert len(responses) == (0 if framing == "headers" else 1)
            assert all(response.isclosed() for response in responses)
        finally:
            stop.set()
            worker.join(3)
            assert not worker.is_alive(), "Studio cancellation did not stop after the peer closed"


def test_localhost_uses_numeric_loopbacks_and_closes_failed_candidate(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = json.dumps({"instance": "a1", "protocol": HANDOFF_PROTOCOL, "serves": True}).encode()
    attempted: list[studio_host_module._DeadlineSocket] = []

    class CandidateSocket(studio_host_module._DeadlineSocket):
        def __init__(self, family: socket.AddressFamily, *, deadline: float) -> None:
            super().__init__(socket.AF_INET, deadline=deadline)
            self.requested_family = family

        def connect(self, address: object) -> None:
            attempted.append(self)
            if self.requested_family == socket.AF_INET6:
                raise OSError("IPv6 unavailable")
            super().connect(address)

    monkeypatch.setattr(studio_host_module, "_DeadlineSocket", CandidateSocket)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: pytest.fail("DNS used"))
    with ping_answering(200, body) as port:
        announce_studio_host(project, _host(host="localhost", port=port))
        assert locate_studio(project) is not None
    assert len(attempted) == 2
    assert all(sock.fileno() == -1 for sock in attempted)


def test_ping_closes_returned_close_delimited_response_after_timeout(
    project: Path, quick_ping: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    responses: list[http.client.HTTPResponse] = []
    original_getresponse = studio_host_module._PingConnection.getresponse

    def getresponse(conn: studio_host_module._PingConnection) -> http.client.HTTPResponse:
        response = original_getresponse(conn)
        responses.append(response)
        return response

    monkeypatch.setattr(studio_host_module._PingConnection, "getresponse", getresponse)
    with _trickling_ping("close-delimited") as (port, _requests, _stop):
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioUnresponsive):
            locate_studio(project)
    assert len(responses) == 2
    assert all(response.isclosed() for response in responses)


def test_ping_classifies_transport_error_after_deadline_as_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"now": 0.0}

    class Connection:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            return None

        def request(self, *_args: object, **_kwargs: object) -> None:
            clock["now"] = 1.0
            raise OSError("late reset")

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_PingConnection", Connection)
    monkeypatch.setattr(studio_host_module, "PING_TIMEOUT_SEC", 0.5)
    monkeypatch.setattr(time, "monotonic", lambda: clock["now"])
    with pytest.raises(TimeoutError):
        studio_host_module._ping(_host(), "/project")


def test_ping_rejects_success_after_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 0.0}

    class Response:
        status = 200
        closed = False

        def read(self, _size: int) -> bytes:
            clock["now"] = 1.0
            return b"{}"

        def close(self) -> None:
            self.closed = True

    response = Response()

    class Connection:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            return None

        def request(self, *_args: object, **_kwargs: object) -> None:
            return None

        def getresponse(self) -> Response:
            return response

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_PingConnection", Connection)
    monkeypatch.setattr(studio_host_module, "PING_TIMEOUT_SEC", 0.5)
    monkeypatch.setattr(time, "monotonic", lambda: clock["now"])
    with pytest.raises(TimeoutError):
        studio_host_module._ping(_host(), "/project")
    assert response.closed


@pytest.mark.parametrize("body", [b"", b"[]", b"not json", b"null"])
def test_a_ping_answered_200_with_a_body_that_is_not_a_studio_reply_is_never_bypassed(
    project: Path, body: bytes
) -> None:
    with ping_answering(200, body) as port:
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioBadReply, match="not a Studio reply") as caught:
            locate_studio(project)
    assert "Nothing was run." in str(caught.value)
    assert isinstance(caught.value, StudioUnresponsive)
    assert caught.value.host.port == port


@pytest.mark.parametrize(
    "body",
    [b"[" * 100000 + b"]" * 100000, b" " * (studio_host_module.PING_BODY_MAX_BYTES + 1)],
    ids=["deeply-nested", "over-the-cap"],
)
def test_a_ping_body_that_is_too_deep_or_too_long_is_never_bypassed(
    project: Path, body: bytes
) -> None:
    with ping_answering(200, body) as port:
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioBadReply, match="not a Studio reply"):
            locate_studio(project)


@pytest.mark.parametrize(("status", "body"), [(503, b""), (503, b"[]"), (404, b"not json")])
def test_a_ping_that_is_not_200_is_never_bypassed(project: Path, status: int, body: bytes) -> None:
    with ping_answering(status, body) as port:
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioBadReply, match="not a Studio reply") as caught:
            locate_studio(project)
    assert caught.value.host.port == port


@pytest.mark.parametrize(
    "protocol",
    [
        pytest.param(HANDOFF_PROTOCOL + 1, id="unsupported-integer"),
        pytest.param(True, id="boolean-equal-to-integer"),
        pytest.param(1.0, id="float-equal-to-integer"),
        pytest.param("1", id="string"),
        pytest.param(None, id="null"),
    ],
)
def test_a_matching_ping_with_an_unsupported_protocol_is_never_bypassed(
    project: Path, protocol: object
) -> None:
    body = json.dumps({"instance": "a1", "protocol": protocol, "serves": True}).encode()
    with ping_answering(200, body) as port:
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioBadReply, match="not a Studio reply") as caught:
            locate_studio(project)
    assert caught.value.host.port == port


@pytest.mark.parametrize(
    "identity",
    [
        pytest.param({}, id="missing"),
        pytest.param({"instance": None}, id="null"),
        pytest.param({"instance": ""}, id="empty"),
        pytest.param({"instance": 1}, id="not-a-string"),
    ],
)
def test_a_ping_with_an_invalid_instance_is_never_bypassed(
    project: Path, identity: dict[str, object]
) -> None:
    body = json.dumps({"protocol": HANDOFF_PROTOCOL, "serves": True, **identity}).encode()
    with ping_answering(200, body) as port:
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioBadReply, match="not a Studio reply"):
            locate_studio(project)


@pytest.mark.parametrize(
    "body",
    [
        json.dumps({"instance": "another-run", "protocol": HANDOFF_PROTOCOL, "serves": True}),
        json.dumps({"instance": "a1", "protocol": HANDOFF_PROTOCOL, "serves": False}),
    ],
    ids=["different-instance", "not-serving-project"],
)
def test_a_positive_ping_for_another_instance_or_project_is_absence(
    project: Path, body: str
) -> None:
    with ping_answering(200, body.encode()) as port:
        announce_studio_host(project, _host(port=port))
        assert locate_studio(project) is None


@pytest.mark.parametrize("fields", [{}, {"serves": None}, {"serves": "yes"}, {"serves": 1}])
def test_a_matching_ping_with_missing_or_invalid_serves_is_never_bypassed(
    project: Path, fields: dict[str, object]
) -> None:
    body = json.dumps({"instance": "a1", "protocol": HANDOFF_PROTOCOL, **fields})
    with ping_answering(200, body.encode()) as port:
        announce_studio_host(project, _host(port=port))
        with pytest.raises(StudioBadReply, match="not a Studio reply"):
            locate_studio(project)


@pytest.mark.parametrize(
    ("extra", "expected"), [({}, True), ({"mcp": True}, True), ({"mcp": False}, False)]
)
def test_a_ping_says_whether_the_studio_has_mcp(
    project: Path, extra: dict[str, bool], expected: bool
) -> None:
    body = json.dumps(
        {"instance": "a1", "protocol": HANDOFF_PROTOCOL, "serves": True, **extra}
    ).encode()
    with ping_answering(200, body) as port:
        announce_studio_host(project, _host(port=port))
        host = locate_studio(project)
    assert host is not None
    assert host.mcp is expected


def _winsock_timeout() -> OSError:
    exc = OSError(10060, "A connection attempt failed because the connected party did not respond")
    exc.winerror = 10060  # type: ignore[attr-defined]
    return exc


_OS_TIMEOUTS = [
    pytest.param(lambda: OSError(10060, "timed out"), id="errno-10060"),
    pytest.param(_winsock_timeout, id="winerror-10060"),
    pytest.param(lambda: OSError(errno.ETIMEDOUT, "timed out"), id="etimedout"),
]


@pytest.mark.parametrize("make_error", _OS_TIMEOUTS)
def test_an_os_level_ping_timeout_is_a_wedged_studio(
    project: Path, monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], OSError]
) -> None:
    announce_studio_host(project, _host())
    pings: list[int] = []

    def timeout(_host: StudioHost, _project: str) -> tuple[int, object]:
        pings.append(1)
        raise make_error()

    monkeypatch.setattr(studio_host_module, "_ping", timeout)
    with pytest.raises(StudioUnresponsive):
        locate_studio(project)
    assert len(pings) == 2


def _dial_localhost(
    monkeypatch: pytest.MonkeyPatch, errors: dict[str, Callable[[], OSError]]
) -> None:
    class FakeSocket:
        def __init__(self, _family: int, *, deadline: float) -> None:
            pass

        def connect(self, address: tuple[str, int]) -> None:
            raise errors[address[0]]()

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_DeadlineSocket", FakeSocket)
    conn = studio_host_module._PingConnection("localhost", 1, deadline=time.monotonic() + 30)
    conn._dial(("localhost", 1), 1.0, None)


@pytest.mark.parametrize("make_error", _OS_TIMEOUTS)
def test_a_timed_out_loopback_attempt_is_not_masked_by_a_later_refusal(
    monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], OSError]
) -> None:
    with pytest.raises(OSError) as raised:
        _dial_localhost(
            monkeypatch,
            {
                "::1": make_error,
                "127.0.0.1": lambda: ConnectionRefusedError(errno.ECONNREFUSED, ""),
            },
        )
    assert studio_host_module._is_timeout(raised.value)


def test_all_loopback_attempts_refused_is_still_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ConnectionRefusedError) as raised:
        _dial_localhost(
            monkeypatch,
            {
                "::1": lambda: ConnectionRefusedError(errno.ECONNREFUSED, ""),
                "127.0.0.1": lambda: ConnectionRefusedError(errno.ECONNREFUSED, ""),
            },
        )
    assert not studio_host_module._is_timeout(raised.value)


def _winsock_reset() -> OSError:
    exc = OSError(10054, "An existing connection was forcibly closed by the remote host")
    exc.winerror = 10054  # type: ignore[attr-defined]
    return exc


@pytest.mark.parametrize(
    "make_error",
    [
        pytest.param(lambda: ConnectionResetError(errno.ECONNRESET, "reset"), id="errno-104"),
        pytest.param(_winsock_reset, id="winerror-10054"),
    ],
)
def test_a_connection_reset_is_not_a_timeout(make_error: Callable[[], OSError]) -> None:
    assert not studio_host_module._is_timeout(make_error())


@pytest.mark.parametrize("make_error", _OS_TIMEOUTS)
def test_an_os_level_run_request_timeout_is_lost_not_bypassed(
    project: Path, monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], OSError]
) -> None:
    class TimedOut:
        def request(self, *_args: object, **_kwargs: object) -> None:
            raise make_error()

        def close(self) -> None:
            return None

    monkeypatch.setattr(studio_host_module, "_connection", lambda *_args: TimedOut())
    with pytest.raises(HandoffLost, match="did not answer in time"):
        hand_off(
            _host(),
            argv=["status"],
            project=str(project),
            cwd=str(project),
            out=io.StringIO(),
            err=io.StringIO(),
        )


@pytest.mark.parametrize(
    "make_error",
    [
        pytest.param(lambda: ConnectionRefusedError(errno.ECONNREFUSED, "refused"), id="refused"),
        pytest.param(lambda: OSError(10061, "refused"), id="wsaeconnrefused"),
    ],
)
def test_a_refused_ping_is_still_an_absent_studio(
    project: Path, monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], OSError]
) -> None:
    announce_studio_host(project, _host())

    def refused(_host: StudioHost, _project: str) -> tuple[int, object]:
        raise make_error()

    monkeypatch.setattr(studio_host_module, "_ping", refused)
    assert locate_studio(project) is None


def _scripted_pings(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[Callable[[], tuple[int, object]]]
) -> list[int]:
    pings: list[int] = []

    def ping(_host: StudioHost, _project: str) -> tuple[int, object]:
        pings.append(1)
        return outcomes[len(pings) - 1]()

    monkeypatch.setattr(studio_host_module, "_ping", ping)
    return pings


def _raises(make_error: Callable[[], BaseException]) -> Callable[[], tuple[int, object]]:
    def fail() -> tuple[int, object]:
        raise make_error()

    return fail


@pytest.mark.parametrize(
    "second",
    [
        pytest.param(lambda: ConnectionRefusedError(errno.ECONNREFUSED, ""), id="refused"),
        pytest.param(lambda: ConnectionResetError(errno.ECONNRESET, ""), id="reset"),
        pytest.param(lambda: http.client.RemoteDisconnected("closed"), id="remote-disconnected"),
        pytest.param(lambda: http.client.BadStatusLine("x"), id="bad-status-line"),
        pytest.param(lambda: ValueError("bad"), id="value-error"),
    ],
)
def test_a_timed_out_first_ping_is_not_masked_by_a_failed_retry(
    project: Path, monkeypatch: pytest.MonkeyPatch, second: Callable[[], BaseException]
) -> None:
    announce_studio_host(project, _host())
    pings = _scripted_pings(
        monkeypatch, [_raises(lambda: TimeoutError("timed out")), _raises(second)]
    )
    with pytest.raises(StudioUnresponsive):
        locate_studio(project)
    assert len(pings) == 2


def test_a_timed_out_first_ping_yields_to_a_clean_retry(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    announce_studio_host(project, _host())
    reply = {"instance": _host().instance, "protocol": 1, "serves": True}
    _scripted_pings(monkeypatch, [_raises(lambda: TimeoutError("timed out")), lambda: (200, reply)])
    found = locate_studio(project)
    assert found is not None
    assert found.instance == _host().instance


def test_a_refused_first_ping_is_not_retried(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    announce_studio_host(project, _host())
    pings = _scripted_pings(
        monkeypatch, [_raises(lambda: ConnectionRefusedError(errno.ECONNREFUSED, ""))]
    )
    assert locate_studio(project) is None
    assert len(pings) == 1
