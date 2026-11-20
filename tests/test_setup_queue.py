"""Episodes queued while a model downloads start on their own when it arrives (#4053)."""

from __future__ import annotations

import json
import queue
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.services.app import recent_projects as recent
from podcast_mcp.services.jobs import JobManager
from podcast_mcp.services.jobs import setup_queue as setup_queue_module
from podcast_mcp.services.jobs.setup_queue import QueuedRun, SetupQueue
from podcast_mcp.util.model_missing import ModelMissing

WHISPER = {"id": "whisper", "model": "small", "label": "Whisper small"}


def _missing(model: str = "small", kind: str = "whisper") -> ModelMissing:
    return ModelMissing(
        id=kind,
        model=model,
        label=f"Whisper {model}",
        purpose="transcription",
        size="~480 MB",
        size_bytes=480_000_000,
        command=f"podcast bootstrap --component whisper --whisper-model {model}",
        state="missing",
    )


class _Models:
    installed: ClassVar[set[str]] = set()


class _Service:
    started: ClassVar[queue.Queue[dict[str, Any]]] = queue.Queue()
    gate: ClassVar[threading.Event | None] = None
    fail_model_needed: ClassVar[bool] = False
    fail_dirs: ClassVar[set[str]] = set()
    fail_with: ClassVar[ModelMissing | None] = None
    on_run: ClassVar[Any] = None

    def __init__(self, ws: Any) -> None:
        self.ws = ws

    def run(self, **kwargs: Any) -> Any:
        type(self).started.put({"path": str(self.ws.path.parent.resolve()), **kwargs})
        if type(self).gate is not None:
            assert type(self).gate.wait(5), "gated fake service was not released"
        if type(self).on_run is not None:
            type(self).on_run(str(self.ws.path.parent.resolve()))
        if (
            type(self).fail_model_needed
            or str(self.ws.path.parent.resolve()) in type(self).fail_dirs
        ):
            raise type(self).fail_with or _missing()
        return SimpleNamespace(last_step="transcribe_tracks", job_result=lambda: {})


class _Hooks:
    on_require: ClassVar[Any] = None


def _require_model(kind: str, model: str | None = None, **_kwargs: Any) -> None:
    model = model or kind
    missing = model not in _Models.installed
    if _Hooks.on_require is not None:
        _Hooks.on_require(model)
    if missing:
        raise _missing(model, kind)


