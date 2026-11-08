"""A model failure inside a Studio job reaches the host snapshot as ``model_needed`` (#2046)."""

from __future__ import annotations

import asyncio
import copy
import json
import threading
from pathlib import Path
from typing import Any, ClassVar

import pytest

from model_pin_helpers import isolate_model_env
from podcast_mcp.engines.speaker_id import SpeakerModelMissing
from podcast_mcp.gui.job_events import stream_job_events
from podcast_mcp.models import (
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import runner
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.jobs import (
    GUEST_RENDER_KINDS,
    AgentJobFanInReporter,
    Job,
    JobManager,
    guest_job_view,
)
from podcast_mcp.services.support.diagnostics import _sanitize_job_snapshots
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import bind_progress, progress_task

COMMAND = "podcast bootstrap --component rnnoise"
MODEL_FIELDS = {
    "id",
    "model",
    "label",
    "purpose",
    "size",
    "size_bytes",
    "command",
    "state",
}


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    isolate_model_env(monkeypatch, tmp_path)
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(tmp_path / "models" / "rnnoise.rnnn"))


def _missing() -> ModelMissing:
    return ModelMissing(
        id="rnnoise",
        model="rnnoise",
        label="RNNoise",
        purpose="noise reduction",
        size="~2 MB",
        size_bytes=2_000_000,
        command=COMMAND,
        state="missing",
    )


def _raise(exc: Exception) -> Any:
    def boom(self: object, *args: object, **kwargs: object) -> None:
        raise exc

    return boom


def _run(mgr: JobManager, job: Job) -> dict[str, Any]:
    mgr.wait(job, timeout=5)
    return job.snapshot()


def _assert_model_needed(snap: dict[str, Any], project: Path) -> None:
    assert snap["status"] == "error"
    assert snap["error_code"] == "model_needed"
    assert set(snap["error_model"]) == MODEL_FIELDS
    assert snap["error_model"]["id"] == "rnnoise"
    model = snap["error_model"]
    assert snap["error"] == snap["message"] == f"{model['label']} is not downloaded."
    assert model["command"] == COMMAND
    assert "bootstrap" not in repr([snap["error"], snap["message"], snap["steps"]])
    failure = (snap["error"], snap["message"], snap["error_model"])
    assert str(project.parent) not in repr(failure)


def test_export_failure_carries_the_model(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio", _raise(_missing())
    )
    mgr = JobManager()
    _assert_model_needed(_run(mgr, mgr.start_export(minimal_project)), minimal_project)


def test_bounce_failure_carries_the_model(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.media.bounce.BounceService.validate", lambda self, req=None: []
    )
    monkeypatch.setattr(
        "podcast_mcp.services.media.bounce.BounceService.bounce", _raise(_missing())
    )
    mgr = JobManager()
    _assert_model_needed(
        _run(mgr, mgr.start_bounce(minimal_project, formats=["wav"])), minimal_project
    )


def test_pipeline_step_failure_carries_the_model(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", _raise(_missing()))
    mgr = JobManager()
    _assert_model_needed(_run(mgr, mgr.start(minimal_project)), minimal_project)


def test_split_worker_failure_carries_the_speaker_model(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.SpeakerService.check_split",
        lambda self, *a, **k: None,
        raising=False,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.SpeakerService.split_speakers",
        _raise(
            SpeakerModelMissing(
                id="speaker-ecapa",
                model="ecapa",
                label="Speaker model",
                purpose="speaker labels",
                size="~25 MB",
                size_bytes=25_000_000,
                command="podcast bootstrap --component speaker-ecapa",
                state="missing",
            )
        ),
    )
    mgr = JobManager()
    snap = _run(mgr, mgr.start_split_speakers(minimal_project, track_id="host", speaker_count=2))
    assert snap["error_code"] == "model_needed"
    assert snap["error_model"]["id"] == "speaker-ecapa"


def test_render_preview_with_an_arnndn_chain_and_no_model(minimal_project: Path) -> None:
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.processing_chains = [
        ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="arnndn", params={})])
    ]
    save_project(proj, minimal_project)
    mgr = JobManager()
    job = mgr.start_render_preview(minimal_project)
    snap = _run(mgr, job)
    _assert_model_needed(snap, minimal_project)
    row = next(r for r in mgr.status()["jobs"] if r["id"] == job.id)
    assert row["error_code"] == "model_needed"
    assert row["error_model"]["command"] == COMMAND


