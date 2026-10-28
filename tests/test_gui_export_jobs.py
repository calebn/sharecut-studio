from __future__ import annotations

import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.pipeline import AudioExportResult


def _skip_bounce_validate(monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.media.bounce.BounceService.validate",
        lambda self, req=None: [],
    )


def test_start_bounce_returns_paths_on_terminal_snapshot(minimal_project, monkeypatch) -> None:
    out = Path(minimal_project).parent / "export" / "bounces" / "x.wav"

    def fake_bounce(self, req=None, **_kwargs):
        return [out]

    _skip_bounce_validate(monkeypatch)
    monkeypatch.setattr("podcast_mcp.services.media.bounce.BounceService.bounce", fake_bounce)
    mgr = JobManager()
    job = mgr.start_bounce(Path(minimal_project), formats=["wav"])
    assert job.kind == "bounce"
    mgr.wait(job, timeout=2.5)
    assert job.status == "ok"
    snap = job.snapshot()
    assert snap["kind"] == "bounce"
    assert snap["label"] == "Bounce"
    assert snap["result"]["paths"][0].endswith("x.wav")


def test_start_export_returns_paths_and_master_target_on_terminal_snapshot(
    minimal_project, monkeypatch
) -> None:
    out = Path(minimal_project).parent / "export" / "demo.wav"
    master = {
        "target_integrated_lufs": -19.0,
        "target_true_peak_db": -1.5,
        "measured": {"integrated_lufs": -19.1, "true_peak_db": -2.2},
        "within_tolerance": True,
    }

    def fake_export(self, formats=None, **_kwargs):
        return AudioExportResult([out], master)

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio",
        fake_export,
    )
    mgr = JobManager()
    job = mgr.start_export(Path(minimal_project))
    assert job.kind == "export"
    mgr.wait(job, timeout=2.5)
    assert job.status == "ok"
    result = job.snapshot()["result"]
    assert result["paths"][0].endswith("demo.wav")
    assert result["master"] == master
    assert result["edit_head_id"] == "root"


def test_bounce_takes_pipeline_lock_and_coexists_with_agent(minimal_project, monkeypatch) -> None:
    _skip_bounce_validate(monkeypatch)
    monkeypatch.setattr(
        "podcast_mcp.services.media.bounce.BounceService.bounce",
        lambda self, req=None, **_k: [Path("/tmp/x.wav")],
    )
    mgr = JobManager()
    pipeline = Job(
        id="pipe",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        status="running",
        started_at=1.0,
        kind="pipeline",
    )
    mgr._job = pipeline
    try:
        mgr.start_bounce(Path(minimal_project))
        raise AssertionError("bounce should take the pipeline lock")
    except RuntimeError as exc:
        assert str(exc) == "Another job is still running. Try again when it finishes."
    agent = mgr.adopt_agent_job(tool_id="align_tracks", label="align", claim="c1")
    st = mgr.status()
    assert st["running_count"] == 2
    kinds = {row["kind"] for row in st["jobs"]}
    assert kinds == {"pipeline", "agent"}
    mgr.complete_agent_job(agent, status="ok", message="done")


def test_status_includes_recent_finished_jobs(minimal_project, monkeypatch) -> None:
    _skip_bounce_validate(monkeypatch)
    monkeypatch.setattr(
        "podcast_mcp.services.media.bounce.BounceService.bounce",
        lambda self, req=None, **_k: [Path("/tmp/x.wav")],
    )
    mgr = JobManager()
    first = mgr.start_bounce(Path(minimal_project), formats=["wav"])
    mgr.wait(first, timeout=2.5)
    assert first.status == "ok"
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio",
        lambda self, formats=None, **_k: [Path("/tmp/ep.wav")],
    )
    second = mgr.start_export(Path(minimal_project))
    mgr.wait(second, timeout=2.5)
    st = mgr.status()
    ids = {row["id"] for row in st["jobs"]}
    assert first.id in ids
    assert second.id in ids


