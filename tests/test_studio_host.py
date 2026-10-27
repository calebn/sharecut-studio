"""The Studio announcement and the settings check behind the CLI handoff (#1733)."""

from __future__ import annotations

import io
import json
import os
import socket
import threading
from collections.abc import Iterator
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
    hand_off,
    handoff_env,
)
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
    return StudioHost(instance, 1234, host, port, "tok", "0.1.1")


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


def test_a_studio_nothing_listens_for_is_a_stale_announcement(project: Path) -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    announce_studio_host(project, _host(port=port))
    assert locate_studio(project) is None


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


def test_a_matching_ping_with_an_unsupported_protocol_is_never_bypassed(project: Path) -> None:
    body = json.dumps({"instance": "a1", "protocol": HANDOFF_PROTOCOL + 1, "serves": True}).encode()
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