def test_the_sse_done_frame_carries_both_fields(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio", _raise(_missing())
    )
    mgr = JobManager()
    job = mgr.start_export(minimal_project)
    mgr.wait(job, timeout=5)

    async def frames() -> list[dict[str, Any]]:
        return [json.loads(f.removeprefix("data: ")) async for f in stream_job_events(job)]

    done = asyncio.run(frames())[-1]
    assert done["type"] == "done"
    assert done["job"]["error_code"] == "model_needed"
    assert set(done["job"]["error_model"]) == MODEL_FIELDS


def test_an_ordinary_error_has_no_code(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio",
        _raise(RuntimeError("disk full")),
    )
    mgr = JobManager()
    snap = _run(mgr, mgr.start_export(minimal_project))
    assert snap["status"] == "error"
    assert (snap["error_code"], snap["error_model"]) == (None, None)


def test_a_coded_error_keeps_its_code_without_a_model(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio",
        _raise(CodedError("no mix yet", code="no_mix")),
    )
    mgr = JobManager()
    snap = _run(mgr, mgr.start_export(minimal_project))
    assert (snap["error_code"], snap["error_model"]) == ("no_mix", None)


def test_a_cancelled_job_carries_neither(minimal_project: Path, monkeypatch) -> None:
    mgr = JobManager()

    def cancel_then_fail(self: object, *args: object, **kwargs: object) -> None:
        mgr.cancel()
        raise _missing()

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio", cancel_then_fail
    )
    snap = _run(mgr, mgr.start_export(minimal_project))
    assert snap["status"] == "cancelled"
    assert (snap["error_code"], snap["error_model"]) == (None, None)


def test_an_ok_job_carries_neither(minimal_project: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.media.bounce.BounceService.validate", lambda self, req=None: []
    )
    monkeypatch.setattr(
        "podcast_mcp.services.media.bounce.BounceService.bounce", lambda self, req=None, **_k: []
    )
    mgr = JobManager()
    snap = _run(mgr, mgr.start_bounce(minimal_project, formats=["wav"]))
    assert (snap["status"], snap["error_code"], snap["error_model"]) == ("ok", None, None)


def test_guest_and_diagnostics_views_never_carry_the_model(
    minimal_project: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview", _raise(_missing())
    )
    mgr = JobManager()
    job = mgr.start_render_preview(minimal_project)
    snap = _run(mgr, job)
    assert snap["error_code"] == "model_needed"
    guest = guest_job_view(job, minimal_project, GUEST_RENDER_KINDS)
    assert guest == {
        "id": job.id,
        "status": "error",
        "current": snap["current"],
        "total": snap["total"],
        "message": None,
        "error": "Render preview failed",
    }
    rows = _sanitize_job_snapshots([snap], home=minimal_project.parent, workspace=None)
    assert set(rows[0]) == {"kind", "status", "phase", "elapsed_sec", "message"}
    assert "error_model" not in repr(rows)


def test_an_update_needed_model_reads_as_needing_an_update(
    minimal_project: Path, monkeypatch
) -> None:
    exc = _missing()
    exc.state = "update_needed"
    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", _raise(exc))
    mgr = JobManager()
    snap = _run(mgr, mgr.start(minimal_project))
    assert snap["error"] == snap["message"] == "RNNoise needs an update."
    assert snap["error_model"]["state"] == "update_needed"


def test_the_mcp_run_keeps_the_command_in_its_refusal(minimal_project: Path, monkeypatch) -> None:
    from unittest.mock import patch

    from podcast_mcp.mcp.tools.pipeline import pipeline_run

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", _raise(_missing()))
    mgr = JobManager()
    with (
        patch("podcast_mcp.services.jobs.studio_job_manager", return_value=mgr),
        patch("podcast_mcp.mcp.tools.pipeline.ensure_whisper_cached_for_run"),
        patch("podcast_mcp.mcp.tools.pipeline.ensure_word_aligner_for_run"),
        pytest.raises(ModelMissing) as caught,
    ):
        pipeline_run(str(minimal_project), use_working_set=False)
    assert COMMAND in str(caught.value)


def _frames(monkeypatch) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.job.publish_job_event",
        lambda _job_id, event: seen.append(json.loads(json.dumps(event))),
    )
    return seen


def _assert_plain_everywhere(snap: dict[str, Any], frames: list[dict[str, Any]]) -> None:
    assert any(f["type"] == "progress" for f in frames)
    shown = [snap["error"], snap["message"], [s["error"] for s in snap["steps"]]]
    shown += [
        {k: v for k, v in f["job"].items() if k != "error_model"} for f in frames if "job" in f
    ]
    assert "bootstrap" not in repr(shown)


