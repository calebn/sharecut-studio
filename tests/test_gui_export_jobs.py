from __future__ import annotations

import time
from pathlib import Path

from podcast_mcp.gui.jobs import PipelineJob, PipelineJobManager


def _skip_bounce_validate(monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.bounce.BounceService.validate",
        lambda self, req=None: [],
    )


def test_start_bounce_returns_paths_on_terminal_snapshot(minimal_project, monkeypatch) -> None:
    out = Path(minimal_project).parent / "export" / "bounces" / "x.wav"

    def fake_bounce(self, req=None, **_kwargs):
        return [out]

    _skip_bounce_validate(monkeypatch)
    monkeypatch.setattr("podcast_mcp.services.bounce.BounceService.bounce", fake_bounce)
    mgr = PipelineJobManager()
    job = mgr.start_bounce(Path(minimal_project), formats=["wav"])
    assert job.kind == "bounce"
    for _ in range(50):
        if job.status in ("ok", "error"):
            break
        time.sleep(0.05)
    assert job.status == "ok"
    snap = job.snapshot()
    assert snap["kind"] == "bounce"
    assert snap["label"] == "Bounce"
    assert snap["result"]["paths"][0].endswith("x.wav")


def test_start_export_returns_paths_on_terminal_snapshot(minimal_project, monkeypatch) -> None:
    out = Path(minimal_project).parent / "export" / "demo.wav"

    def fake_export(self, formats=None, **_kwargs):
        return [out]

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio",
        fake_export,
    )
    mgr = PipelineJobManager()
    job = mgr.start_export(Path(minimal_project))
    assert job.kind == "export"
    for _ in range(50):
        if job.status in ("ok", "error"):
            break
        time.sleep(0.05)
    assert job.status == "ok"
    assert job.snapshot()["result"]["paths"][0].endswith("demo.wav")


def test_bounce_takes_pipeline_lock_and_coexists_with_agent(minimal_project, monkeypatch) -> None:
    _skip_bounce_validate(monkeypatch)
    monkeypatch.setattr(
        "podcast_mcp.services.bounce.BounceService.bounce",
        lambda self, req=None, **_k: [Path("/tmp/x.wav")],
    )
    mgr = PipelineJobManager()
    pipeline = PipelineJob(
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
        assert "already running" in str(exc)
        assert "pipeline-slot" in str(exc)
    agent = mgr.adopt_agent_job(tool_id="align_tracks", label="align", claim="c1")
    st = mgr.status()
    assert st["running_count"] == 2
    kinds = {row["kind"] for row in st["jobs"]}
    assert kinds == {"pipeline", "agent"}
    mgr.complete_agent_job(agent, status="ok", message="done")


def test_status_includes_recent_finished_jobs(minimal_project, monkeypatch) -> None:
    _skip_bounce_validate(monkeypatch)
    monkeypatch.setattr(
        "podcast_mcp.services.bounce.BounceService.bounce",
        lambda self, req=None, **_k: [Path("/tmp/x.wav")],
    )
    mgr = PipelineJobManager()
    first = mgr.start_bounce(Path(minimal_project), formats=["wav"])
    for _ in range(50):
        if first.status in ("ok", "error", "cancelled"):
            break
        time.sleep(0.05)
    assert first.status == "ok"
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_audio",
        lambda self, formats=None, **_k: [Path("/tmp/ep.wav")],
    )
    second = mgr.start_export(Path(minimal_project))
    for _ in range(50):
        if second.status in ("ok", "error", "cancelled"):
            break
        time.sleep(0.05)
    st = mgr.status()
    ids = {row["id"] for row in st["jobs"]}
    assert first.id in ids
    assert second.id in ids


def test_bounce_job_reporter_units_and_cancel_copy(minimal_project, monkeypatch) -> None:
    from podcast_mcp.gui.jobs import _cancelled_copy, _JobProgressReporter

    assert _cancelled_copy("bounce") == "Bounce cancelled"
    assert _cancelled_copy("export") == "Export cancelled"
    assert _cancelled_copy("render_preview") == "Render preview cancelled"
    assert _cancelled_copy("agent") == "Activity cancelled"

    bounce = PipelineJob(
        id="b1",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="bounce",
        label="Bounce",
    )
    reporter = _JobProgressReporter(bounce)
    reporter.start("bounce", "Bouncing stems", total=4)
    reporter.update("bounce", 2, message="Stem host")
    assert bounce.current == 2
    assert bounce.total == 4
    reporter.message("bounce", "Mixing bounce…")
    assert bounce.message == "Mixing bounce…"
    reporter.close()

    preview = PipelineJob(
        id="r1",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="render_preview",
        label="Render preview",
    )
    prev = _JobProgressReporter(preview)
    prev.start("render", "Rendering preview", total=3)
    prev.update("render", 1, message="Assembled timeline")
    assert preview.current == 1
    assert prev._event_label() == "Render preview"

    export = PipelineJob(
        id="e1",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="export",
        label="Export deliverables",
    )
    exp = _JobProgressReporter(export)
    exp.start("export", "Exporting deliverables", total=2)
    exp.update("export", 1, message="Mastered WAV ready")
    assert export.current == 1
    assert exp._event_label() == "Export"
    exp.close()

    mgr = PipelineJobManager()
    _skip_bounce_validate(monkeypatch)

    def fake_bounce(self, req=None, **_kwargs):
        assert mgr._job is not None
        mgr._job.cancel_requested = True
        return [Path("/tmp/x.wav")]

    monkeypatch.setattr("podcast_mcp.services.bounce.BounceService.bounce", fake_bounce)
    job = mgr.start_bounce(Path(minimal_project), formats=["wav"])
    for _ in range(50):
        if job.status in ("ok", "error", "cancelled"):
            break
        time.sleep(0.05)
    assert job.status == "cancelled"
    assert job.message == "Bounce cancelled"
    assert job.result is not None
    assert job.result["paths"][0].endswith("x.wav")