@pytest.fixture(autouse=True)
def fake_models(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    _Models.installed = set()
    _Service.started = queue.Queue()
    _Service.gate = None
    _Service.fail_model_needed = False
    _Service.fail_dirs = set()
    _Service.fail_with = None
    _Service.on_run = None
    _Hooks.on_require = None
    setup_queue_module.PARKED.clear()
    setup_queue_module.FAILURES.clear()
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.PipelineService", _Service)
    monkeypatch.setattr("podcast_mcp.engines.models.registry.require_model", _require_model)
    yield
    if _Service.gate is not None:
        _Service.gate.set()
    for thread in threading.enumerate():
        if thread.name.startswith(("pipeline-job-", "bootstrap-job-", "setup-queue-drain")):
            thread.join(5)


def _episode(parent: Path, name: str) -> Path:
    project = EpisodeProject.create(name, str(parent))
    project.ensure_dirs()
    return save_project(project)


@pytest.fixture
def episodes(tmp_path: Path) -> list[Path]:
    return [_episode(tmp_path / "ws" / name, name) for name in ("one", "two", "three")]


def _enqueue(
    manager: JobManager, project: Path, *, model: str = "small", **kwargs: Any
) -> QueuedRun:
    return manager.enqueue_for_setup(
        project,
        config={"transcribe": {"model": model}},
        from_step=None,
        only_step=None,
        skip_steps=None,
        unattended=True,
        waiting_for=[_missing(model).payload()],
        **{"drain": False, **kwargs},
    )


def _next_start() -> dict[str, Any]:
    return _Service.started.get(timeout=5)


def _sidecar() -> Path:
    return SetupQueue().path


def test_sidecar_is_atomic_json_next_to_recent_projects(episodes: list[Path]) -> None:
    SetupQueue().enqueue(episodes[0], request={"unattended": True}, waiting_for=[WHISPER])
    assert _sidecar() == recent.recent_projects_path().with_name("setup_queue.json")
    data = json.loads(_sidecar().read_text(encoding="utf-8"))
    assert [e["project_path"] for e in data["entries"]] == [str(episodes[0].resolve())]
    assert not list(_sidecar().parent.glob("*.tmp"))


def test_entries_are_fifo_and_one_per_project(episodes: list[Path]) -> None:
    q = SetupQueue()
    first = q.enqueue(episodes[0], request={"n": 1}, waiting_for=[WHISPER])
    second = q.enqueue(episodes[1], request={"n": 2}, waiting_for=[WHISPER])
    assert (first.position, second.position) == (1, 2)
    again = q.enqueue(episodes[0], request={"n": 3}, waiting_for=[WHISPER])
    assert again.position == 1
    entries = q.entries()
    assert [e["project_path"] for e in entries] == [
        str(episodes[0].resolve()),
        str(episodes[1].resolve()),
    ]
    assert entries[0]["request"] == {"n": 3}


def test_a_new_queue_object_reads_what_another_wrote(episodes: list[Path]) -> None:
    SetupQueue().enqueue(episodes[0], request={}, waiting_for=[WHISPER])
    standing = SetupQueue().standing(episodes[0])
    assert standing == {
        "waiting": True,
        "waiting_for": [WHISPER],
        "position": 1,
        "parked": False,
    }
    assert SetupQueue().standing(episodes[1]) == {
        "waiting": False,
        "waiting_for": [],
        "position": None,
        "parked": False,
    }


def test_remove_and_cancel(episodes: list[Path]) -> None:
    q = SetupQueue()
    q.enqueue(episodes[0], request={}, waiting_for=[WHISPER])
    assert q.remove(episodes[0]) is True
    assert q.remove(episodes[0]) is False
    assert q.entries() == []


def test_a_corrupt_sidecar_is_moved_aside_not_overwritten(episodes: list[Path]) -> None:
    _sidecar().parent.mkdir(parents=True, exist_ok=True)
    _sidecar().write_text("{not json", encoding="utf-8")
    q = SetupQueue()
    assert q.entries() == []
    kept = list(_sidecar().parent.glob("setup_queue.json.corrupt*"))
    assert [p.read_text(encoding="utf-8") for p in kept] == ["{not json"]
    q.enqueue(episodes[0], request={}, waiting_for=[WHISPER])
    assert [e["project_path"] for e in q.entries()] == [str(episodes[0].resolve())]


def test_drain_waits_while_the_model_is_missing(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    assert manager.drain_setup_queue() is None
    assert _Service.started.empty()
    assert manager.status(str(episodes[0]))["setup_queue"]["waiting"] is True


def test_drain_starts_the_run_once_the_model_is_installed(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    _Models.installed.add("small")
    job = manager.drain_setup_queue()
    assert job is not None
    assert manager.wait(job, timeout=5).status == "ok", (job.error, job.message)
    started = _next_start()
    assert started["path"] == str(episodes[0].parent.resolve())
    assert started["unattended"] is True
    assert started["config"]["transcribe"]["model"] == "small"
    assert SetupQueue().entries() == []
    assert manager.status(str(episodes[0]))["setup_queue"]["waiting"] is False


def test_the_queued_size_stays_the_size_queued(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    _Models.installed.add("tiny")
    assert manager.drain_setup_queue() is None
    assert SetupQueue().standing(episodes[0])["waiting"] is True


def test_one_episode_at_a_time_in_fifo_order(episodes: list[Path]) -> None:
    manager = JobManager()
    for project in episodes[:3]:
        _enqueue(manager, project)
    _Models.installed.add("small")
    _Service.gate = threading.Event()
    first = manager.drain_setup_queue()
    assert first is not None
    assert _next_start()["path"] == str(episodes[0].parent.resolve())
    assert manager.drain_setup_queue() is None
    assert _Service.started.empty()
    assert [e["project_path"] for e in SetupQueue().entries()] == [
        str(episodes[1].resolve()),
        str(episodes[2].resolve()),
    ]
    _Service.gate.set()
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    assert _next_start()["path"] == str(episodes[2].parent.resolve())


def test_a_blocked_head_does_not_hold_back_a_ready_episode(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    _enqueue(manager, episodes[1], model="tiny")
    _Models.installed.add("tiny")
    job = manager.drain_setup_queue()
    assert job is not None
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    assert [e["project_path"] for e in SetupQueue().entries()] == [str(episodes[0].resolve())]


def test_a_busy_slot_defers_and_the_run_end_drains(episodes: list[Path]) -> None:
    manager = JobManager()
    _Models.installed.add("small")
    _Service.gate = threading.Event()
    blocker = manager.start(episodes[2])
    assert _next_start()["path"] == str(episodes[2].parent.resolve())
    _enqueue(manager, episodes[0])
    assert manager.drain_setup_queue() is None
    assert len(SetupQueue().entries()) == 1
    _Service.gate.set()
    manager.wait(blocker, timeout=5)
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_bootstrap_ok_triggers_the_drain(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])

    def download(*_a: Any, **_k: Any) -> dict[str, Any]:
        _Models.installed.add("small")
        return {"ok": True, "results": {}, "ready": True}

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", download)
    job, _ = manager.start_bootstrap(components=["whisper"], whisper_model="small")
    assert manager.wait(job, timeout=5).status == "ok"
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


@pytest.mark.parametrize("outcome", ["error", "cancelled"])
@pytest.mark.parametrize("installed", [False, True])
def test_a_failed_or_cancelled_download_drains_only_what_it_installed(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch, outcome: str, installed: bool
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])

    def download(*_a: Any, **kwargs: Any) -> dict[str, Any]:
        if installed:
            _Models.installed.add("small")
        if outcome == "cancelled":
            manager.cancel_bootstrap()
            return {"ok": True, "results": {}}
        return {"ok": False, "results": {"rnnoise": {"ok": False, "error": "offline"}}}

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", download)
    job, _ = manager.start_bootstrap(components=["whisper"], whisper_model="small")
    assert manager.wait(job, timeout=5).status == outcome
    if installed:
        assert _next_start()["path"] == str(episodes[0].parent.resolve())
    else:
        _wait_job_threads()
        assert _Service.started.empty()
        assert [e["project_path"] for e in SetupQueue().entries()] == [str(episodes[0].resolve())]


def test_a_restart_drains_what_was_queued(episodes: list[Path]) -> None:
    _enqueue(JobManager(), episodes[0])
    _Models.installed.add("small")
    restarted = JobManager()
    assert restarted.drain_setup_queue() is not None
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_a_deleted_episode_is_dropped(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _enqueue(manager, episodes[1])
    episodes[0].unlink()
    _Models.installed.add("small")
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    assert SetupQueue().entries() == []


def test_a_manual_start_removes_the_entry(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    job = manager.start(episodes[0])
    manager.wait(job, timeout=5)
    assert SetupQueue().entries() == []
    assert _next_start()["path"] == str(episodes[0].parent.resolve())
    assert _Service.started.empty()


def test_a_run_that_loses_its_model_after_the_start_goes_back_to_waiting(
    episodes: list[Path],
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Service.fail_model_needed = True
    job = manager.drain_setup_queue()
    assert job is not None
    manager.wait(job, timeout=5)
    assert job.error_code == "model_needed"
    _wait_job_threads()
    assert SetupQueue().standing(episodes[0])["waiting"] is True
    assert _Service.started.qsize() == 2


def test_enqueue_snapshots_the_config_and_never_overwrites_edited(episodes: list[Path]) -> None:
    manager = JobManager()
    manager.enqueue_for_setup(
        episodes[0],
        config={"transcribe": {"model": "small", "overwrite": True, "overwrite_edited": True}},
        from_step=None,
        only_step=None,
        skip_steps=None,
        unattended=False,
        waiting_for=[WHISPER],
    )
    snapshot = SetupQueue().entries()[0]["request"]["config"]
    assert snapshot["transcribe"]["model"] == "small"
    assert snapshot["transcribe"]["overwrite_edited"] is False
    assert "tighten" in snapshot


def test_status_reports_the_position_behind_the_head(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _enqueue(manager, episodes[1])
    assert manager.status(str(episodes[1]))["setup_queue"] == {
        "waiting": True,
        "waiting_for": [_missing().payload()],
        "position": 2,
        "parked": False,
    }
    assert manager.status()["setup_queue"]["waiting"] is False


def _home_chip(project: Path, jobs: Any = None) -> tuple[str, dict[str, str]]:
    recent.record_recent(project)
    card = next(c for c in recent.recent_project_cards(jobs) if c["path"] == str(project.resolve()))
    return card["stage"], card["chip"]


def test_the_home_card_says_waiting_for_setup(episodes: list[Path]) -> None:
    assert _home_chip(episodes[0])[1]["text"] != "Waiting for setup"
    SetupQueue().enqueue(episodes[0], request={}, waiting_for=[WHISPER])
    assert _home_chip(episodes[0]) == (
        "prepare",
        {"text": "Waiting for setup", "state": "queued"},
    )
    SetupQueue().remove(episodes[0])
    assert _home_chip(episodes[0])[1]["text"] != "Waiting for setup"


def test_the_route_queues_with_202_and_cancel_removes_it(episodes: list[Path]) -> None:
    client = TestClient(create_app())
    res = client.post(
        "/api/pipeline/run", json={"path": str(episodes[0]), "queue_if_models_missing": True}
    )
    assert res.status_code == 202
    body = res.json()
    assert body["queued"] is True
    assert body["position"] == 1
    assert body["waiting_for"][0]["id"] == "whisper"
    status = client.get("/api/pipeline/status").json()
    assert "setup_queue" in status
    cancelled = client.delete("/api/pipeline/queue", params={"path": str(episodes[0])})
    assert cancelled.status_code == 200
    assert cancelled.json() == {"cancelled": True}
    assert SetupQueue().entries() == []
    again = client.delete("/api/pipeline/queue", params={"path": str(episodes[0])})
    assert again.json() == {"cancelled": False}


def test_the_route_status_carries_the_queue_for_the_served_project(episodes: list[Path]) -> None:
    client = TestClient(create_app(served_project=episodes[0]))
    client.post(
        "/api/pipeline/run", json={"path": str(episodes[0]), "queue_if_models_missing": True}
    )
    standing = client.get("/api/pipeline/status").json()["setup_queue"]
    assert standing["waiting"] is True
    assert standing["position"] == 1


def test_host_startup_drains_the_queue(episodes: list[Path]) -> None:
    _enqueue(JobManager(), episodes[0])
    _Models.installed.add("small")
    with TestClient(create_app()):
        assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_a_corrupt_queue_does_not_stop_host_startup(episodes: list[Path]) -> None:
    _sidecar().parent.mkdir(parents=True, exist_ok=True)
    _sidecar().write_text("[1,", encoding="utf-8")
    with TestClient(create_app()) as client:
        assert client.get("/api/pipeline/status").status_code == 200


async def _call(name: str, args: dict[str, Any]) -> Any:
    from mcp.client import Client

    from podcast_mcp.mcp import server as mcp_server

    async with Client(mcp_server.mcp) as client:
        return await client.call_tool(name, args)


@pytest.fixture
def studio(monkeypatch: pytest.MonkeyPatch) -> JobManager:
    from podcast_mcp.services.jobs import manager as jobs_manager

    manager = JobManager()
    monkeypatch.setattr(jobs_manager, "_SHARED_JOBS", manager)
    return manager


@pytest.mark.asyncio
async def test_mcp_pipeline_run_refuses_by_default_when_a_model_is_missing(
    episodes: list[Path], studio: JobManager
) -> None:
    result = await _call(
        "pipeline_run", {"project_path": str(episodes[0]), "use_working_set": False}
    )
    assert result.is_error
    assert result.structured_content["error_code"] == "model_needed"
    assert SetupQueue().entries() == []


@pytest.mark.asyncio
async def test_mcp_pipeline_run_queues_only_when_asked(
    episodes: list[Path], studio: JobManager
) -> None:
    result = await _call(
        "pipeline_run",
        {
            "project_path": str(episodes[0]),
            "use_working_set": False,
            "queue_if_models_missing": True,
        },
    )
    assert not result.is_error
    body = json.loads(result.content[0].text)
    assert body["queued"] is True
    assert body["waiting_for"][0]["id"] == "whisper"
    assert body["message"].startswith("Queued: waiting for setup (Whisper ")
    assert chr(0x2014) not in body["message"]
    assert [e["project_path"] for e in SetupQueue().entries()] == [str(episodes[0].resolve())]


@pytest.mark.asyncio
async def test_mcp_queue_flag_is_ignored_outside_studio(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("podcast_mcp.services.jobs.studio_job_manager", lambda: None)
    result = await _call(
        "pipeline_run",
        {
            "project_path": str(episodes[0]),
            "use_working_set": False,
            "queue_if_models_missing": True,
        },
    )
    assert result.is_error
    assert result.structured_content["error_code"] == "model_needed"
    assert SetupQueue().entries() == []


@pytest.mark.asyncio
async def test_mcp_pipeline_queue_cancel_takes_the_project_off_the_queue(
    episodes: list[Path], studio: JobManager
) -> None:
    _enqueue(studio, episodes[0])
    result = await _call("pipeline_queue_cancel", {"project_path": str(episodes[0])})
    assert json.loads(result.content[0].text) == {"cancelled": True}
    assert SetupQueue().entries() == []
    again = await _call("pipeline_queue_cancel", {"project_path": str(episodes[0])})
    assert json.loads(again.content[0].text) == {"cancelled": False}


def test_the_cli_keeps_refusing_a_run_when_a_model_is_missing(episodes: list[Path]) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    result = CliRunner().invoke(app, ["pipeline", "run", "--project", str(episodes[0])])
    assert result.exit_code != 0
    assert "podcast bootstrap" in result.output
    assert SetupQueue().entries() == []


def _wait_job_threads() -> None:
    while pending := [
        t
        for t in threading.enumerate()
        if t.name.startswith(("pipeline-job-", "setup-queue-drain")) and t.is_alive()
    ]:
        for thread in pending:
            thread.join(5)


def test_a_run_that_loses_its_model_does_not_strand_a_ready_episode(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    _enqueue(manager, episodes[1], model="tiny")
    _Models.installed.update({"small", "tiny"})
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: _Models.installed.discard("small")
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(episodes[0].parent.resolve())
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    _wait_job_threads()
    assert [e["project_path"] for e in SetupQueue().entries()] == [str(episodes[0].resolve())]
    assert _Service.started.empty()


def test_a_requeue_never_overwrites_a_newer_request(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: (
        _Models.installed.discard("small"),
        _enqueue(manager, episodes[0], model="tiny"),
    )
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    (entry,) = SetupQueue().entries()
    assert entry["request"]["config"]["transcribe"]["model"] == "tiny"


def test_a_cancel_during_the_run_is_not_undone_by_the_requeue(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: (
        _Models.installed.discard("small"),
        manager.cancel_setup_queue(episodes[0]),
    )
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    assert SetupQueue().entries() == []


def test_a_requeue_keeps_the_original_position(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    _enqueue(manager, episodes[1], model="tiny")
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: _Models.installed.discard("small")
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    assert [e["project_path"] for e in SetupQueue().entries()] == [
        str(episodes[0].resolve()),
        str(episodes[1].resolve()),
    ]


def test_a_cancel_while_models_are_checked_never_starts_the_run(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Hooks.on_require = lambda _model: manager.cancel_setup_queue(episodes[0])
    assert manager.drain_setup_queue() is None
    assert _Service.started.empty()
    assert SetupQueue().entries() == []


def test_a_cancel_after_the_last_check_still_stops_the_run(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    real_holds = SetupQueue.holds

    def holds_then_cancel(self: SetupQueue, path: Any, token: str) -> bool:
        held = real_holds(self, path, token)
        manager.cancel_setup_queue(episodes[0])
        return held

    monkeypatch.setattr(SetupQueue, "holds", holds_then_cancel)
    job = manager.drain_setup_queue()
    assert job is not None
    assert manager.wait(job, timeout=5).status == "cancelled"
    _wait_job_threads()
    assert _Service.started.empty()
    assert SetupQueue().entries() == []


def test_a_second_drain_while_one_runs_makes_the_first_look_again(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    entered = threading.Event()
    release = threading.Event()

    def block(_model: str) -> None:
        entered.set()
        assert release.wait(5)

    _Hooks.on_require = block
    results: list[Any] = []
    first = threading.Thread(target=lambda: results.append(manager.drain_setup_queue()))
    first.start()
    assert entered.wait(5)
    _Hooks.on_require = None
    _Models.installed.add("small")
    second: list[Any] = []
    caller = threading.Thread(target=lambda: second.append(manager.drain_setup_queue()))
    caller.start()
    caller.join(2)
    assert not caller.is_alive()
    assert second == [None]
    release.set()
    first.join(5)
    assert results[0] is not None
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_a_deleted_episode_never_starts_and_is_dropped(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    episodes[0].unlink()
    assert manager.drain_setup_queue() is None
    assert _Service.started.empty()
    assert SetupQueue().entries() == []


def test_an_episode_on_an_unreachable_volume_is_kept(episodes: list[Path], tmp_path: Path) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    import shutil

    shutil.rmtree(tmp_path / "ws")
    assert manager.drain_setup_queue() is None
    assert [e["project_path"] for e in SetupQueue().entries()] == [str(episodes[0].resolve())]


def test_an_unreadable_episode_is_skipped_without_stopping_the_drain(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _enqueue(manager, episodes[1])
    _Models.installed.add("small")
    real_stat = Path.stat

    def stat(self: Path, *args: Any, **kwargs: Any) -> Any:
        if self == episodes[0].resolve():
            raise PermissionError(13, "denied")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    assert [e["project_path"] for e in SetupQueue().entries()] == [str(episodes[0].resolve())]


def test_the_drain_checks_models_with_the_queued_config(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.ensure_whisper_cached_for_run",
        lambda **kwargs: calls.append(kwargs),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.ensure_word_aligner_for_run",
        lambda config, **kwargs: calls.append({"aligner": True, **kwargs}),
    )
    manager = JobManager()
    _enqueue(manager, episodes[0], model="tiny")
    assert manager.drain_setup_queue() is not None
    assert [c["resolved"] for c in calls] == [True, True]
    assert calls[0]["config"]["transcribe"]["model"] == "tiny"


def test_a_second_corruption_keeps_the_first_copy(episodes: list[Path]) -> None:
    _sidecar().parent.mkdir(parents=True, exist_ok=True)
    for body in ("{first", "{second"):
        _sidecar().write_text(body, encoding="utf-8")
        assert SetupQueue().entries() == []
    kept = sorted(
        p.read_text(encoding="utf-8") for p in _sidecar().parent.glob("setup_queue.json.corrupt*")
    )
    assert kept == ["{first", "{second"]


def test_host_startup_does_not_wait_for_the_drain(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    release = threading.Event()
    entered = threading.Event()

    def slow(self: JobManager) -> None:
        entered.set()
        release.wait(5)

    monkeypatch.setattr(JobManager, "drain_setup_queue_quietly", slow)
    started = time.monotonic()
    try:
        with TestClient(create_app()) as client:
            assert time.monotonic() - started < 3
            assert client.get("/api/pipeline/status").status_code == 200
            assert entered.wait(5)
    finally:
        release.set()


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["force_transcribe", "retime_words"])
async def test_mcp_never_queues_a_confirmed_retranscribe(
    episodes: list[Path], studio: JobManager, flag: str
) -> None:
    result = await _call(
        "pipeline_run",
        {
            "project_path": str(episodes[0]),
            "use_working_set": False,
            "queue_if_models_missing": True,
            flag: True,
        },
    )
    assert result.is_error
    assert result.structured_content["error_code"] == "model_needed"
    assert SetupQueue().entries() == []


def _spawn_counter(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    spawned: list[str] = []
    real = JobManager._spawn

    def counting(self: JobManager, path: Path, **kwargs: Any) -> Any:
        job = real(self, path, **kwargs)
        spawned.append(str(path))
        return job

    monkeypatch.setattr(JobManager, "_spawn", counting)
    return spawned


def test_entries_whose_runs_keep_failing_model_needed_are_parked_not_spun(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _enqueue(manager, episodes[1])
    _Models.installed.add("small")
    _Service.fail_model_needed = True
    assert manager.drain_setup_queue() is not None
    for _ in range(4):
        _next_start()
    _wait_job_threads()
    assert _Service.started.empty()
    assert len(SetupQueue().entries()) == 2

    def download(*_a: Any, **_k: Any) -> dict[str, Any]:
        _Service.fail_model_needed = False
        return {"ok": True, "results": {}, "ready": True}

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", download)
    job, _ = manager.start_bootstrap(components=["whisper"], whisper_model="small")
    assert manager.wait(job, timeout=5).status == "ok"
    assert _next_start()["path"] == str(episodes[0].parent.resolve())
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    _wait_job_threads()
    assert SetupQueue().entries() == []


def test_a_parked_entry_is_not_retried_by_a_run_end(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: _Models.installed.discard("small")
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    blocker = manager.start(episodes[1])
    manager.wait(blocker, timeout=5)
    _next_start()
    _wait_job_threads()
    assert _Service.started.empty()
    assert len(SetupQueue().entries()) == 1


def test_queueing_a_parked_episode_again_unparks_it(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: _Models.installed.discard("small")
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    _Service.fail_dirs = set()
    _Service.on_run = None
    _Models.installed.add("small")
    _enqueue(manager, episodes[0])
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_a_claim_that_cannot_write_parks_the_entry_instead_of_respawning(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    spawned = _spawn_counter(monkeypatch)
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")

    def refuse(*_a: Any, **_k: Any) -> None:
        raise OSError("read-only")

    monkeypatch.setattr("podcast_mcp.services.jobs.setup_queue.write_json_atomic", refuse)
    job = manager.drain_setup_queue()
    assert job is not None
    assert manager.wait(job, timeout=5).status == "error"
    _wait_job_threads()
    assert len(spawned) == 1
    assert _Service.started.empty()
    assert manager.drain_setup_queue() is None
    assert len(spawned) == 1


def test_a_requeue_refused_for_a_newer_entry_does_not_park_it(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    _Models.installed.update({"small", "tiny"})
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}

    def newer(_dir: str) -> None:
        _Service.on_run = None
        _Service.fail_dirs = set()
        _enqueue(manager, episodes[0], model="tiny")

    _Service.on_run = newer
    assert manager.drain_setup_queue() is not None
    _next_start()
    assert _next_start()["path"] == str(episodes[0].parent.resolve())
    _wait_job_threads()
    assert SetupQueue().entries() == []
    assert _key_of(episodes[0]) not in setup_queue_module.PARKED


def test_a_replace_while_models_are_checked_gets_a_fresh_token(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    first = SetupQueue().entries()[0]["token"]
    _Models.installed.add("small")
    _Hooks.on_require = lambda _model: _enqueue(manager, episodes[0], model="tiny")
    assert manager.drain_setup_queue() is None
    assert _Service.started.empty()
    (entry,) = SetupQueue().entries()
    assert entry["token"] != first
    assert entry["request"]["config"]["transcribe"]["model"] == "tiny"


def test_the_drain_also_waits_for_the_noise_model_a_track_chain_needs(
    episodes: list[Path],
) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect, load_project, save_project

    project = load_project(episodes[0])
    project.processing_chains.append(
        ProcessingChain(track_id="t", effects=[ProcessingEffect(effect="arnndn")])
    )
    save_project(project, episodes[0])
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    assert manager.drain_setup_queue() is None
    assert _Service.started.empty()
    _Models.installed.add("rnnoise")
    assert manager.drain_setup_queue() is not None


def test_an_unreadable_parent_is_unknown_not_an_abort(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.jobs.manager import _project_presence

    missing = episodes[0].parent / "gone" / "episode.sharecut"
    real_exists = Path.exists

    def exists(self: Path, *args: Any, **kwargs: Any) -> bool:
        if self == missing.parent.parent:
            raise PermissionError(13, "denied")
        return real_exists(self, *args, **kwargs)

    monkeypatch.setattr(Path, "exists", exists)
    assert _project_presence(missing) == "unknown"


@pytest.mark.asyncio
async def test_mcp_queue_cancel_needs_studio(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    SetupQueue().enqueue(episodes[0], request={}, waiting_for=[WHISPER])
    monkeypatch.setattr("podcast_mcp.services.jobs.studio_job_manager", lambda: None)
    result = await _call("pipeline_queue_cancel", {"project_path": str(episodes[0])})
    assert result.is_error
    assert len(SetupQueue().entries()) == 1


def test_a_model_that_lands_between_the_check_and_the_enqueue_still_starts_the_run(
    episodes: list[Path],
) -> None:
    manager = JobManager()
    _Models.installed.add("small")
    manager.enqueue_for_setup(
        episodes[0],
        config={"transcribe": {"model": "small"}},
        from_step=None,
        only_step=None,
        skip_steps=None,
        unattended=True,
        waiting_for=[_missing().payload()],
    )
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_a_parked_entry_whose_model_arrives_later_starts_at_the_next_run_end(
    episodes: list[Path],
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: _Models.installed.discard("small")
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    _Service.fail_dirs = set()
    _Service.on_run = None
    _Models.installed.add("small")
    other = manager.start(episodes[1])
    manager.wait(other, timeout=5)
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_a_download_that_ends_while_the_slot_is_busy_still_unparks(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.on_run = lambda _dir: _Models.installed.discard("small")
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    _Service.fail_dirs = set()
    _Service.on_run = None
    _Service.gate = threading.Event()
    blocker = manager.start(episodes[1])
    assert _next_start()["path"] == str(episodes[1].parent.resolve())

    def download(*_a: Any, **_k: Any) -> dict[str, Any]:
        _Models.installed.add("small")
        return {"ok": True, "results": {}, "ready": True}

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", download)
    job, _ = manager.start_bootstrap(components=["whisper"], whisper_model="small")
    manager.wait(job, timeout=5)
    assert _Service.started.empty()
    _Service.gate.set()
    manager.wait(blocker, timeout=5)
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_the_drain_names_the_model_that_actually_blocks_the_entry(episodes: list[Path]) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect, load_project, save_project

    project = load_project(episodes[0])
    project.processing_chains.append(
        ProcessingChain(track_id="t", effects=[ProcessingEffect(effect="arnndn")])
    )
    save_project(project, episodes[0])
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    assert manager.drain_setup_queue() is None
    standing = manager.status(str(episodes[0]))["setup_queue"]
    assert [m["id"] for m in standing["waiting_for"]] == ["rnnoise"]


def test_the_enqueue_check_is_the_drain_check(episodes: list[Path]) -> None:
    from podcast_mcp.gui.routes.pipeline_jobs import start_pipeline_job
    from podcast_mcp.models import ProcessingChain, ProcessingEffect, load_project, save_project

    project = load_project(episodes[0])
    project.processing_chains.append(
        ProcessingChain(track_id="t", effects=[ProcessingEffect(effect="arnndn")])
    )
    save_project(project, episodes[0])
    _Models.installed.add("small")
    queued = start_pipeline_job(
        JobManager(),
        episodes[0],
        config={"transcribe": {"model": "small"}},
        from_step=None,
        only_step=None,
        skip_steps=None,
        unattended=True,
        force_transcribe=False,
        overwrite_edited=False,
        retime_words=False,
        queue_on_missing=True,
    )
    assert queued.waiting_for[0]["id"] == "rnnoise"
    assert _Service.started.empty()


def test_a_queued_entry_for_an_unreachable_project_can_be_cancelled(
    episodes: list[Path], tmp_path: Path
) -> None:
    import shutil

    manager = JobManager()
    _enqueue(manager, episodes[0])
    path = str(episodes[0])
    shutil.rmtree(tmp_path / "ws")
    client = TestClient(create_app())
    res = client.delete("/api/pipeline/queue", params={"path": path})
    assert res.status_code == 200
    assert res.json() == {"cancelled": True}
    assert SetupQueue().entries() == []


@pytest.mark.asyncio
async def test_mcp_cancel_of_an_unreachable_project(
    episodes: list[Path], tmp_path: Path, studio: JobManager
) -> None:
    import shutil

    _enqueue(studio, episodes[0])
    path = str(episodes[0])
    shutil.rmtree(tmp_path / "ws")
    result = await _call("pipeline_queue_cancel", {"project_path": path})
    assert json.loads(result.content[0].text) == {"cancelled": True}


def test_one_entrys_queue_error_does_not_stop_the_drain_for_later_entries(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _enqueue(manager, episodes[1])
    _Models.installed.add("small")
    episodes[0].unlink()
    real_remove = SetupQueue.remove

    def remove(self: SetupQueue, path: Any) -> bool:
        if Path(path).resolve() == episodes[0].resolve():
            raise OSError("read-only")
        return real_remove(self, path)

    monkeypatch.setattr(SetupQueue, "remove", remove)
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(episodes[1].parent.resolve())


def test_a_manual_start_takes_the_entry_before_the_run_thread_starts(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    seen: list[int] = []
    real = JobManager._run_job

    def spy(self: JobManager, job: Any) -> Any:
        seen.append(len(SetupQueue().entries()))
        return real(self, job)

    monkeypatch.setattr(JobManager, "_run_job", spy)
    manager.wait(manager.start(episodes[0]), timeout=5)
    assert seen == [0]


def test_a_manual_start_that_is_refused_leaves_the_entry(episodes: list[Path]) -> None:
    from podcast_mcp.services.jobs import JobSlotBusyError

    manager = JobManager()
    _Service.gate = threading.Event()
    manager.start(episodes[1])
    _next_start()
    _enqueue(manager, episodes[0])
    with pytest.raises(JobSlotBusyError):
        manager.start(episodes[0])
    assert [e["project_path"] for e in SetupQueue().entries()] == [str(episodes[0].resolve())]


def test_a_claim_that_cannot_write_ends_as_an_error_not_a_cancel(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    spawned = _spawn_counter(monkeypatch)
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _enqueue(manager, episodes[1])
    _Models.installed.add("small")

    def refuse(self: SetupQueue, *_a: Any, **_k: Any) -> int | None:
        raise OSError("read-only")

    monkeypatch.setattr(SetupQueue, "claim", refuse)
    job = manager.drain_setup_queue()
    assert job is not None
    assert manager.wait(job, timeout=5).status == "error"
    assert "queue" in (job.error or "")
    _wait_job_threads()
    assert len(spawned) == 1
    assert manager._parked[str(episodes[0].resolve())] != ""


def test_a_move_keeps_the_queued_run(episodes: list[Path], tmp_path: Path) -> None:
    from podcast_mcp.services.app.move_project import move_episode_folder

    manager = JobManager()
    _enqueue(manager, episodes[0])
    dest = tmp_path / "elsewhere"
    dest.mkdir()
    result = move_episode_folder(
        episodes[0], str(dest), jobs=manager, caller_client_id=None, serve=lambda _p: None
    )
    _wait_job_threads()
    (entry,) = SetupQueue().entries()
    assert entry["project_path"] == str(result.project_path.resolve())
    _Models.installed.add("small")
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(result.project_path.parent.resolve())


@pytest.mark.asyncio
async def test_mcp_cancel_outside_studio_names_the_code(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("podcast_mcp.services.jobs.studio_job_manager", lambda: None)
    result = await _call("pipeline_queue_cancel", {"project_path": str(episodes[0])})
    assert result.is_error
    assert result.structured_content["error_code"] == "studio_required"


@pytest.mark.asyncio
async def test_mcp_can_read_the_queue_state(episodes: list[Path]) -> None:
    SetupQueue().enqueue(episodes[0], request={}, waiting_for=[WHISPER])
    result = await _call("pipeline_queue_status", {"project_path": str(episodes[0])})
    assert json.loads(result.content[0].text) == {
        "waiting": True,
        "waiting_for": [WHISPER],
        "position": 1,
        "parked": False,
    }


def _key_of(project: Path) -> str:
    return str(project.resolve())


def test_a_failed_take_refuses_the_manual_start_and_leaves_the_entry(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.util.coded_error import CodedValueError

    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    real = SetupQueue.take

    def refuse(self: SetupQueue, *_a: Any) -> Any:
        raise OSError("read-only")

    monkeypatch.setattr(SetupQueue, "take", refuse)
    with pytest.raises(CodedValueError) as refused:
        manager.start(episodes[0])
    assert refused.value.code == "setup_queue_unavailable"
    assert _Service.started.empty()
    assert len(SetupQueue().entries()) == 1
    monkeypatch.setattr(SetupQueue, "take", real)
    manager.wait(manager.start(episodes[0]), timeout=5)
    assert SetupQueue().entries() == []


def test_a_restore_loses_to_a_cancel_made_after_the_take(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    queue_ = SetupQueue()
    taken = queue_.take(episodes[0])
    assert taken is not None
    assert queue_.cancel(episodes[0]) is False
    queue_.restore(*taken)
    assert queue_.entries() == []


def test_a_start_that_cannot_launch_its_thread_puts_the_entry_back(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])

    def refuse(self: threading.Thread) -> None:
        raise RuntimeError("no threads")

    with monkeypatch.context() as patched:
        patched.setattr(threading.Thread, "start", refuse)
        with pytest.raises(RuntimeError):
            manager.start(episodes[0])
    assert len(SetupQueue().entries()) == 1


def test_a_manual_start_refused_for_a_busy_slot_leaves_the_entry_for_the_run_in_it(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.jobs import JobSlotBusyError

    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    entered, release = threading.Event(), threading.Event()
    real = JobManager._run_job

    def hold(self: JobManager, job: Any) -> Any:
        entered.set()
        assert release.wait(5)
        return real(self, job)

    monkeypatch.setattr(JobManager, "_run_job", hold)
    assert manager.drain_setup_queue() is not None
    assert entered.wait(5)
    with pytest.raises(JobSlotBusyError):
        manager.start(episodes[0])
    assert len(SetupQueue().entries()) == 1
    release.set()
    assert _next_start()["path"] == str(episodes[0].parent.resolve())
    _wait_job_threads()
    assert SetupQueue().entries() == []


def test_a_partial_manual_run_keeps_the_queued_run(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    manager.wait(manager.start(episodes[0], only_step="export"), timeout=5)
    assert len(SetupQueue().entries()) == 1


def _move(project: Path, tmp_path: Path, manager: JobManager, **kwargs: Any) -> Any:
    from podcast_mcp.services.app.move_project import move_episode_folder

    dest = tmp_path / "elsewhere"
    dest.mkdir(exist_ok=True)
    return move_episode_folder(
        project,
        str(dest),
        jobs=manager,
        caller_client_id=None,
        **{"serve": lambda _p: None, **kwargs},
    )


def test_a_drain_while_the_folder_moves_does_not_drop_the_entry(
    episodes: list[Path], tmp_path: Path
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    during: list[Any] = []

    def serve(_p: Path) -> None:
        during.append(manager.drain_setup_queue())

    result = _move(episodes[0], tmp_path, manager, serve=serve)
    assert during == [None]
    assert _next_start()["path"] == str(result.project_path.parent.resolve())
    _wait_job_threads()
    assert _Service.started.empty()


def test_a_partial_move_still_follows_the_queued_run(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.app import move_project

    manager = JobManager()
    _enqueue(manager, episodes[0])

    def broken(_p: Path) -> None:
        raise RuntimeError("serve failed")

    real_rename = move_project.os.rename
    calls: list[int] = []

    def no_undo(src: Any, dst: Any) -> None:
        calls.append(1)
        if len(calls) > 1:
            raise OSError("cannot rename back")
        real_rename(src, dst)

    monkeypatch.setattr(move_project.os, "rename", no_undo)
    with pytest.raises(move_project.MovePartial) as partial:
        _move(episodes[0], tmp_path, manager, serve=broken)
    (entry,) = SetupQueue().entries()
    assert entry["project_path"] == str(Path(partial.value.project_path).resolve())


def test_a_move_onto_a_queued_path_leaves_one_entry_and_follows_the_park(
    episodes: list[Path], tmp_path: Path
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    stale = tmp_path / "elsewhere" / episodes[0].parent.name / episodes[0].name
    SetupQueue().enqueue(stale, request={"unattended": True}, waiting_for=[WHISPER])
    token = next(
        e["token"] for e in SetupQueue().entries() if e["project_path"] == _key_of(episodes[0])
    )
    manager._park({"project_path": _key_of(episodes[0]), "token": token})
    setup_queue_module.FAILURES[_key_of(episodes[0])] = 1
    result = _move(episodes[0], tmp_path, manager)
    entries = SetupQueue().entries()
    assert [e["project_path"] for e in entries] == [str(result.project_path.resolve())]
    assert entries[0]["token"] == token
    new_key = str(result.project_path.resolve())
    assert setup_queue_module.PARKED[new_key][0] == token
    assert setup_queue_module.FAILURES[new_key] == 1
    assert _key_of(episodes[0]) not in setup_queue_module.PARKED


def test_a_model_the_validator_cannot_see_parks_until_it_is_installed_out_of_band(
    episodes: list[Path],
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    _Service.fail_dirs = {str(episodes[0].parent.resolve())}
    _Service.fail_with = _missing("speaker", "speaker")
    assert manager.drain_setup_queue() is not None
    _next_start()
    _wait_job_threads()
    assert _Service.started.empty()
    standing = SetupQueue().standing(episodes[0])
    assert standing["waiting"] is True
    assert standing["parked"] is True
    assert setup_queue_module.PARKED[_key_of(episodes[0])][1] is not None
    _Service.fail_dirs = set()
    _Models.installed.add("speaker")
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(episodes[0].parent.resolve())


def test_a_parked_entry_reads_as_parked_in_the_status(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    manager._park(SetupQueue().entries()[0])
    assert manager.status(str(episodes[0]))["setup_queue"]["parked"] is True
    _enqueue(manager, episodes[0])
    assert manager.status(str(episodes[0]))["setup_queue"]["parked"] is False


@pytest.mark.asyncio
async def test_the_mcp_queue_tools_resolve_the_project_without_adopting(
    episodes: list[Path], studio: JobManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.app import ProjectWorkspace

    seen: list[bool] = []
    real = ProjectWorkspace.open.__func__

    def spy(cls: Any, path: Any, **kwargs: Any) -> Any:
        seen.append(kwargs.get("adopt", True))
        return real(cls, path, **kwargs)

    monkeypatch.setattr(ProjectWorkspace, "open", classmethod(spy))
    await _call("pipeline_queue_status", {"project_path": str(episodes[0])})
    await _call("pipeline_queue_cancel", {"project_path": str(episodes[0])})
    assert seen == [False, False]


@pytest.mark.asyncio
async def test_mcp_queueing_checks_rnnoise_like_the_route(
    episodes: list[Path], studio: JobManager
) -> None:
    from podcast_mcp.models import ProcessingChain, ProcessingEffect, load_project

    project = load_project(episodes[0])
    project.processing_chains.append(
        ProcessingChain(track_id="t", effects=[ProcessingEffect(effect="arnndn")])
    )
    save_project(project, episodes[0])
    _Models.installed.add("small")
    result = await _call(
        "pipeline_run",
        {
            "project_path": str(episodes[0]),
            "use_working_set": False,
            "config": {"transcribe": {"model": "small"}},
            "queue_if_models_missing": True,
        },
    )
    body = json.loads(result.content[0].text)
    assert body["queued"] is True
    assert body["waiting_for"][0]["id"] == "rnnoise"
    assert _Service.started.empty()


def _rename_under_guard(old: Path, new_parent: Path, stack: Any) -> Path:
    import os

    new_parent.mkdir(exist_ok=True)
    target = new_parent / old.parent.name
    target.mkdir()
    stack.enter_context(SetupQueue().moving(old)).follow(target / old.name)
    os.rename(old.parent, target)
    return target / old.name


def test_a_drain_that_checked_before_the_move_cannot_remove_the_entry_as_gone(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from contextlib import ExitStack

    from podcast_mcp.services.jobs import manager as jobs_manager

    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    stack = ExitStack()
    moved: list[Path] = []
    real = jobs_manager._project_presence

    def stalled(path: Path) -> str:
        if not moved:
            moved.append(_rename_under_guard(episodes[0], tmp_path / "elsewhere", stack))
        return real(path)

    monkeypatch.setattr(jobs_manager, "_project_presence", stalled)
    assert manager.drain_setup_queue() is None
    (entry,) = SetupQueue().entries()
    assert entry["project_path"] == str(moved[0].resolve())
    stack.close()
    assert _Service.started.empty()


def test_a_run_admitted_before_the_move_leaves_the_entry_and_no_job_behind(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from contextlib import ExitStack

    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    entered, release = threading.Event(), threading.Event()
    real = JobManager._run_job

    def hold(self: JobManager, job: Any) -> Any:
        entered.set()
        assert release.wait(5)
        return real(self, job)

    monkeypatch.setattr(JobManager, "_run_job", hold)
    assert manager.drain_setup_queue() is not None
    assert entered.wait(5)
    stack = ExitStack()
    moved = _rename_under_guard(episodes[0], tmp_path / "elsewhere", stack)
    release.set()
    _wait_job_threads()
    assert _Service.started.empty()
    assert manager._catalog._job is None
    (entry,) = SetupQueue().entries()
    assert entry["project_path"] == str(moved.resolve())
    stack.close()
    monkeypatch.setattr(JobManager, "_run_job", real)
    assert manager.drain_setup_queue() is not None
    assert _next_start()["path"] == str(moved.parent.resolve())


def test_a_run_discarded_after_its_move_ended_starts_at_the_new_path(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from contextlib import ExitStack

    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    entered, release = threading.Event(), threading.Event()
    real = JobManager._run_job

    def hold(self: JobManager, job: Any) -> Any:
        entered.set()
        assert release.wait(5)
        return real(self, job)

    monkeypatch.setattr(JobManager, "_run_job", hold)
    assert manager.drain_setup_queue() is not None
    assert entered.wait(5)
    stack = ExitStack()
    moved = _rename_under_guard(episodes[0], tmp_path / "elsewhere", stack)
    stack.close()
    monkeypatch.setattr(JobManager, "_run_job", real)
    release.set()
    assert _next_start()["path"] == str(moved.parent.resolve())


def test_a_failed_rename_puts_the_entry_back(episodes: list[Path], tmp_path: Path) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    new = tmp_path / "x" / "p.sharecut"
    with pytest.raises(RuntimeError), SetupQueue().moving(episodes[0]) as move:
        move.follow(new)
        (entry,) = SetupQueue().entries()
        assert entry["project_path"] == str(new.resolve())
        raise RuntimeError("rename failed")
    assert [e["project_path"] for e in SetupQueue().entries()] == [_key_of(episodes[0])]
    assert not SetupQueue.is_moving(episodes[0])
    assert not SetupQueue.is_moving(new)


def test_a_rollback_restores_the_entry_it_displaced(episodes: list[Path], tmp_path: Path) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    new = tmp_path / "x" / "p.sharecut"
    SetupQueue().enqueue(new, request={"unattended": True}, waiting_for=[WHISPER])
    with pytest.raises(RuntimeError), SetupQueue().moving(episodes[0]) as move:
        move.follow(new)
        assert len(SetupQueue().entries()) == 1
        raise RuntimeError("rename failed")
    assert sorted(e["project_path"] for e in SetupQueue().entries()) == sorted(
        [_key_of(episodes[0]), str(new.resolve())]
    )


def test_a_move_whose_queue_write_fails_is_refused(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.app.move_project import MoveRefused

    manager = JobManager()
    _enqueue(manager, episodes[0])

    def refuse(*_a: Any, **_k: Any) -> None:
        raise OSError("read-only")

    monkeypatch.setattr(SetupQueue, "_store", refuse)
    with pytest.raises(MoveRefused):
        _move(episodes[0], tmp_path, manager)
    assert episodes[0].exists()
    assert not SetupQueue.is_moving(episodes[0])


def test_a_load_error_at_the_start_of_a_move_does_not_leak_the_mark(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(self: SetupQueue) -> Any:
        raise RuntimeError("bad file")

    monkeypatch.setattr(SetupQueue, "_load", boom)
    with pytest.raises(RuntimeError), SetupQueue().moving(episodes[0]) as move:
        move.follow(tmp_path / "x" / "p.sharecut")
    assert not SetupQueue.is_moving(episodes[0])
    assert not SetupQueue.is_moving(tmp_path / "x" / "p.sharecut")


def test_during_a_move_enqueue_is_refused_cancel_works_by_either_path_and_status_reads_old(
    episodes: list[Path], tmp_path: Path
) -> None:
    from podcast_mcp.util.coded_error import CodedValueError

    manager = JobManager()
    _enqueue(manager, episodes[0])
    new = tmp_path / "x" / "p.sharecut"
    with SetupQueue().moving(episodes[0]) as move:
        move.follow(new)
        assert SetupQueue().standing(episodes[0])["waiting"] is True
        assert SetupQueue().standing(new)["waiting"] is True
        assert _key_of(episodes[0]) in SetupQueue().waiting_paths()
        with pytest.raises(CodedValueError) as refused:
            _enqueue(manager, episodes[0])
        assert refused.value.code == "project_moving"
        with pytest.raises(CodedValueError):
            _enqueue(manager, new)
        assert manager.cancel_setup_queue(episodes[0]) is True
        assert SetupQueue().entries() == []
    _enqueue(manager, episodes[1])
    with SetupQueue().moving(episodes[1]) as move:
        move.follow(tmp_path / "y" / "q.sharecut")
        assert manager.cancel_setup_queue(tmp_path / "y" / "q.sharecut") is True
        assert SetupQueue().entries() == []


def test_a_move_enters_the_guard_before_the_busy_check(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.app import move_project

    manager = JobManager()
    seen: list[bool] = []

    def check(*_a: Any, **_k: Any) -> None:
        seen.append(SetupQueue.is_moving(episodes[0]))

    monkeypatch.setattr(move_project, "_refuse_if_busy", check)
    _move(episodes[0], tmp_path, manager)
    assert seen == [True]


def test_a_restore_does_not_replace_a_newer_entry(episodes: list[Path]) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0], model="small")
    queue_ = SetupQueue()
    taken = queue_.take(episodes[0])
    assert taken is not None
    _enqueue(manager, episodes[0], model="tiny")
    queue_.restore(*taken)
    (entry,) = queue_.entries()
    assert entry["request"]["config"]["transcribe"]["model"] == "tiny"


def test_a_start_that_cannot_launch_its_thread_drains_after_restoring(
    episodes: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[0])
    _Models.installed.add("small")
    drains: list[int] = []
    monkeypatch.setattr(JobManager, "drain_setup_queue_quietly", lambda self: drains.append(1))
    real = threading.Thread.start

    def refuse(self: threading.Thread) -> None:
        if self.name.startswith("pipeline-job-"):
            raise RuntimeError("no threads")
        real(self)

    monkeypatch.setattr(threading.Thread, "start", refuse)
    with pytest.raises(RuntimeError):
        manager.start(episodes[0])
    assert drains == [1]


def test_a_move_starts_a_drain_when_it_ends(
    episodes: list[Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = JobManager()
    _enqueue(manager, episodes[1])
    _Models.installed.add("small")
    result = _move(episodes[0], tmp_path, manager)
    _wait_job_threads()
    assert _next_start()["path"] == str(episodes[1].parent.resolve())
    assert result.project_path.exists()