def test_an_export_failing_in_its_progress_task_never_publishes_the_command(
    minimal_project: Path, monkeypatch
) -> None:
    frames = _frames(monkeypatch)
    monkeypatch.setattr(
        "podcast_mcp.pipeline.steps.ensure_current_master",
        _raise(_missing()),
    )
    mgr = JobManager()
    snap = _run(mgr, mgr.start_export(minimal_project))
    _assert_model_needed(snap, minimal_project)
    _assert_plain_everywhere(snap, frames)


def test_a_render_preview_failing_in_its_progress_task_never_publishes_the_command(
    minimal_project: Path, monkeypatch
) -> None:
    frames = _frames(monkeypatch)
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.processing_chains = [
        ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="arnndn", params={})])
    ]
    save_project(proj, minimal_project)
    mgr = JobManager()
    snap = _run(mgr, mgr.start_render_preview(minimal_project))
    _assert_model_needed(snap, minimal_project)
    _assert_plain_everywhere(snap, frames)


def test_a_pipeline_step_failing_keeps_its_step_error_plain(
    minimal_project: Path, monkeypatch
) -> None:
    frames = _frames(monkeypatch)
    monkeypatch.setitem(runner._STEP_MAP, "normalize", _raise(_missing()))
    mgr = JobManager()
    snap = _run(mgr, mgr.start(minimal_project, only_step="normalize"))
    _assert_model_needed(snap, minimal_project)
    assert snap["steps"][-1]["error"].endswith("is not downloaded.")
    _assert_plain_everywhere(snap, frames)


def test_an_agent_job_failing_with_a_model_refusal_is_plain() -> None:
    mgr = JobManager()
    sink = AgentJobFanInReporter(mgr)
    with (
        pytest.raises(ModelMissing),
        bind_progress(sink),
        progress_task("transcribe", "Transcribe", reporter=sink) as task,
    ):
        task.advance(1, message="Working")
        raise _missing()
    job = sink._job
    assert job is not None
    snap = job.snapshot()
    assert snap["status"] == "error"
    assert "bootstrap" not in repr([snap["message"], snap["error"]])
    assert snap["error"].endswith("RNNoise is not downloaded.")


@pytest.fixture
def empty_project(tmp_path: Path) -> Path:
    project = EpisodeProject.create("retry-contract", str(tmp_path))
    project.ensure_dirs()
    project.transcript_data.per_track = [
        Transcript(track_id="voice", words=[TranscriptWord(text="source", start=0, end=1)])
    ]
    return save_project(project)


def _missing_model() -> ModelMissing:
    return ModelMissing(
        id="fixture-model",
        model="fixture/model",
        label="fixture model",
        purpose="pipeline",
        size="1 MB",
        size_bytes=1,
        command="download-model fixture/model",
        state="missing",
    )


def _wait_terminal(manager: JobManager, job: Any) -> Any:
    return manager.wait(job, timeout=5)


def _transcript_text(path: Path) -> str:
    project = ProjectWorkspace.open(path).project
    return project.transcripts[0].words[0].text


def test_retry_replays_captured_options_without_exposing_them(empty_project, pipeline_worker):
    manager, runner_calls, entered = pipeline_worker
    supplied = {
        "transcribe": {"overwrite": True, "overwrite_edited": True},
    }
    original = manager.start(
        empty_project,
        from_step="transcribe_tracks",
        only_step="transcribe_tracks",
        skip_steps=["export_deliverables"],
        unattended=True,
        config=supplied,
    )
    supplied["transcribe"]["overwrite_edited"] = False
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    assert original.status == "error"
    assert original.error_code == "model_needed"

    original_snapshot = original.snapshot()
    assert "config" not in original_snapshot
    assert "retry_intent" not in original_snapshot
    assert "loaded_file_revision" not in original_snapshot

    successor = manager.retry_pipeline(Path(empty_project), original.id)
    _wait_terminal(manager, successor)
    assert successor.status == "ok", successor.snapshot()
    assert successor.snapshot()["retry_of"] == original.id
    from podcast_mcp.services.jobs import GUEST_PIPELINE_KINDS

    assert "retry_of" not in guest_job_view(successor, empty_project, GUEST_PIPELINE_KINDS)
    assert successor.project_path == original.project_path
    assert runner_calls[0]["options"] == runner_calls[1]["options"]
    assert runner_calls[1]["options"]["from_step"] == "transcribe_tracks"
    assert runner_calls[1]["options"]["only_step"] == "transcribe_tracks"
    assert runner_calls[1]["options"]["skip_steps"] == ["export_deliverables"]
    assert runner_calls[1]["options"]["unattended"] is True
    assert runner_calls[1]["options"]["config"]["transcribe"]["overwrite"] is True
    assert runner_calls[1]["options"]["config"]["transcribe"]["overwrite_edited"] is True
    assert "config" not in successor.snapshot()


