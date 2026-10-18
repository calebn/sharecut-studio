"""The Studio announcement and the settings check behind the CLI handoff (#1733)."""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from podcast_mcp.cli import context as cli_context
from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.services.app import (
    DIRECT_ENV_VAR,
    StudioHost,
    announce_studio_host,
    env_differences,
    locate_studio,
    read_studio_host,
    studio_host_path,
    withdraw_studio_host,
)
from podcast_mcp.services.app.studio_host import handoff_env
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import (
    project_commit_lock,
    project_state_lock,
    render_cancel_scope,
)


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
