from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app.recent_projects import recent_project_cards, record_recent
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.jobs import setup_runs as queue_module
from podcast_mcp.services.jobs.setup_runs import SetupRunQueue
from podcast_mcp.services.pipeline import PipelineService
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
    assert other.waiting(imported_project)


def test_ready_import_keeps_the_existing_immediate_run_path(
    imported_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(queue_module, "_models_ready", lambda _entry: True)
    queue = SetupRunQueue(JobManager(), tmp_path / "setup-runs.json")
    assert queue.enqueue(imported_project) is False
    assert queue.waiting(imported_project) is False


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
