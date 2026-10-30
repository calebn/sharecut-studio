"""A model failure inside a Studio job reaches the host snapshot as ``model_needed`` (#2046)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from model_pin_helpers import isolate_model_env
from podcast_mcp.engines.speaker_id import SpeakerModelMissing
from podcast_mcp.gui.job_events import stream_job_events
from podcast_mcp.models import (
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import runner
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