def test_bounce_job_reporter_units_and_cancel_copy(minimal_project, monkeypatch) -> None:
    from podcast_mcp.services.jobs.job import cancelled_copy
    from podcast_mcp.services.jobs.reporter import JobProgressReporter

    assert cancelled_copy("bounce") == "Bounce cancelled"
    assert cancelled_copy("export") == "Export cancelled"
    assert cancelled_copy("render_preview") == "Render preview cancelled"
    assert cancelled_copy("agent") == "Activity cancelled"

    bounce = Job(
        id="b1",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="bounce",
        label="Bounce",
    )
    reporter = JobProgressReporter(bounce)
    reporter.start("bounce", "Bouncing stems", total=4)
    reporter.update("bounce", 2, message="Stem host")
    assert bounce.current == 2
    assert bounce.total == 4
    reporter.message("bounce", "Mixing bounce…")
    assert bounce.message == "Mixing bounce…"
    reporter.close()

    preview = Job(
        id="r1",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="render_preview",
        label="Render preview",
    )
    prev = JobProgressReporter(preview)
    prev.start("render", "Rendering preview", total=3)
    prev.update("render", 1, message="Assembled timeline")
    assert preview.current == 1
    assert prev._event_label() == "Render preview"

    export = Job(
        id="e1",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="export",
        label="Export deliverables",
    )
    exp = JobProgressReporter(export)
    exp.start("export", "Exporting deliverables", total=2)
    exp.update("export", 1, message="Mastered WAV ready")
    assert export.current == 1
    assert exp._event_label() == "Export"
    exp.close()

    mgr = JobManager()
    _skip_bounce_validate(monkeypatch)

    def fake_bounce(self, req=None, **_kwargs):
        assert mgr._job is not None
        mgr._job.cancel_requested = True
        return [Path("/tmp/x.wav")]

    monkeypatch.setattr("podcast_mcp.services.media.bounce.BounceService.bounce", fake_bounce)
    job = mgr.start_bounce(Path(minimal_project), formats=["wav"])
    mgr.wait(job, timeout=2.5)
    assert job.status == "cancelled"
    assert job.message == "Bounce cancelled"
    assert job.result is not None
    assert job.result["paths"][0].endswith("x.wav")


def test_analyze_job_reporter_counts_tracks_per_phase(minimal_project) -> None:
    from podcast_mcp.services.jobs.job import cancelled_copy
    from podcast_mcp.services.jobs.reporter import JobProgressReporter

    assert cancelled_copy("analyze") == "Analyze cancelled"

    job = Job(
        id="a1",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="analyze",
        label="Analyze",
    )
    rep = JobProgressReporter(job)
    rep.start("pipeline_analyze", "Analyzing audio")
    rep.message("pipeline_analyze", "Measuring track health…", phase="health")
    rep.start("analyze_health", "Measuring track health")
    rep.update("analyze_health", 0, total=2)
    rep.update("analyze_health", 1, message="track host")
    assert job.current == 1
    assert job.total == 2
    rep.end("analyze_health")
    rep.start("analyze_silence", "Scanning dialogue for digital silence", total=2)
    assert job.current == 0
    assert job.total == 2
    rep.update("analyze_silence", 2, message="Scanned guest (2/2)")
    assert job.current == 2
    assert job.message == "Scanned guest (2/2)"
    assert rep._event_label() == "Analyze"
    rep.close()


def test_start_analyze_runs_working_set_and_takes_slot(minimal_project, monkeypatch) -> None:
    def fake_analyze_working_set(project_path, project, *, apply, cancel_check=None):
        assert callable(cancel_check)
        return {"reasons": [], "patches": {}, "applied": apply}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.analyze_working_set",
        fake_analyze_working_set,
    )

    mgr = JobManager()
    job = mgr.start_analyze(Path(minimal_project), apply=True)
    mgr.wait(job, timeout=5)
    assert job.kind == "analyze"
    assert job.status == "ok"
    snap = job.snapshot()
    assert snap["result"]["applied"] is True
    assert snap["label"] == "Analyze"

    running = Job(
        id="running-pipe",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        status="running",
        started_at=1.0,
        kind="pipeline",
    )
    mgr._job = running
    try:
        mgr.start_analyze(Path(minimal_project), apply=True)
        raise AssertionError("analyze should take the pipeline lock")
    except RuntimeError as exc:
        assert "still running" in str(exc)


def test_cancelling_an_export_mid_encode_keeps_the_previous_export(slow_export) -> None:
    mgr = JobManager()
    job = mgr.start_export(
        Path(slow_export.project), formats=[{"ext": "mp3", "codec": "libmp3lame"}]
    )
    slow_export.wait_until_encoding(alive=lambda: job.status == "running")
    mgr.cancel(job.id)
    mgr.wait(job, timeout=10)

    assert job.status == "cancelled"
    assert job.result is None
    assert slow_export.files() == slow_export.previous


class _OrderedSlotService:
    def __init__(self, order: list[str], release: threading.Event) -> None:
        self._order = order
        self._release = release

    def render_preview(self, **_kwargs):
        assert self._release.wait(timeout=10)
        self._order.append("preview")
        return {"ok": True}

    def export_audio(self, formats=None, **_kwargs):
        self._order.append("export")
        return AudioExportResult([Path("/tmp/demo.wav")], None)


