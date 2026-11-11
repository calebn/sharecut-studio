from __future__ import annotations

import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models.history import HistoryEntry, ProjectHistory
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.pipeline import AudioExportResult, ExportTarget


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
    assert snap["result"]["file_ids"] == ["bounces/x.wav"]


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
        return AudioExportResult([out], master, "cut-2")

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
    assert result["edit_head_id"] == "cut-2"


def test_named_variant_export_uses_read_only_workspace_and_typed_result(
    minimal_project, monkeypatch
) -> None:
    from podcast_mcp.engines.mastering import MasterQcLimits, MasterTarget
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.pipeline import VariantExportResult
    from podcast_mcp.services.pipeline.export_variant import VariantQc

    opened_with_adoption: list[bool] = []
    targets: list[ExportTarget] = []

    original_open = ProjectWorkspace.open

    def recording_open(path, *, adopt=True):
        opened_with_adoption.append(adopt)
        return original_open(path, adopt=adopt)

    def fake_variant(self, target, formats=None, **_kwargs):
        targets.append(target)
        return VariantExportResult(
            file_ids=("variants/" + "a" * 64 + "/audio.wav",),
            target=target,
            master=VariantQc(
                MasterTarget(-14.0, -1.5, 11.0),
                MasterQcLimits(),
                {"integrated_lufs": -14.0, "true_peak_db": -2.0},
                None,
                "test",
                None,
                None,
                (),
            ),
            edit_head_id="cut-3",
        )

    monkeypatch.setattr(ProjectWorkspace, "open", recording_open)
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.export_variant", fake_variant
    )
    manager = JobManager()
    job = manager.start_export(Path(minimal_project), target=ExportTarget.STREAMING)
    manager.wait(job, timeout=2.5)

    assert job.status == "ok"
    assert opened_with_adoption == [False]
    assert targets == [ExportTarget.STREAMING]
    assert job.snapshot()["result"]["target"] == "streaming"
    assert job.snapshot()["result"]["file_ids"] == ["variants/" + "a" * 64 + "/audio.wav"]


def test_host_export_request_forwards_target_and_explicit_wav(minimal_project, monkeypatch) -> None:
    from types import SimpleNamespace

    calls: list[tuple[list[dict] | None, ExportTarget | None]] = []

    def start_export(self, project_path, *, formats=None, target=None, **_kwargs):
        calls.append((formats, target))
        return SimpleNamespace(
            id="job-variant",
            snapshot=lambda: {"id": "job-variant", "status": "queued"},
        )

    monkeypatch.setattr(JobManager, "start_export", start_export)
    response = TestClient(create_app()).post(
        "/api/export/deliverables",
        json={
            "path": str(minimal_project),
            "target": "podcast",
            "formats": [{"ext": "wav"}],
        },
    )

    assert response.status_code == 200
    assert calls == [([{"ext": "wav"}], ExportTarget.PODCAST)]


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
        "podcast_mcp.services.jobs.manager.ProjectWorkspace.open",
        lambda _p, **_kwargs: object(),
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


def test_export_audio_reports_the_edit_head_at_its_checkpoint(minimal_project, monkeypatch) -> None:
    from podcast_mcp.models import load_project, save_project
    from podcast_mcp.pipeline import steps
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.pipeline import PipelineService

    project = load_project(Path(minimal_project))
    project.history = ProjectHistory(
        cursor=2,
        entries=[
            HistoryEntry(id="cut-1", label="cut", snapshot_file="s1.json", operation="cut"),
            HistoryEntry(id="cut-2", label="cut", snapshot_file="s2.json", operation="cut"),
            HistoryEntry(
                id="preview-1",
                label="refresh",
                snapshot_file="s3.json",
                operation="render_preview",
            ),
        ],
    )
    save_project(project)
    monkeypatch.setattr(steps, "ensure_current_master", lambda *_a, **_k: Path("master.wav"))
    monkeypatch.setattr(steps, "read_master_qc", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "podcast_mcp.export.episode.export_episode_deliverables",
        lambda *_a, **_k: [Path("/tmp/demo.wav")],
    )
    monkeypatch.setattr("podcast_mcp.services.pipeline.service.ffmpeg", lambda: object())
    result = PipelineService(ProjectWorkspace.open(Path(minimal_project))).export_audio()
    assert result.edit_head_id == "cut-2"