def test_retry_of_config_none_uses_captured_effective_config(
    empty_project, pipeline_worker, monkeypatch
):
    from podcast_mcp.services.pipeline import service as service_module

    manager, runner_calls, entered = pipeline_worker
    staged = {"transcribe": {"model": "tiny"}}
    later = {"transcribe": {"model": "base"}}
    monkeypatch.setattr(
        service_module.PipelineService, "_run_defaults", lambda self: copy.deepcopy(staged)
    )
    original = manager.start(empty_project, config=None)
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    staged.clear()
    staged.update(later)

    successor = manager.retry_pipeline(Path(empty_project), original.id)
    _wait_terminal(manager, successor)
    assert successor.status == "ok", successor.snapshot()
    assert runner_calls[0]["options"]["config"]["transcribe"]["model"] == "tiny"
    assert runner_calls[1]["options"]["config"]["transcribe"]["model"] == "tiny"


def test_retry_preserves_retime_consent(empty_project, pipeline_worker):
    manager, runner_calls, entered = pipeline_worker
    options = {"transcribe": {"retime_words": True, "overwrite_edited": True}}
    original = manager.start(empty_project, config=options)
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)

    successor = manager.retry_pipeline(Path(empty_project), original.id)
    _wait_terminal(manager, successor)
    assert successor.status == "ok", successor.snapshot()
    assert runner_calls[1]["options"]["config"]["transcribe"]["retime_words"] is True
    assert runner_calls[1]["options"]["config"]["transcribe"]["overwrite_edited"] is True


def test_normal_progress_save_does_not_expire_retry_intent(empty_project, pipeline_worker):
    manager, runner_calls, entered = pipeline_worker
    _FakeRunner.before_first_failure = lambda persist: persist()
    original = manager.start(empty_project, from_step="clean_audio", only_step="clean_audio")
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    assert original.error_code == "model_needed"

    successor = manager.retry_pipeline(Path(empty_project), original.id)
    _wait_terminal(manager, successor)
    assert successor.status == "ok", successor.snapshot()
    assert len(runner_calls) == 2
    assert runner_calls[0]["options"] == runner_calls[1]["options"]


@pytest.mark.parametrize("mode", ["overwrite", "retime_words"])
def test_retry_rejects_foreign_saved_transcript_change_without_overwriting(
    empty_project, pipeline_worker, mode
):
    manager, _, entered = pipeline_worker
    _FakeRunner.own_progress = True
    editor = ProjectWorkspace.open(empty_project)

    def accept_hand_edit(persist):
        with editor.transaction():
            editor.project.transcripts[0].words[0].text = "hand corrected"
            editor.checkpoint()
            editor.save_merged(history_label="human correction")
        persist()

    _FakeRunner.before_first_failure = accept_hand_edit
    original = manager.start(
        empty_project, config={"transcribe": {mode: True, "overwrite_edited": True}}
    )
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    assert _transcript_text(empty_project) == "hand corrected"

    with pytest.raises(Exception) as refusal:
        manager.retry_pipeline(Path(empty_project), original.id)
    assert getattr(refusal.value, "code", None) == "pipeline_retry_stale"
    assert _transcript_text(empty_project) == "hand corrected"


