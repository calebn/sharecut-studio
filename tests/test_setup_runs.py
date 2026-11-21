from __future__ import annotations

import errno
import shutil
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.models.whisper import persist_whisper_model
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app.recent_projects import recent_project_cards, record_recent
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.jobs import setup_runs as queue_module
from podcast_mcp.services.jobs.setup_runs import SetupRunQueue
from podcast_mcp.services.pipeline import PipelineService, config_store
from podcast_mcp.util.model_missing import ModelMissing


@pytest.fixture
def imported_project(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.tracks = [
        Track(
            id="host", label="Host", role=TrackRole.DIALOGUE, media=MediaAsset(path="raw/host.wav")
        )
    ]
    project.clips = [
        Clip(id="host-clip", track_id="host", source_start=0, source_end=1, timeline_start=0)
    ]
    save_project(project, minimal_project)
    return minimal_project


def test_import_intent_stays_pending_until_ready_and_starts_without_a_page(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    path = tmp_path / "setup-runs.json"
    queue = SetupRunQueue(jobs, path)
    missing = ModelMissing(
        id="whisper",
        model="small.en",
        label="Transcription",
        purpose="Transcribe audio",
        size="250 MB",
        size_bytes=None,
        command="podcast bootstrap",
        state="missing",
    )
    ready = False
    calls = []

    def require_whisper(**kwargs):
        if not ready:
            raise missing

    def start(project_path, **opts):
        calls.append((project_path, opts))
        return Job(id="first-run", kind="pipeline", status="ok")

    monkeypatch.setattr(queue_module, "ensure_whisper_cached_for_run", require_whisper)
    monkeypatch.setattr(queue_module, "ensure_word_aligner_for_run", lambda *_args, **_kw: None)
    monkeypatch.setattr(jobs, "start", start)
    queue.enqueue(imported_project)
    queue.enqueue(imported_project)

    reopened = SetupRunQueue(jobs, path)
    reopened._dispatch(threading.Event())
    assert reopened.waiting(imported_project)
    assert calls == []
    record_recent(imported_project)
    [card] = recent_project_cards(jobs, waiting_for_setup=reopened.waiting)
    assert card["stage"] == "prepare"
    assert card["chip"]["text"] == "Waiting for setup"

    ready = True
    reopened._dispatch(threading.Event())
    reopened._dispatch(threading.Event())
    assert not queue.waiting(imported_project)
    assert [project_path for project_path, _ in calls] == [imported_project]


def test_setup_queue_waits_for_the_existing_pipeline_slot(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = SetupRunQueue(jobs, tmp_path / "setup-runs.json")
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    queue.enqueue(imported_project)
    jobs._job = Job(
        id="other", kind="pipeline", status="running", project_path=str(tmp_path / "other.sharecut")
    )

    def must_not_check_model(**kwargs):
        pytest.fail("a busy slot must not try to start another episode")

    monkeypatch.setattr(queue_module, "_models_ready", must_not_check_model)
    queue._dispatch(threading.Event())
    assert queue.waiting(imported_project)


def test_setup_run_admission_and_status_share_the_served_episode(
    imported_project: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    app = create_app(served_project=imported_project, host_mcp=False)
    client = TestClient(app, client=("127.0.0.1", 5000))

    assert not client.get("/api/pipeline/status").json().get("waiting_for_setup")
    res = client.post("/api/pipeline/setup-run", json={"path": str(imported_project)})
    assert res.status_code == 202
    assert res.json() == {"queued": True}
    assert client.get("/api/pipeline/status").json()["waiting_for_setup"] is True
    manual = client.post("/api/pipeline/run", json={"path": str(imported_project)})
    assert manual.status_code == 409
    assert manual.headers["x-sharecut-error-code"] == "pipeline_setup_waiting"


def test_pinned_studio_does_not_start_another_hosts_queued_episode(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    path = tmp_path / "setup-runs.json"
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    SetupRunQueue(jobs, path).enqueue(imported_project)
    other = SetupRunQueue(jobs, path, initial_project=tmp_path / "other.sharecut")

    def must_not_start(*args, **kwargs):
        pytest.fail("a different pinned host must not attempt the queued run")

    monkeypatch.setattr(queue_module, "_models_ready", must_not_start)
    other._dispatch(threading.Event())
    assert not other.waiting(imported_project)


def test_pinned_studio_resumes_its_home_import_after_restarting(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    path = tmp_path / "setup-runs.json"
    launch_project = tmp_path / "pinned.sharecut"
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    initial = SetupRunQueue(jobs, path, initial_project=launch_project)
    assert initial.enqueue(imported_project)
    reopened = SetupRunQueue(jobs, path, initial_project=launch_project)
    assert reopened.waiting(imported_project)
    calls = []

    def start(project_path, **_opts):
        calls.append(project_path)
        return Job(id="first-run", kind="pipeline", status="ok")

    monkeypatch.setattr(jobs, "start", start)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    reopened._dispatch(threading.Event())
    assert calls == [imported_project]
    assert not reopened.waiting(imported_project)


def test_studio_without_setup_worker_does_not_project_a_local_queue(
    imported_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    assert SetupRunQueue(JobManager()).enqueue(imported_project)
    record_recent(imported_project)
    app = create_app(served_project=imported_project, bind_host="0.0.0.0", host_mcp=False)
    client = TestClient(app, client=("127.0.0.1", 5000))
    assert not client.get("/api/pipeline/status").json().get("waiting_for_setup")
    [card] = client.get("/api/projects/recent").json()["projects"]
    assert card["chip"]["text"] != "Waiting for setup"
    response = client.post("/api/pipeline/run", json={"path": str(imported_project)})
    assert response.headers.get("x-sharecut-error-code") != "pipeline_setup_waiting"


def test_ready_import_keeps_the_existing_immediate_run_path(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    queue = SetupRunQueue(JobManager(), tmp_path / "setup-runs.json")
    assert queue.enqueue(imported_project) is False
    assert queue.waiting(imported_project) is False


@pytest.mark.parametrize("selection", ["after_import", "downloading", "finished_during_import"])
def test_queued_run_uses_the_new_whisper_variant(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, selection: str
) -> None:
    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "model-cache"))
    persist_whisper_model("large-v3-turbo")
    jobs = JobManager()
    queue = SetupRunQueue(jobs, tmp_path / "setup-runs.json")
    download = Job.bootstrap("alternate-download", ["whisper"], whisper_model="small.en")
    ready = set()
    if selection == "downloading":
        monkeypatch.setattr(jobs, "get_bootstrap_job", lambda: download)
        ready.add("large-v3-turbo")
    elif selection == "finished_during_import":
        config_store().put(imported_project, config={"transcribe": {"model": "large-v3-turbo"}})
        persist_whisper_model("small.en")
        ready.add("small.en")
    used = []

    def start(_path, *, config, **_kwargs):
        used.append(config["transcribe"]["model"])
        return Job(id="first-run", kind="pipeline", status="ok")

    monkeypatch.setattr(jobs, "start", start)
    monkeypatch.setattr(
        queue_module, "_models_ready", lambda entry: entry.config["transcribe"]["model"] in ready
    )
    assert queue.enqueue(imported_project)
    assert queue.waiting(imported_project)
    if selection != "finished_during_import":
        queue._dispatch(threading.Event())
        assert used == []
        assert queue.waiting(imported_project)

    persist_whisper_model("small.en")
    download.status = "ok"
    ready.add("small.en")
    queue._dispatch(threading.Event())
    assert used == ["small.en"]
    assert not queue.waiting(imported_project)


def test_studio_starts_the_waiting_episode_after_the_person_opens_another(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready = threading.Event()
    started = threading.Event()
    opened = []
    monkeypatch.setattr(queue_module, "_POLL_SECONDS", 0.01)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: ready.is_set())

    def run(service, **_kwargs):
        opened.append(service.ws.path)
        started.set()
        return SimpleNamespace(last_step="transcribe_tracks", job_result=dict)

    monkeypatch.setattr(PipelineService, "run", run)
    app = create_app(served_project=imported_project, host_mcp=False)
    other = tmp_path / "other" / "episode.sharecut"
    other.parent.mkdir()
    other.write_bytes(imported_project.read_bytes())
    with TestClient(app, client=("127.0.0.1", 5000)) as client:
        assert client.post(
            "/api/pipeline/setup-run", json={"path": str(imported_project)}
        ).json() == {"queued": True}
        assert not started.is_set()
        assert client.post("/api/project/open", json={"path": str(other)}).status_code == 200
        assert not client.get("/api/pipeline/status").json().get("waiting_for_setup")
        ready.set()
        assert started.wait(3)
        job = app.state.jobs.get_job()
        assert app.state.jobs.wait(job, timeout=3).status == "ok"

    assert opened == [imported_project]


def _failing_start(jobs: JobManager, monkeypatch: pytest.MonkeyPatch, code: str | None) -> list:
    calls: list = []

    def start(project_path, **_opts):
        calls.append(project_path)
        if code is None:
            return Job(id=f"run-{len(calls)}", kind="pipeline", status="ok")
        return Job(id=f"run-{len(calls)}", kind="pipeline", status="error", error_code=code)

    monkeypatch.setattr(jobs, "start", start)
    return calls


def test_a_run_that_keeps_failing_model_needed_is_not_restarted_every_poll(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    path = tmp_path / "setup-runs.json"
    queue = SetupRunQueue(jobs, path)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    queue.enqueue(imported_project)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    calls = _failing_start(jobs, monkeypatch, "model_needed")
    for _ in range(3):
        queue._dispatch(threading.Event())
    assert len(calls) == 1
    assert len(queue._read()) == 1

    SetupRunQueue(jobs, path)._dispatch(threading.Event())
    assert len(calls) == 2


def test_a_parked_run_retries_after_a_studio_download_changes(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = SetupRunQueue(jobs, tmp_path / "setup-runs.json")
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    queue.enqueue(imported_project)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    calls = _failing_start(jobs, monkeypatch, "model_needed")
    download = Job.bootstrap("fetch", ["whisper"], whisper_model="small.en")
    monkeypatch.setattr(jobs, "get_bootstrap_job", lambda: download)
    queue._dispatch(threading.Event())
    queue._dispatch(threading.Event())
    assert len(calls) == 1

    download.status = "ok"
    queue._dispatch(threading.Event())
    queue._dispatch(threading.Event())
    assert len(calls) == 2

    download = Job.bootstrap("fetch-2", ["whisper"], whisper_model="small.en")
    queue._dispatch(threading.Event())
    assert len(calls) == 3

    calls_ok = _failing_start(jobs, monkeypatch, None)
    download = Job.bootstrap("fetch-3", ["whisper"], whisper_model="small.en")
    queue._dispatch(threading.Event())
    assert len(calls_ok) == 1
    assert not queue.waiting(imported_project)


@pytest.mark.parametrize("ready", [True, False])
def test_an_episode_that_is_gone_is_dropped(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ready: bool
) -> None:
    jobs = JobManager()
    queue = SetupRunQueue(jobs, tmp_path / "setup-runs.json")
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    queue.enqueue(imported_project)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: ready)
    calls = _failing_start(jobs, monkeypatch, None)
    imported_project.unlink()
    queue._dispatch(threading.Event())
    assert not queue.waiting(imported_project)
    assert queue._read() == []
    assert calls == []


def test_a_moved_episode_folder_leaves_a_dead_entry_that_never_starts(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = SetupRunQueue(jobs, tmp_path / "setup-runs.json")
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    queue.enqueue(imported_project)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    calls = _failing_start(jobs, monkeypatch, None)
    shutil.move(imported_project.parent, tmp_path / "moved")
    for _ in range(3):
        queue._dispatch(threading.Event())
    assert len(queue._read()) == 1
    assert calls == []


def test_an_unreachable_episode_stays_queued(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = SetupRunQueue(jobs, tmp_path / "setup-runs.json")
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    queue.enqueue(imported_project)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    calls = _failing_start(jobs, monkeypatch, None)

    def unreachable(_path):
        raise OSError(errno.EIO, "Input/output error")

    monkeypatch.setattr(queue_module, "load_project", unreachable)
    queue._dispatch(threading.Event())
    assert queue.waiting(imported_project)
    assert calls == []


def _queued_and_ready(
    jobs: JobManager, path: Path, project: Path, monkeypatch: pytest.MonkeyPatch
) -> SetupRunQueue:
    queue = SetupRunQueue(jobs, path)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    queue.enqueue(project)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    return queue


def test_a_parked_episode_that_is_gone_is_still_dropped(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    _failing_start(jobs, monkeypatch, "model_needed")
    queue._dispatch(threading.Event())
    assert queue._parked
    imported_project.unlink()
    queue._dispatch(threading.Event())
    assert queue._read() == []
    assert queue._parked == {}


def test_a_parked_episode_is_not_reported_as_waiting_and_can_be_run(
    imported_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    started = []
    monkeypatch.setattr(
        PipelineService,
        "run",
        lambda service, **_kw: (
            started.append(service.ws.path)
            or SimpleNamespace(last_step="transcribe_tracks", job_result=dict)
        ),
    )
    app = create_app(served_project=imported_project, host_mcp=False)
    client = TestClient(app, client=("127.0.0.1", 5000))
    assert client.post("/api/pipeline/setup-run", json={"path": str(imported_project)}).json() == {
        "queued": True
    }
    queue = app.state.setup_runs
    assert queue.waiting(imported_project)
    queue._parked[imported_project.resolve()] = queue._model_epoch()
    assert not queue.waiting(imported_project)
    assert not client.get("/api/pipeline/status").json().get("waiting_for_setup")
    res = client.post("/api/pipeline/run", json={"path": str(imported_project)})
    assert res.headers.get("x-sharecut-error-code") != "pipeline_setup_waiting"


def test_a_parked_episode_waits_again_when_a_download_changes(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    _failing_start(jobs, monkeypatch, "model_needed")
    download = Job.bootstrap("fetch", ["whisper"], whisper_model="small.en")
    monkeypatch.setattr(jobs, "get_bootstrap_job", lambda: download)
    queue._dispatch(threading.Event())
    assert not queue.waiting(imported_project)
    download.status = "ok"
    assert queue.waiting(imported_project)


def test_a_run_that_fails_for_another_reason_is_removed(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    calls = _failing_start(jobs, monkeypatch, "pipeline_failed")
    queue._dispatch(threading.Event())
    assert len(calls) == 1
    assert queue._read() == []


def test_the_download_state_is_captured_before_the_run_starts(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    download = Job.bootstrap("fetch", ["whisper"], whisper_model="small.en")
    monkeypatch.setattr(jobs, "get_bootstrap_job", lambda: download)
    calls = []

    def start(project_path, **_opts):
        calls.append(project_path)
        if len(calls) == 1:
            download.status = "ok"
        return Job(
            id=f"run-{len(calls)}", kind="pipeline", status="error", error_code="model_needed"
        )

    monkeypatch.setattr(jobs, "start", start)
    for _ in range(4):
        queue._dispatch(threading.Event())
    assert len(calls) == 2


def test_an_unreadable_project_file_keeps_the_entry(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    calls = _failing_start(jobs, monkeypatch, None)
    imported_project.write_text("not a project")
    queue._dispatch(threading.Event())
    assert queue.waiting(imported_project)
    assert calls == []


def test_enqueueing_again_clears_the_park(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    calls = _failing_start(jobs, monkeypatch, "model_needed")
    queue._dispatch(threading.Event())
    assert queue.enqueue(imported_project)
    queue._dispatch(threading.Event())
    assert len(calls) == 2


def test_a_parked_episode_that_is_now_transcribed_is_removed(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    calls = _failing_start(jobs, monkeypatch, "model_needed")
    queue._dispatch(threading.Event())
    assert queue._parked
    monkeypatch.setattr(queue_module, "_needs_transcription", lambda _project: False)
    queue._dispatch(threading.Event())
    assert queue._read() == []
    assert queue._parked == {}
    download = Job.bootstrap("fetch", ["whisper"], whisper_model="small.en")
    monkeypatch.setattr(jobs, "get_bootstrap_job", lambda: download)
    assert not queue.waiting(imported_project)
    assert len(calls) == 1


def test_an_unmounted_volume_keeps_the_run_until_it_is_back(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    episode = tmp_path / "volume" / "library" / "episode.sharecut"
    episode.parent.mkdir(parents=True)
    shutil.copy(imported_project, episode)
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", episode, monkeypatch)
    calls = _failing_start(jobs, monkeypatch, None)
    saved = episode.read_bytes()
    shutil.rmtree(tmp_path / "volume" / "library")
    queue._dispatch(threading.Event())
    assert queue.waiting(episode)
    assert calls == []

    episode.parent.mkdir()
    episode.write_bytes(saved)
    queue._dispatch(threading.Event())
    assert calls == [episode]
    assert queue._read() == []


def test_a_project_file_deleted_from_a_reachable_folder_is_dropped(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    episode = tmp_path / "volume" / "library" / "episode.sharecut"
    episode.parent.mkdir(parents=True)
    shutil.copy(imported_project, episode)
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", episode, monkeypatch)
    episode.unlink()
    queue._dispatch(threading.Event())
    assert queue._read() == []


def test_a_replaced_episode_is_dropped_while_models_are_missing(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs = JobManager()
    queue = _queued_and_ready(jobs, tmp_path / "setup-runs.json", imported_project, monkeypatch)
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: False)
    project = load_project(imported_project)
    project.meta.created_at = "2001-01-01T00:00:00Z"
    save_project(project, imported_project)
    queue._dispatch(threading.Event())
    assert queue._read() == []