@pytest.mark.parametrize(
    "target,lufs", [(None, -19.0), ("broadcast", -23.0), ("podcast", -16.0), ("streaming", -14.0)]
)
def test_settings_read_is_host_only_private_and_does_not_create_a_job(
    minimal_project, monkeypatch, target, lufs
):
    from podcast_mcp.services.pipeline import config as config_module
    from podcast_mcp.services.pipeline import config_store

    config_store().put(
        minimal_project,
        config={
            "master": {
                "integrated_lufs": "-19",
                "true_peak_db": "-2",
                "lra": "8",
                "qc_lufs_tolerance_lu": "0.7",
                "qc_true_peak_tolerance_db": "0.4",
            },
            "export": {"wav": "false"},
        },
    )
    calls = []
    original = config_module.run_defaults_for

    def read_once(path):
        calls.append(path)
        return original(path)

    monkeypatch.setattr(config_module, "run_defaults_for", read_once)
    app = create_app()
    client = TestClient(app)
    body = {
        "path": str(minimal_project),
        "target": target,
        "formats": [{"ext": "flac"}, {"ext": "m4a"}],
    }
    response = client.post("/api/export/deliverables/settings", json=body)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    settings = response.json()["settings"]
    assert settings == {
        "version": 1,
        "basis": settings["basis"],
        "target": target,
        "master_target": {"integrated_lufs": lufs, "true_peak_db": -2.0, "lra": 8.0},
        "qc_limits": {"lufs_tolerance_lu": 0.7, "true_peak_tolerance_db": 0.4},
        "audio_formats": ["wav", "flac", "m4a"],
    }
    assert len(settings["basis"]) == 64
    assert calls == [Path(minimal_project)]
    assert app.state.jobs.status()["running_count"] == 0
    assert str(minimal_project) not in response.text
    denied = client.post(
        "/api/export/deliverables/settings", json=body, headers={"x-sharecut-relayed": "1"}
    )
    assert denied.status_code == 403
    assert calls == [Path(minimal_project)]


def test_settings_basis_covers_private_options_and_types_but_not_unrelated_config(
    minimal_project, monkeypatch
):
    from podcast_mcp.services.pipeline import config as config_module
    from podcast_mcp.services.pipeline import config_store

    store = config_store()
    assert store.peek(minimal_project) is None
    client = TestClient(create_app())
    body = {
        "path": str(minimal_project),
        "formats": [
            {"ext": "mp3", "bitrate_kbps": "192", "extra_args": ["/private/credential-secret"]}
        ],
    }

    def read():
        response = client.post("/api/export/deliverables/settings", json=body)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert "credential-secret" not in response.text
        assert "extra_args" not in response.text
        return response.json()

    initial = read()["settings"]
    assert store.peek(minimal_project) is None
    store.apply_patches(minimal_project, {"performance": {"max_workers": 1}})
    assert read()["settings"] == initial
    body["formats"][0]["bitrate_kbps"] = 192
    numeric = read()["settings"]
    assert numeric["basis"] != initial["basis"]
    body["formats"][0]["extra_args"] = ["/private/credential-secret-changed"]
    assert read()["settings"]["basis"] != numeric["basis"]
    for patch in (
        {"master": {"true_peak_db": -2}},
        {"master": {"lra": 8}},
        {"master": {"qc_lufs_tolerance_lu": 0.9}},
        {"export": {"wav": False}},
    ):
        before = read()["settings"]["basis"]
        store.apply_patches(minimal_project, patch)
        assert read()["settings"]["basis"] != before
    body["formats"] = None
    for value in (float("nan"), float("inf"), {"nested": 1}):
        monkeypatch.setattr(
            config_module,
            "run_defaults_for",
            lambda path, value=value: {
                "export": {"formats": [{"ext": "mp3", "bitrate_kbps": value}]}
            },
        )
        assert read() == {"status": "unavailable", "code": "export_settings_unavailable"}

    def fail(path):
        raise OSError("/private/credential-secret")

    monkeypatch.setattr(config_module, "run_defaults_for", fail)
    assert read() == {"status": "unavailable", "code": "export_settings_unavailable"}


@pytest.mark.parametrize("target", [None, ExportTarget.PODCAST])
def test_export_admission_snapshots_nested_formats_before_wait(
    minimal_project, monkeypatch, target
):
    submitted = [{"ext": "flac", "extra_args": ["original"]}, {"ext": "mp3"}]
    manager = JobManager()
    captured = []

    def wait(scope, deadline):
        submitted.reverse()
        submitted[1]["extra_args"].append("changed")

    def spawn(path, **kwargs):
        captured.append(kwargs["config"])
        return Job(id="captured", project_path=str(path), from_step=None, only_step=None)

    monkeypatch.setattr(manager, "_wait_out_mix_rebuild", wait)
    monkeypatch.setattr(manager, "_spawn", spawn)
    manager.start_export(Path(minimal_project), formats=submitted, target=target)
    assert captured == [
        {
            "formats": [{"ext": "flac", "extra_args": ["original"]}, {"ext": "mp3"}],
            "target": target.value if target else None,
        }
    ]


@pytest.mark.parametrize("cancelled", [False, True])
def test_export_terminal_lock_strips_only_success_evidence_after_late_cancel(
    minimal_project, monkeypatch, cancelled
):
    from podcast_mcp.services.jobs.job import guest_job_projection

    manager = JobManager()
    job = Job(
        id="late-export",
        project_path=str(minimal_project),
        from_step=None,
        only_step=None,
        kind="export",
    )
    legacy = {"paths": ["saved.wav"], "master": {"measured": None}, "edit_head_id": "edit-1"}
    enriched = {**legacy, "applied_settings": {"basis": "private-basis"}}

    def completed(job, reporter):
        with job._lock:
            job.cancel_requested = cancelled
        return "Export complete", enriched

    monkeypatch.setattr(manager, "_execute_job", completed)
    manager._run_job(job)
    assert job.status == ("cancelled" if cancelled else "ok")
    assert job.result == (legacy if cancelled else enriched)
    assert enriched["applied_settings"] == {"basis": "private-basis"}
    assert guest_job_projection(job) == {
        "id": "late-export",
        "status": job.status,
        "current": None,
        "total": None,
        "message": None,
        "error": None,
    }