@pytest.mark.parametrize("mode", ["overwrite", "retime_words"])
@pytest.mark.parametrize("injection", ["workspace_open", "preflight"])
@pytest.mark.parametrize("edit_target", ["transcript", "project_name"])
def test_initial_checkpoint_adoption_preserves_retry_consent_boundary(
    empty_project, pipeline_worker, monkeypatch, mode, injection, edit_target
):
    manager, calls, entered = pipeline_worker
    open_workspace = ProjectWorkspace.open.__func__
    worker_workspace = None
    edited = False
    observed = []

    def commit_foreign_edit():
        nonlocal edited
        assert worker_workspace is not None
        assert worker_workspace.project.transcripts[0].words[0].text == "source"
        editor = open_workspace(ProjectWorkspace, empty_project)
        with editor.transaction():
            if edit_target == "transcript":
                editor.project.transcripts[0].words[0].text = "new human correction"
            else:
                editor.project.name = "renamed by human"
            editor.save()
        edited = True

    def open_then_edit(cls, path, **kwargs):
        nonlocal worker_workspace
        workspace = open_workspace(cls, path, **kwargs)
        if worker_workspace is None:
            worker_workspace = workspace
            if injection == "workspace_open":
                commit_foreign_edit()
        return workspace

    def preflight(*args, **kwargs):
        if injection == "preflight" and not edited:
            commit_foreign_edit()

    def observe_adoption(persist):
        assert edited
        assert worker_workspace is not None
        observed.append(
            (
                worker_workspace.project.transcripts[0].words[0].text,
                worker_workspace.project.name,
            )
        )
        persist()

    monkeypatch.setattr(ProjectWorkspace, "open", classmethod(open_then_edit))
    monkeypatch.setattr("podcast_mcp.engines.models.registry.require_model", preflight)
    _FakeRunner.before_first_failure = observe_adoption
    original = manager.start(
        empty_project, config={"transcribe": {mode: True, "overwrite_edited": True}}
    )
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)
    assert original.status == "error", original.snapshot()
    assert original.error_code == "model_needed"
    assert len(calls) == 1

    if edit_target == "transcript":
        assert observed == [("new human correction", "retry-contract")]
        assert _transcript_text(empty_project) == "new human correction"
        try:
            unexpected = manager.retry_pipeline(empty_project, original.id)
        except CodedError as stale:
            assert stale.code == "pipeline_retry_stale"
        else:
            manager.wait(unexpected, timeout=5)
            pytest.fail("The retained retry accepted a newly adopted human correction")
        assert manager.get_job().id == original.id
        assert len(calls) == 1
        assert _transcript_text(empty_project) == "new human correction"
    else:
        assert observed == [("source", "renamed by human")]
        successor = manager.retry_pipeline(empty_project, original.id)
        manager.wait(successor, timeout=5)
        assert successor.status == "ok", successor.snapshot()
        assert successor.snapshot()["retry_of"] == original.id
        assert len(calls) == 2
        assert calls[0]["options"] == calls[1]["options"]
        saved = ProjectWorkspace.open(empty_project).project
        assert saved.name == "renamed by human"
        assert saved.transcripts[0].words[0].text == "source"


def test_retry_duplicate_returns_same_successor_after_fast_completion(
    empty_project, pipeline_worker
):
    manager, runner_calls, entered = pipeline_worker
    original = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    accepted = manager.retry_pipeline(Path(empty_project), original.id)
    _wait_terminal(manager, accepted)

    repeated = manager.retry_pipeline(Path(empty_project), original.id)
    assert repeated.id == accepted.id
    assert len(runner_calls) == 2


def test_concurrent_retry_requests_publish_one_successor(empty_project, pipeline_worker):
    manager, runner_calls, entered = pipeline_worker
    original = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    barrier = threading.Barrier(3)
    results: list[Any] = []
    errors: list[BaseException] = []

    def retry() -> None:
        try:
            barrier.wait(timeout=5)
            results.append(manager.retry_pipeline(Path(empty_project), original.id))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=retry), threading.Thread(target=retry)]
    for thread in threads:
        thread.start()
    barrier.wait(timeout=5)
    for thread in threads:
        thread.join(timeout=5)
        assert not thread.is_alive()
    assert errors == []
    assert len({job.id for job in results}) == 1
    _wait_terminal(manager, results[0])
    assert len(runner_calls) == 2


def test_busy_refusal_does_not_consume_original_retry(empty_project, pipeline_worker):
    manager, _, entered = pipeline_worker
    original = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    other_project = empty_project.parent / "other"
    other_project.mkdir()
    other_path = save_project(EpisodeProject.create("other", str(other_project)))
    release_blocker = threading.Event()
    _FakeRunner.block_next = release_blocker
    blocker = manager.start(other_path)
    assert _FakeRunner.blocker_entered.wait(5)
    with pytest.raises(Exception) as busy:
        manager.retry_pipeline(Path(empty_project), original.id)
    assert getattr(busy.value, "code", None) == "job_running"

    release_blocker.set()
    _wait_terminal(manager, blocker)
    successor = manager.retry_pipeline(Path(empty_project), original.id)
    assert successor.project_path == str(Path(empty_project).resolve())