def _wire_ordered_slot(monkeypatch, order: list[str], release: threading.Event) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.ProjectWorkspace.open", lambda _p: object()
    )
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.PipelineService",
        lambda _ws: _OrderedSlotService(order, release),
    )


def test_export_right_after_undo_waits_for_the_mix_rebuild(minimal_project, monkeypatch) -> None:
    order: list[str] = []
    release = threading.Event()
    _wire_ordered_slot(monkeypatch, order, release)
    client = TestClient(create_app())
    jobs = client.app.state.jobs
    preview = jobs.start_render_preview(Path(minimal_project))
    real_wait = JobManager.wait

    def wait_for_preview(self, job, **kwargs):
        release.set()
        return real_wait(self, job, **kwargs)

    monkeypatch.setattr(JobManager, "wait", wait_for_preview)

    res = client.post("/api/export/deliverables", json={"path": str(minimal_project)})

    assert res.status_code == 200, res.text
    export = jobs.get_job(res.json()["job_id"])
    jobs.wait(export, timeout=5)
    assert (preview.status, export.status) == ("ok", "ok")
    assert order == ["preview", "export"]


def test_export_refused_while_the_mix_rebuild_outlasts_the_wait_says_to_retry(
    minimal_project, monkeypatch
) -> None:
    release = threading.Event()
    _wire_ordered_slot(monkeypatch, [], release)
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.EXPORT_PREVIEW_WAIT_S", 0.0)
    client = TestClient(create_app())
    jobs = client.app.state.jobs
    preview = jobs.start_render_preview(Path(minimal_project))
    try:
        res = client.post("/api/export/deliverables", json={"path": str(minimal_project)})
    finally:
        release.set()
        jobs.wait(preview, timeout=5)

    assert res.status_code == 409
    assert res.headers["X-Sharecut-Error-Code"] == "job_running"
    assert "pipeline-slot" not in res.text
    assert "Try again" in res.text


def test_slot_busy_refusal_uses_user_wording(minimal_project) -> None:
    mgr = JobManager()
    mgr._job = Job(
        id="pipe",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        status="running",
        started_at=1.0,
        kind="pipeline",
    )
    with pytest.raises(RuntimeError) as raised:
        mgr.start_export(Path(minimal_project))
    assert str(raised.value) == "Another job is still running. Try again when it finishes."


def test_export_does_not_wait_for_another_projects_mix_rebuild(
    minimal_project, tmp_path, monkeypatch
) -> None:
    release = threading.Event()
    _wire_ordered_slot(monkeypatch, [], release)
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.EXPORT_PREVIEW_WAIT_S", 0.0)
    client = TestClient(create_app())
    jobs = client.app.state.jobs
    other = tmp_path / "other"
    other.mkdir()
    preview = jobs.start_render_preview(other)
    try:
        res = client.post("/api/export/deliverables", json={"path": str(minimal_project)})
    finally:
        release.set()
        jobs.wait(preview, timeout=5)

    assert res.status_code == 409
    assert "Another job is still running" in res.text


def test_export_retakes_the_slot_when_another_rebuild_slips_in_before_it_spawns(
    minimal_project, monkeypatch
) -> None:
    order: list[str] = []
    release = threading.Event()
    _wire_ordered_slot(monkeypatch, order, release)
    client = TestClient(create_app())
    jobs = client.app.state.jobs
    real_spawn = JobManager._spawn
    real_wait = JobManager.wait
    slipped_in: list[Job] = []

    def spawn_after_a_rebuild_slips_in(self, project_path, **kwargs):
        if kwargs["kind"] == "export" and not slipped_in:
            slipped_in.append(self.start_render_preview(Path(project_path)))
        return real_spawn(self, project_path, **kwargs)

    def wait_for_preview(self, job, **kwargs):
        release.set()
        return real_wait(self, job, **kwargs)

    monkeypatch.setattr(JobManager, "_spawn", spawn_after_a_rebuild_slips_in)
    monkeypatch.setattr(JobManager, "wait", wait_for_preview)

    res = client.post("/api/export/deliverables", json={"path": str(minimal_project)})

    assert res.status_code == 200, res.text
    export = jobs.get_job(res.json()["job_id"])
    jobs.wait(export, timeout=5)
    assert (slipped_in[0].status, export.status) == ("ok", "ok")
    assert order == ["preview", "export"]