@pytest.mark.parametrize("target", [None, "broadcast"])
@pytest.mark.parametrize("late_cancel", [False, True])
def test_real_export_job_uses_its_snapshot_and_same_intent_retry(
    minimal_project, sample_wav, monkeypatch, target, late_cancel
):
    from contextlib import contextmanager

    from podcast_mcp.services.pipeline import config_store
    from podcast_mcp.services.pipeline import service as pipeline
    from test_export_variant import _current_mix, _FakeEngine

    workspace = _current_mix(minimal_project, sample_wav)
    store = config_store()
    store.put(
        minimal_project,
        config={
            "master": {"integrated_lufs": -19, "true_peak_db": -2},
            "performance": {"max_workers": 1},
        },
    )

    class Engine(_FakeEngine):
        def measure_loudness_full(self, path, **kwargs):
            return super().measure_loudness_full(path)

    engine = Engine(sample_wav)
    monkeypatch.setattr(pipeline.pipeline_steps, "ffmpeg", lambda: engine)
    monkeypatch.setattr(pipeline, "ffmpeg", lambda: engine)
    app = create_app()
    client = TestClient(app)
    returned = []
    execute = app.state.jobs._execute_job

    def cancel_after_return(job, reporter):
        message, result = execute(job, reporter)
        returned.append(result)
        with job._lock:
            job.cancel_requested = late_cancel
        return message, result

    monkeypatch.setattr(app.state.jobs, "_execute_job", cancel_after_return)
    body = {"path": str(minimal_project), "target": target, "formats": [{"ext": "flac"}]}
    if target is None:
        body["formats"][0]["extra_args"] = ["/private/credential-secret"]
    previous = client.post("/api/export/deliverables/settings", json=body).json()["settings"]
    store.apply_patches(minimal_project, {"master": {"integrated_lufs": -20, "lra": 8}})
    original_lock = pipeline.render_lock

    @contextmanager
    def change_at_lock(project, **kwargs):
        store.apply_patches(minimal_project, {"master": {"integrated_lufs": -21, "lra": 9}})
        with original_lock(project, **kwargs):
            yield

    monkeypatch.setattr(pipeline, "render_lock", change_at_lock)
    response = client.post("/api/export/deliverables", json=body)
    assert response.status_code == 200
    job = app.state.jobs._job
    app.state.jobs.wait(job, timeout=5)
    if late_cancel:
        assert job.status == "cancelled", job.snapshot()
        assert returned[0]["applied_settings"]["audio_formats"] == ["wav", "flac"]
        assert job.snapshot()["result"] == {
            key: value for key, value in returned[0].items() if key != "applied_settings"
        }
        assert engine.master_calls == 1
        return
    assert job.status == "ok", job.snapshot()
    result = job.snapshot()["result"]
    applied = result["applied_settings"]
    assert "credential-secret" not in str(applied)
    assert engine.master_targets == ([-20.0] if target is None else [-23.0])
    assert applied["master_target"] == {
        "integrated_lufs": -20.0 if target is None else -23.0,
        "true_peak_db": -2.0,
        "lra": 8.0 if target is None else 9.0,
    }
    assert applied["audio_formats"] == ["wav", "flac"]
    assert applied["basis"] != previous["basis"]
    current = client.post("/api/export/deliverables/settings", json=body).json()["settings"]
    assert current["master_target"]["lra"] == 9.0
    assert (current["basis"] == applied["basis"]) is (target is not None)
    monkeypatch.setattr(pipeline, "render_lock", original_lock)
    store.apply_patches(minimal_project, {"export": {"wav": False, "formats": [{"ext": "mp3"}]}})
    retry_read = client.post("/api/export/deliverables/settings", json=body).json()["settings"]
    assert retry_read["audio_formats"] == ["flac"]
    retry = client.post("/api/export/deliverables", json=body)
    assert retry.status_code == 200
    job = app.state.jobs._job
    app.state.jobs.wait(job, timeout=5)
    assert job.status == "ok", job.snapshot()
    assert job.snapshot()["result"]["applied_settings"] == retry_read
    implicit = {"path": str(minimal_project), "target": target}
    assert client.post("/api/export/deliverables/settings", json=implicit).json()["settings"][
        "audio_formats"
    ] == ["mp3"]
    store.apply_patches(minimal_project, {"export": {"formats": [{"ext": "m4a"}]}})
    implicit["formats"] = None
    assert client.post("/api/export/deliverables/settings", json=implicit).json()["settings"][
        "audio_formats"
    ] == ["m4a"]
    assert workspace.project.raw_dir().joinpath("host.wav").read_bytes() == sample_wav.read_bytes()