def test_retry_rejects_wrong_project_and_non_pipeline_jobs(empty_project, pipeline_worker):
    manager, _, entered = pipeline_worker
    original = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, original)
    wrong_path = empty_project.parent / "different.project"
    with pytest.raises(Exception) as wrong_scope:
        manager.retry_pipeline(wrong_path, original.id)
    assert getattr(wrong_scope.value, "code", None) == "pipeline_retry_unavailable"

    from podcast_mcp.services.jobs.job import Job

    render = Job(
        id="render-job", project_path=str(Path(empty_project).resolve()), kind="render_preview"
    )
    render.status = "error"
    manager._job = render
    with pytest.raises(Exception) as wrong_kind:
        manager.retry_pipeline(Path(empty_project), render.id)
    assert getattr(wrong_kind.value, "code", None) == "pipeline_retry_unavailable"


def test_retry_requires_model_needed_terminal_failure(empty_project, pipeline_worker):
    manager, _, entered = pipeline_worker
    job = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    _wait_terminal(manager, job)
    assert job.status == "error"
    assert job.error_code == "model_needed"
    successor = manager.retry_pipeline(Path(empty_project), job.id)
    _wait_terminal(manager, successor)
    assert successor.status == "ok", successor.snapshot()


@pytest.fixture
def pipeline_worker(monkeypatch):

    monkeypatch.setattr("podcast_mcp.services.pipeline.service.PipelineRunner", _FakeRunner)
    monkeypatch.setattr(
        "podcast_mcp.engines.models.registry.require_model", lambda *args, **kwargs: None
    )
    manager = JobManager()
    _FakeRunner.calls = []
    _FakeRunner.fail_first = True
    _FakeRunner.entered = threading.Event()
    _FakeRunner.blocker_entered = threading.Event()
    _FakeRunner.block_next = None
    _FakeRunner.before_first_failure = None
    _FakeRunner.own_progress = False
    yield manager, _FakeRunner.calls, _FakeRunner.entered


class _FakeRunner:
    calls: ClassVar[list[dict[str, Any]]] = []
    fail_first = True
    own_progress = False
    entered = threading.Event()
    blocker_entered = threading.Event()
    block_next: threading.Event | None = None
    before_first_failure: Any = None

    def __init__(self, *, defaults: dict[str, Any]) -> None:
        self.defaults = copy.deepcopy(defaults)

    def run(self, project, **kwargs):
        options = {
            "from_step": kwargs.get("from_step"),
            "only_step": kwargs.get("only_step"),
            "skip_steps": kwargs.get("skip_steps"),
            "unattended": kwargs.get("unattended"),
            "config": copy.deepcopy(self.defaults),
        }
        type(self).calls.append({"options": options})
        type(self).entered.set()
        if type(self).block_next is not None:
            type(self).blocker_entered.set()
            assert type(self).block_next.wait(5), "blocked fake runner was not released"
            type(self).block_next = None
        if type(self).fail_first:
            type(self).fail_first = False
            if type(self).own_progress:
                project.transcripts[0].words[0].text = "machine progress"
                kwargs["persist"]()
            if type(self).before_first_failure is not None:
                type(self).before_first_failure(kwargs["persist"])
                type(self).before_first_failure = None
            raise _missing_model()
        kwargs["persist"]()
        return type("RunResult", (), {"last_step": "transcribe_tracks", "steps": []})()


def test_retry_worker_rechecks_revision_before_its_first_write(
    empty_project, pipeline_worker, monkeypatch
):
    manager, calls, entered = pipeline_worker
    original = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)
    open_workspace = ProjectWorkspace.open.__func__
    armed = True

    def open_then_edit(cls, path, **kwargs):
        nonlocal armed
        workspace = open_workspace(cls, path, **kwargs)
        if armed:
            armed = False
            editor = open_workspace(cls, path)
            with editor.transaction():
                editor.project.transcripts[0].words[0].text = "changed after admission"
                editor.save()
        return workspace

    monkeypatch.setattr(ProjectWorkspace, "open", classmethod(open_then_edit))
    successor = manager.retry_pipeline(empty_project, original.id)
    manager.wait(successor, timeout=5)
    assert successor.status == "error"
    assert successor.error_code == "pipeline_retry_stale"
    assert len(calls) == 1
    assert _transcript_text(empty_project) == "changed after admission"


