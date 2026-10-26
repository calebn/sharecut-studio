"""The CLI hands project commands to the Studio serving the project (#1733).

A real Studio server (uvicorn on a loopback socket) serves a project; real ``podcast``
processes run against it, so the tests see what a user and an agent see: the command runs
inside Studio while Studio holds the project, its output and exit code come back, and a
project no Studio serves is written directly as before.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import typer
import typer.main
import uvicorn

from podcast_mcp.cli.handoff import (
    NOT_HANDED_OFF,
    is_group,
    is_option,
    plan_handoff,
    takes_path,
)
from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.gui.bind import exclusive_listen_socket
from podcast_mcp.gui.routes import handoff as handoff_route
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.services.app import (
    HANDOFF_TOKEN_HEADER,
    StudioHost,
    announce_studio_host,
    read_studio_host,
    studio_host_path,
)
from podcast_mcp.util.project_state import current_cancel_check, project_commit_lock
from studio_ping_helpers import ping_answering

pytestmark = pytest.mark.timeout(120)


def _wait_until(condition: Callable[[], bool], what: str, timeout: float = 20.0) -> None:
    """Poll ``condition`` until it holds; the poll interval is a retry cadence, not a delay."""
    deadline = time.monotonic() + timeout
    tick = threading.Event()
    while not condition():
        assert time.monotonic() < deadline, what
        tick.wait(0.02)


@dataclass
class StudioRun:
    app: Any
    project: Path
    port: int
    commands: list[list[str]] = field(default_factory=list)


def _start_studio(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[StudioRun, Callable[[], None]]:
    run_app = create_app(served_project=project, bind_host="127.0.0.1")
    sock = exclusive_listen_socket("127.0.0.1", 0)
    run_app.state.listen_port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(run_app, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    _wait_until(lambda: server.started, "Studio did not start")
    studio = StudioRun(run_app, project, sock.getsockname()[1])
    real = handoff_route.execute_command

    def recording(argv: list[str], **kwargs: Any) -> int:
        studio.commands.append(list(argv))
        return real(argv, **kwargs)

    monkeypatch.setattr(handoff_route, "execute_command", recording)

    def stop() -> None:
        server.should_exit = True
        thread.join(20)
        sock.close()

    return studio, stop


@pytest.fixture
def minimal_project(tmp_workspace: Path) -> Path:
    project = EpisodeProject.create("test_episode", str(tmp_workspace))
    project.ensure_dirs()
    return save_project(project)


@pytest.fixture
def studio(minimal_project: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[StudioRun]:
    run, stop = _start_studio(minimal_project, monkeypatch)
    try:
        yield run
    finally:
        stop()


@contextlib.contextmanager
def _studio_holds_the_project(studio: StudioRun, *, seconds: float) -> Iterator[None]:
    """Hold the project's commit lock in Studio's process, as its own mix build does."""
    project = load_project(studio.project)
    holding, release = threading.Event(), threading.Event()

    def hold() -> None:
        with project_commit_lock(project):
            holding.set()
            release.wait(60)

    holder = threading.Thread(target=hold)
    holder.start()
    assert holding.wait(10)
    timer = threading.Timer(seconds, release.set)
    timer.start()
    try:
        yield
    finally:
        release.set()
        timer.cancel()
        holder.join(10)


def podcast(
    *args: str, env: dict[str, str] | None = None, cwd: Path | None = None, timeout: float = 90
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "podcast_mcp.cli.main", *args],
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
        cwd=cwd,
        timeout=timeout,
        check=False,
    )


def comment_add(
    project: Path, body: str = "hello", **kwargs: Any
) -> subprocess.CompletedProcess[str]:
    return podcast(
        "comment", "add", "--project", str(project), "--body", body, "--author", "agent",
        "--start", "1", **kwargs,
    )  # fmt: skip


def comment_bodies(project: Path) -> list[str]:
    return [c.body for c in load_project(project).comments]


def test_studio_announces_itself_privately_and_withdraws_on_exit(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run, stop = _start_studio(minimal_project, monkeypatch)
    try:
        host = read_studio_host(minimal_project)
        assert host is not None
        assert (host.host, host.port, host.pid) == ("127.0.0.1", run.port, os.getpid())
        if os.name != "nt":
            assert stat.S_IMODE(studio_host_path(minimal_project).stat().st_mode) == 0o600
    finally:
        stop()
    assert read_studio_host(minimal_project) is None


def test_command_runs_in_studio_and_waits_for_studio_to_release_the_project(
    studio: StudioRun,
) -> None:
    started = time.monotonic()
    with _studio_holds_the_project(studio, seconds=1.5):
        result = comment_add(studio.project, "from the cli")

    assert result.returncode == 0, result.stderr
    assert time.monotonic() - started >= 1.0
    assert json.loads(result.stdout)["body"] == "from the cli"
    assert comment_bodies(studio.project) == ["from the cli"]
    assert [argv[:2] for argv in studio.commands] == [["comment", "add"]]


def test_failure_message_and_exit_code_come_back_unchanged(studio: StudioRun) -> None:
    direct = podcast(
        "comment", "add", "--project", str(studio.project), "--body", "x", "--author", "a",
        "--start", "5", "--end", "1",
        env={"PODCAST_NO_STUDIO_HANDOFF": "1"},
    )  # fmt: skip
    handed = podcast(
        "comment", "add", "--project", str(studio.project), "--body", "x", "--author", "a",
        "--start", "5", "--end", "1",
    )  # fmt: skip
    assert direct.returncode == handed.returncode == 1, (direct.stderr, handed.stderr)
    # A handed-off call that Studio never saw ran directly: the stderr names why.
    assert handed.stderr == direct.stderr != "", handed.stderr
    assert len(studio.commands) == 1, f"the CLI did not reach Studio: {handed.stderr!r}"


def test_relative_paths_resolve_against_the_callers_directory(
    studio: StudioRun, tmp_path: Path
) -> None:
    caller = tmp_path / "elsewhere"
    caller.mkdir()
    relative = os.path.relpath(studio.project, caller)
    result = podcast(
        "comment", "list", "--project", relative, cwd=caller
    )  # fmt: skip
    assert result.returncode == 0, result.stderr
    assert studio.commands[0][3] == str(studio.project)


def test_two_commands_at_once_both_land(studio: StudioRun) -> None:
    first = threading.Thread(target=comment_add, args=(studio.project, "one"))
    second = threading.Thread(target=comment_add, args=(studio.project, "two"))
    first.start()
    second.start()
    first.join(90)
    second.join(90)
    assert sorted(comment_bodies(studio.project)) == ["one", "two"]
    assert len(studio.commands) == 2


def test_a_waiting_command_says_what_studio_is_busy_with(
    studio: StudioRun, monkeypatch: pytest.MonkeyPatch
) -> None:
    def status(_project: str) -> dict[str, Any]:
        return {
            "running": True,
            "jobs": [
                {"kind": "agent", "status": "running", "label": "pipeline run", "elapsed_sec": 1},
                {
                    "kind": "render_preview",
                    "status": "running",
                    "label": "Building the mix",
                    "elapsed_sec": 42.0,
                },
            ],
        }

    monkeypatch.setattr(handoff_route, "BUSY_NOTICE_AFTER_SEC", 0.05)
    monkeypatch.setattr(studio.app.state, "jobs", SimpleNamespace(status=status))
    with _studio_holds_the_project(studio, seconds=1.0):
        result = comment_add(studio.project, "after the mix")
    assert result.returncode == 0, result.stderr
    assert "Studio is busy with Building the mix (42s so far)" in result.stderr
    assert "pipeline run" not in result.stderr
    assert comment_bodies(studio.project) == ["after the mix"]


def test_cancelling_a_command_that_waits_for_the_project_stops_it_before_it_runs(
    studio: StudioRun,
) -> None:
    host = read_studio_host(studio.project)
    assert host is not None
    headers = {HANDOFF_TOKEN_HEADER: host.token, "Content-Type": "application/json"}
    body = json.dumps(
        {
            "protocol": 1,
            "argv": [
                "comment", "add", "--project", str(studio.project),
                "--body", "never", "--author", "a", "--start", "1",
            ],
            "project": str(studio.project),
            "cwd": str(studio.project.parent),
        }
    ).encode()  # fmt: skip
    with _studio_holds_the_project(studio, seconds=4.0):
        request = urllib.request.Request(
            f"http://127.0.0.1:{studio.port}/api/handoff/run", data=body, headers=headers
        )
        with urllib.request.urlopen(request, timeout=30) as stream:
            run_id = json.loads(stream.readline())["run"]
            _wait_until(lambda: len(studio.commands) == 1, "the command never started")
            cancel = urllib.request.Request(
                f"http://127.0.0.1:{studio.port}/api/handoff/cancel?run={run_id}",
                method="POST",
                headers=headers,
            )
            urllib.request.urlopen(cancel, timeout=5).close()
            events = [json.loads(line) for line in stream]
    assert events[-1]["t"] == "exit"
    assert events[-1]["code"] != 0
    assert comment_bodies(studio.project) == []


def test_direct_write_when_the_caller_opts_out(studio: StudioRun) -> None:
    result = comment_add(studio.project, env={"PODCAST_NO_STUDIO_HANDOFF": "1"})
    assert result.returncode == 0, result.stderr
    assert studio.commands == []


def test_direct_write_when_studio_serves_another_project(studio: StudioRun, tmp_path: Path) -> None:
    other = tmp_path / "other"
    other.mkdir()
    assert podcast("episode", "init", "--dir", str(other), "--name", "other").returncode == 0
    announcement = studio_host_path(other)
    announcement.parent.mkdir(parents=True, exist_ok=True)
    announcement.write_text(studio_host_path(studio.project).read_text(encoding="utf-8"))
    result = comment_add(other / "episode.project.json")
    assert result.returncode == 0, result.stderr
    assert studio.commands == []
    assert comment_bodies(other / "episode.project.json") == ["hello"]


def test_direct_write_when_the_announcing_studio_is_gone(minimal_project: Path) -> None:
    announcement = studio_host_path(minimal_project)
    announcement.parent.mkdir(parents=True, exist_ok=True)
    announcement.write_text(
        json.dumps(
            {
                "instance": "deadbeef",
                "pid": 2**22,
                "host": "127.0.0.1",
                "port": 9,
                "token": "stale",
                "version": "0",
            }
        )
    )
    result = comment_add(minimal_project)
    assert result.returncode == 0, result.stderr
    assert comment_bodies(minimal_project) == ["hello"]


def test_settings_that_differ_from_studios_run_directly_and_say_so(studio: StudioRun) -> None:
    result = comment_add(studio.project, env={"PODCAST_BATCH": "1"})
    assert result.returncode == 0, result.stderr
    assert studio.commands == []
    assert "PODCAST_BATCH" in result.stderr
    assert "Writing directly instead" in result.stderr


def test_the_run_and_ping_routes_need_the_announced_token(studio: StudioRun) -> None:
    url = f"http://127.0.0.1:{studio.port}/api/handoff/ping?project={studio.project}"
    with pytest.raises(urllib.error.HTTPError) as denied:
        urllib.request.urlopen(url, timeout=5)
    assert denied.value.code == 401
    host = read_studio_host(studio.project)
    assert host is not None
    request = urllib.request.Request(url, headers={HANDOFF_TOKEN_HEADER: host.token})
    with urllib.request.urlopen(request, timeout=5) as ok:
        assert json.load(ok)["serves"] is True


def test_a_command_that_never_runs_in_studio_is_refused_by_studio(studio: StudioRun) -> None:
    host = read_studio_host(studio.project)
    assert host is not None
    body = json.dumps(
        {
            "protocol": 1,
            "argv": ["gui", "--project", str(studio.project)],
            "project": str(studio.project),
            "cwd": str(studio.project.parent),
        }
    ).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{studio.port}/api/handoff/run",
        data=body,
        headers={HANDOFF_TOKEN_HEADER: host.token, "Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(request, timeout=5)
    assert refused.value.code == 409
    assert json.load(refused.value)["code"] == "not_eligible"


def test_cancel_stops_a_running_command(studio: StudioRun) -> None:
    started = threading.Event()
    slow = typer.Typer()

    @slow.command("slow-test")
    def _slow(project: Path = typer.Option(..., "--project")) -> None:
        typer.echo("started")
        started.set()
        check = current_cancel_check()
        assert check is not None
        _wait_until(check, "the command was never cancelled", timeout=30)
        raise typer.Exit(130)

    cli_app.command("slow-test")(_slow)
    handoff_route._click_root.cache_clear()
    try:
        host = read_studio_host(studio.project)
        assert host is not None
        headers = {HANDOFF_TOKEN_HEADER: host.token, "Content-Type": "application/json"}
        body = json.dumps(
            {
                "protocol": 1,
                "argv": ["slow-test", "--project", str(studio.project)],
                "project": str(studio.project),
                "cwd": str(studio.project.parent),
            }
        ).encode()
        request = urllib.request.Request(
            f"http://127.0.0.1:{studio.port}/api/handoff/run", data=body, headers=headers
        )
        with urllib.request.urlopen(request, timeout=30) as stream:
            run_id = json.loads(stream.readline())["run"]
            assert json.loads(stream.readline()) == {"t": "out", "s": "started\n"}
            cancel = urllib.request.Request(
                f"http://127.0.0.1:{studio.port}/api/handoff/cancel?run={run_id}",
                method="POST",
                headers=headers,
            )
            urllib.request.urlopen(cancel, timeout=5).close()
            events = [json.loads(line) for line in stream]
        assert events[-1] == {"t": "exit", "code": 130}
    finally:
        cli_app.registered_commands[:] = [
            c for c in cli_app.registered_commands if c.name != "slow-test"
        ]
        handoff_route._click_root.cache_clear()


def test_no_project_command_reads_its_paths_in_a_way_the_planner_cannot_follow() -> None:
    """Every path option of a handed-off command takes one value; arguments are positional."""
    root = typer.main.get_command(cli_app)
    unsupported: list[str] = []

    def walk(command: Any, trail: tuple[str, ...]) -> None:
        if is_group(command):
            for name, child in command.commands.items():
                walk(child, (*trail, name))
            return
        if trail[0] in NOT_HANDED_OFF or not any(
            "--project" in p.opts for p in command.params if is_option(p)
        ):
            return
        for param in command.params:
            if is_option(param) and param.nargs != 1 and not param.is_flag and not param.count:
                unsupported.append(" ".join(trail) + f" {param.name}")
            if takes_path(param) and is_option(param) and param.nargs != 1:
                unsupported.append(" ".join(trail) + f" {param.name}")

    walk(root, ())
    assert unsupported == []


def test_plan_makes_paths_absolute_and_keeps_everything_else(tmp_path: Path) -> None:
    tmp_path = tmp_path.resolve()
    root = typer.main.get_command(cli_app)
    plan = plan_handoff(
        root,
        ["--no-progress", "comment", "add", "--project", "ep/episode.project.json", "--body=x",
         "--author", "a", "--start", "-1.5"],
        tmp_path,
    )  # fmt: skip
    assert plan is not None
    assert plan.project == tmp_path / "ep" / "episode.project.json"
    assert plan.argv[:5] == ["--no-progress", "comment", "add", "--project", str(plan.project)]
    assert plan.argv[5:] == ["--body=x", "--author", "a", "--start", "-1.5"]


@pytest.mark.parametrize(
    "tail",
    [
        ["set-active", "--id", "v1"],
        ["share", "--pin", "--role", "viewer"],
        ["revoke-share", "--token", "t"],
    ],
)
def test_review_commands_that_name_a_project_are_handed_off(
    tail: list[str], tmp_path: Path
) -> None:
    tmp_path = tmp_path.resolve()
    root = typer.main.get_command(cli_app)
    plan = plan_handoff(root, ["review", tail[0], "--project", "ep/p.json", *tail[1:]], tmp_path)
    assert plan is not None
    assert plan.project == tmp_path / "ep" / "p.json"
    assert plan.argv == ["review", tail[0], "--project", str(plan.project), *tail[1:]]


def test_a_review_share_version_option_is_handed_off(tmp_path: Path) -> None:
    tmp_path = tmp_path.resolve()
    root = typer.main.get_command(cli_app)
    plan = plan_handoff(
        root, ["review", "share", "--project", "ep/p.json", "--version", "v1"], tmp_path
    )
    assert plan is not None
    assert plan.argv == ["review", "share", "--project", str(plan.project), "--version", "v1"]


def test_no_input_is_forwarded_to_studio(tmp_path: Path) -> None:
    from types import SimpleNamespace

    from podcast_mcp.cli.handoff import _root_flags

    flags = _root_flags(SimpleNamespace(params={"progress": True, "no_input": True}))
    assert flags == ["--no-input"]
    plan = plan_handoff(
        typer.main.get_command(cli_app),
        [*flags, "comment", "add", "--project", "ep/episode.project.json", "--body=x"],
        tmp_path.resolve(),
    )
    assert plan is not None
    assert plan.argv[0] == "--no-input"


def test_plan_resolves_symlinks_before_dotdot(tmp_path: Path) -> None:
    tmp_path = tmp_path.resolve()
    (tmp_path / "real").mkdir()
    (tmp_path / "here").mkdir()
    (tmp_path / "here" / "link").symlink_to(tmp_path / "real")
    root = typer.main.get_command(cli_app)
    plan = plan_handoff(root, ["comment", "list", "--project", "link/../p.json"], tmp_path / "here")
    assert plan is not None
    assert plan.project == tmp_path / "p.json"


@pytest.mark.parametrize(
    "argv",
    [
        ["gui", "--project", "p.json"],
        ["play", "range", "--project", "p.json"],
        ["comment", "add", "--help"],
        ["comment", "list"],
        ["pipeline", "list"],
        ["relay", "bucket-setup", "--config", "relay.yaml"],
        ["--version"],
        ["review", "backup-registry"],
        ["review", "backup-registry", "--dest", "backup.db"],
        ["comment", "list", "--unknown", "1", "--project", "p.json"],
        ["not-a-command", "--project", "p.json"],
    ],
)
def test_plan_leaves_commands_that_are_not_project_edits_alone(
    argv: list[str], tmp_path: Path
) -> None:
    root = typer.main.get_command(cli_app)
    assert plan_handoff(root, argv, tmp_path) is None


def test_a_studio_that_stays_silent_stops_the_command_instead_of_writing_directly(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.services.app import studio_host as studio_host_module

    monkeypatch.setattr(studio_host_module, "PING_TIMEOUT_SEC", 0.2)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    try:
        announce_studio_host(
            minimal_project,
            StudioHost("silent", os.getpid(), "127.0.0.1", sock.getsockname()[1], "tok", "0"),
        )
        result = CliRunner().invoke(
            cli_app,
            [
                "comment", "add", "--project", str(minimal_project), "--body", "x",
                "--author", "a", "--start", "1",
            ],
        )  # fmt: skip
    finally:
        sock.close()
    assert result.exit_code == 1
    assert "did not answer in time" in result.output
    assert comment_bodies(minimal_project) == []


def test_a_studio_answering_the_ping_with_an_empty_list_stops_the_command_with_a_message(
    minimal_project: Path,
) -> None:
    from typer.testing import CliRunner

    with ping_answering(200, b"[]") as port:
        announce_studio_host(
            minimal_project, StudioHost("x", os.getpid(), "127.0.0.1", port, "tok", "0")
        )
        result = CliRunner().invoke(
            cli_app,
            [
                "comment", "add", "--project", str(minimal_project), "--body", "x",
                "--author", "a", "--start", "1",
            ],
        )  # fmt: skip
    assert result.exit_code == 1
    assert "not a Studio reply" in result.output
    assert "Traceback" not in result.output
    assert result.exception is None or isinstance(result.exception, SystemExit)
    assert comment_bodies(minimal_project) == []