def test_retry_does_not_resolve_defaults_again(empty_project, pipeline_worker, monkeypatch):
    manager, calls, entered = pipeline_worker
    original = manager.start(empty_project, config={"transcribe": {"overwrite": True}})
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)

    def unexpected_resolution(*args, **kwargs):
        pytest.fail("retry re-resolved the original effective configuration")

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.config.merge_pipeline_config", unexpected_resolution
    )
    successor = manager.retry_pipeline(empty_project, original.id)
    manager.wait(successor, timeout=5)
    assert successor.status == "ok", successor.snapshot()
    assert calls[0]["options"] == calls[1]["options"]


@pytest.mark.parametrize(
    "code,status", [("pipeline_retry_unavailable", 404), ("pipeline_retry_stale", 409)]
)
def test_host_retry_route_preserves_refusal_code(empty_project, monkeypatch, code, status):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.util.coded_error import CodedValueError

    app = create_app(served_project=empty_project)

    def refused(path, job_id):
        assert path == empty_project
        assert job_id == "original"
        raise CodedValueError("Review the run before trying again.", code=code)

    monkeypatch.setattr(app.state.jobs, "retry_pipeline", refused)
    response = TestClient(app).post(
        "/api/pipeline/retry", json={"path": str(empty_project), "job_id": "original"}
    )
    assert response.status_code == status
    assert response.headers["X-Sharecut-Error-Code"] == code


def test_retry_route_accepts_only_host_original_job_reference(empty_project, monkeypatch):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    app = create_app(served_project=empty_project)
    calls = []
    successor = Job(id="successor", project_path=str(empty_project))

    def accept(path, job_id):
        calls.append((path, job_id))
        return successor

    monkeypatch.setattr(app.state.jobs, "retry_pipeline", accept)
    client = TestClient(app)
    payload = {"path": str(empty_project), "job_id": "original"}
    response = client.post("/api/pipeline/retry", json=payload)
    assert response.status_code == 200
    assert response.json()["job"]["id"] == "successor"
    assert calls == [(empty_project, "original")]
    calls.clear()
    assert (
        client.post(
            "/api/pipeline/retry",
            json={**payload, "config": {"transcribe": {"overwrite_edited": True}}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/pipeline/retry", json=payload, headers={"x-sharecut-relayed": "1"}
        ).status_code
        == 403
    )
    assert calls == []


def test_retry_preflight_refusal_leaves_original_admission_available(
    empty_project, pipeline_worker, monkeypatch
):
    from podcast_mcp.engines.models.whisper import DEFAULT_WHISPER_MODEL

    manager, calls, entered = pipeline_worker
    original = manager.start(empty_project, config={"transcribe": {"model": DEFAULT_WHISPER_MODEL}})
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)
    checks = []
    unavailable = True

    def require_model(model, variant=None, **kwargs):
        checks.append((model, variant))
        if unavailable:
            raise _missing_model()

    monkeypatch.setattr("podcast_mcp.engines.models.registry.require_model", require_model)
    with pytest.raises(ModelMissing):
        manager.retry_pipeline(empty_project, original.id)
    assert len(calls) == 1
    assert manager.get_job().id == original.id
    unavailable = False
    successor = manager.retry_pipeline(empty_project, original.id)
    manager.wait(successor, timeout=5)
    assert successor.status == "ok", successor.snapshot()
    assert checks == [("whisper", DEFAULT_WHISPER_MODEL)] * 3


def test_retry_thread_creation_failure_releases_slot_without_consuming_original(
    empty_project, pipeline_worker, monkeypatch
):
    manager, calls, entered = pipeline_worker
    original = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)
    with monkeypatch.context() as launch:

        def fail_start(thread):
            raise RuntimeError("controlled worker launch failure")

        launch.setattr(threading.Thread, "start", fail_start)
        with pytest.raises(RuntimeError, match="controlled worker launch failure"):
            manager.retry_pipeline(empty_project, original.id)
    assert manager.get_job().id == original.id
    assert len(calls) == 1
    successor = manager.retry_pipeline(empty_project, original.id)
    manager.wait(successor, timeout=5)
    assert successor.status == "ok", successor.snapshot()
    assert len(calls) == 2


def test_resolved_model_guards_never_merge_new_defaults(monkeypatch):
    from podcast_mcp.engines.models.whisper import DEFAULT_WHISPER_MODEL
    from podcast_mcp.services.pipeline import config as config_module

    checks = []
    monkeypatch.setattr(
        "podcast_mcp.engines.models.registry.require_model",
        lambda model, variant=None, **kw: checks.append((model, variant)),
    )

    def unexpected_defaults(*args, **kwargs):
        pytest.fail("guard re-read defaults for an already resolved request")

    monkeypatch.setattr(config_module, "merge_pipeline_config", unexpected_defaults)
    config_module.ensure_whisper_cached_for_run(config={"transcribe": {}}, resolved=True)
    config_module.ensure_word_aligner_for_run({"transcribe": {}}, resolved=True)
    assert checks == [("whisper", DEFAULT_WHISPER_MODEL)]


@pytest.mark.parametrize("mode", ["overwrite", "retime_words"])
def test_own_destructive_progress_keeps_original_consent_eligible(
    empty_project, pipeline_worker, mode
):
    manager, calls, entered = pipeline_worker
    _FakeRunner.own_progress = True
    original = manager.start(
        empty_project, config={"transcribe": {mode: True, "overwrite_edited": True}}
    )
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)
    assert _transcript_text(empty_project) == "machine progress"
    successor = manager.retry_pipeline(empty_project, original.id)
    manager.wait(successor, timeout=5)
    assert successor.status == "ok", successor.snapshot()
    assert calls[0]["options"] == calls[1]["options"]


def test_precheckpoint_model_failure_does_not_renew_revision_consent(
    empty_project, pipeline_worker, monkeypatch
):
    manager, calls, entered = pipeline_worker
    original = manager.start(
        empty_project, config={"transcribe": {"overwrite": True, "overwrite_edited": True}}
    )
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)
    checks = 0

    def lose_model_during_worker_check(*args, **kwargs):
        nonlocal checks
        checks += 1
        if checks == 2:
            editor = ProjectWorkspace.open(empty_project)
            with editor.transaction():
                editor.project.transcripts[0].words[0].text = "new human correction"
                editor.save()
            raise _missing_model()

    monkeypatch.setattr(
        "podcast_mcp.engines.models.registry.require_model", lose_model_during_worker_check
    )
    successor = manager.retry_pipeline(empty_project, original.id)
    manager.wait(successor, timeout=5)
    assert successor.error_code == "model_needed"
    assert len(calls) == 1
    with pytest.raises(CodedError) as stale:
        manager.retry_pipeline(empty_project, successor.id)
    assert stale.value.code == "pipeline_retry_stale"
    assert _transcript_text(empty_project) == "new human correction"


@pytest.mark.parametrize("previous_download", [False, True])
def test_bootstrap_worker_creation_failure_restores_slot_and_removal_admission(
    monkeypatch, previous_download
):
    from podcast_mcp.services.jobs import JobManager

    manager = JobManager()
    real_start = threading.Thread.start
    starts = 0

    def fail_first_start(thread):
        nonlocal starts
        starts += 1
        if starts == 1:
            raise RuntimeError("controlled worker launch failure")
        return real_start(thread)

    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.run_bootstrap",
        lambda *args, **kwargs: {"ok": True, "results": {}, "ready": True},
    )
    previous = None
    if previous_download:
        previous, adopted = manager.start_bootstrap(components=["rnnoise"])
        assert adopted is False
        assert manager.wait(previous, timeout=5).status == "ok"
    monkeypatch.setattr(threading.Thread, "start", fail_first_start)

    with pytest.raises(RuntimeError, match="controlled worker launch failure"):
        manager.start_bootstrap(components=["rnnoise"])

    assert manager.get_bootstrap_job() is previous
    with manager.model_removal():
        pass

    successor, adopted = manager.start_bootstrap(components=["rnnoise"])
    assert adopted is False
    assert manager.wait(successor, timeout=5).status == "ok"
    assert manager.get_bootstrap_job().id == successor.id


def test_pipeline_worker_creation_failure_does_not_leave_a_queued_slot(
    empty_project, pipeline_worker, monkeypatch
):
    manager, calls, entered = pipeline_worker
    with monkeypatch.context() as launch:

        def fail_start(thread):
            raise RuntimeError("controlled worker launch failure")

        launch.setattr(threading.Thread, "start", fail_start)
        with pytest.raises(RuntimeError, match="controlled worker launch failure"):
            manager.start(empty_project)
    assert manager.get_job() is None
    original = manager.start(empty_project)
    assert entered.wait(5), manager.status()
    manager.wait(original, timeout=5)
    assert original.error_code == "model_needed"
    assert len(calls) == 1
