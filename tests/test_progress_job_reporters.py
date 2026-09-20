from __future__ import annotations

import sys
from queue import Empty

import pytest

from podcast_mcp.gui.bootstrap_jobs import BootstrapJob, _BootstrapProgressReporter
from podcast_mcp.gui.jobs import (
    PipelineJob,
    PipelineJobManager,
    StepTiming,
    _JobProgressReporter,
    _SsePublishReporter,
)
from podcast_mcp.util.progress import (
    CancelledProgress,
    RecordingProgress,
    bind_progress,
    progress_task,
)


def test_job_progress_reporter_fail_and_cancel() -> None:
    job = PipelineJob(
        id="j1",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
    )
    # started_at still None — exercise _elapsed / snapshot branches
    reporter = _JobProgressReporter(job)
    reporter.message("pipeline", "before start")
    assert job.snapshot()["elapsed_sec"] == 0.0

    job.started_at = 0.0
    job.steps.append(StepTiming(name="clean_audio", started_at=0.0, status="running"))
    reporter.start("pipeline", "Pipeline", total=2)
    headline = job.message
    reporter.update("pipeline", 1, total=2, message=None)  # must not clear headline
    assert job.message == headline
    reporter.message("pipeline", "Running clean_audio")
    reporter.update(
        "pipeline",
        1,
        total=2,
        message="Completed clean_audio: removed 3 fillers",
    )
    assert job.steps[-1].status == "ok"
    assert job.steps[-1].summary == "removed 3 fillers"
    reporter.message("pipeline", "Running balance_tracks")
    reporter.fail("pipeline", message="boom", phase="running")
    assert job.error == "boom"
    assert job.steps[-1].status == "error"
    reporter.cancel("pipeline", message="stopped")
    assert job.message == "stopped"
    reporter.cancel("pipeline")  # message None
    reporter.end("pipeline", message="done")
    assert job.message == "done"
    reporter.close()


def test_bootstrap_progress_reporter_fail_and_cancel() -> None:
    job = BootstrapJob(id="b1", components=["ffmpeg"])
    reporter = _BootstrapProgressReporter(job)
    reporter.start("bootstrap", "Bootstrap", total=3)
    reporter.update("bootstrap", 1, message="downloading", phase="fetch")
    reporter.message("bootstrap", "still going", phase="fetch")
    reporter.fail("bootstrap", message="nope", phase="fetch")
    assert job.error == "nope"
    reporter.cancel("bootstrap", message="abort")
    assert job.message == "abort"
    reporter.end("bootstrap", message="done")


def test_bootstrap_service_error_paths(monkeypatch, tmp_path) -> None:
    from podcast_mcp.services import bootstrap as boot

    monkeypatch.setattr(boot.shutil, "which", lambda _n: None)
    monkeypatch.setattr(boot, "resolve_ffmpeg", lambda: "ffmpeg")
    assert boot._ffmpeg_ready() is False

    ff = tmp_path / "ffmpeg"
    fp = tmp_path / "ffprobe"
    ff.write_text("x")
    fp.write_text("x")
    monkeypatch.setattr(boot, "resolve_ffmpeg", lambda: str(ff))
    monkeypatch.setattr(boot, "resolve_ffprobe", lambda: str(fp))
    assert boot._ffmpeg_ready() is True

    monkeypatch.setattr(
        boot,
        "bootstrap_ffmpeg",
        lambda **_k: (_ for _ in ()).throw(RuntimeError("net")),
    )
    assert boot._run_ffmpeg(force=True)["ok"] is False

    monkeypatch.setattr(
        boot,
        "bootstrap_ffmpeg",
        lambda **_k: (tmp_path / "ff", tmp_path / "fp"),
    )
    (tmp_path / "ff").write_text("x")
    (tmp_path / "fp").write_text("x")
    assert boot._run_ffmpeg(force=True)["ok"] is True
    assert "ffmpeg" in boot._run_ffmpeg(force=True)
    monkeypatch.setattr(
        boot,
        "bootstrap_whisper_model",
        lambda _m: (_ for _ in ()).throw(ImportError("no whisper")),
    )
    assert boot._run_whisper("base")["ok"] is False

    monkeypatch.setattr(
        boot,
        "bootstrap_whisper_model",
        lambda _m: (_ for _ in ()).throw(RuntimeError("dl fail")),
    )
    assert boot._run_whisper("base")["ok"] is False

    monkeypatch.setattr(
        boot,
        "bootstrap_rnnoise_model",
        lambda **_k: (_ for _ in ()).throw(RuntimeError("rn")),
    )
    assert boot._run_rnnoise(force=True)["ok"] is False

    model = tmp_path / "rnnoise.rnnn"
    model.write_text("x")
    monkeypatch.setattr(boot, "bootstrap_rnnoise_model", lambda **_k: model)
    assert boot._run_rnnoise(force=False)["ok"] is True

    # Cover run_bootstrap rnnoise branch
    monkeypatch.setattr(boot, "_run_ffmpeg", lambda **_k: {"ok": True})
    monkeypatch.setattr(boot, "_run_whisper", lambda _m: {"ok": True})
    monkeypatch.setattr(boot, "_run_rnnoise", lambda **_k: {"ok": True})
    monkeypatch.setattr(
        boot,
        "component_status",
        lambda **_k: {
            "ffmpeg": {"ready": True},
            "whisper": {"ready": True},
            "rnnoise": {"ready": True},
        },
    )
    out = boot.run_bootstrap(["ffmpeg", "whisper", "rnnoise"])
    assert out["ok"] is True


def test_pipeline_run_job_cancel_and_error(tmp_path, monkeypatch) -> None:
    from podcast_mcp.gui.jobs import PipelineJob, PipelineJobManager, StepTiming, shared_job_manager
    from podcast_mcp.util.progress import CancelledProgress

    proj = tmp_path / "ep.json"
    proj.write_text("{}")
    mgr = PipelineJobManager()
    mgr._finished_limit = 1

    job = PipelineJob(
        id="jcancel",
        project_path=str(proj),
        from_step=None,
        only_step="clean_audio",
    )
    job.steps.append(StepTiming(name="clean_audio", started_at=0.0, status="running"))

    class FakeSvc:
        def run(self, **_kwargs):
            raise CancelledProgress("Pipeline cancelled")

        def render_preview(self, **_kwargs):
            return {"ok": False, "error": "no premix"}

    class FakeWs:
        pass

    monkeypatch.setattr(
        "podcast_mcp.gui.jobs.ProjectWorkspace.open",
        lambda _p: FakeWs(),
    )
    monkeypatch.setattr("podcast_mcp.gui.jobs.PipelineService", lambda _ws: FakeSvc())
    mgr._run_job(job)
    assert job.status == "cancelled"

    order: list[str] = []
    orig_close = _JobProgressReporter.close
    orig_publish = PipelineJob.publish

    def _close(self: _JobProgressReporter) -> None:
        order.append("close")
        orig_close(self)

    def _publish(self: PipelineJob, event: dict | None) -> None:
        if isinstance(event, dict) and event.get("type") == "done":
            order.append("done")
        orig_publish(self, event)

    monkeypatch.setattr(_JobProgressReporter, "close", _close)
    monkeypatch.setattr(PipelineJob, "publish", _publish)

    job_order = PipelineJob(
        id="jorder",
        project_path=str(proj),
        from_step=None,
        only_step="clean_audio",
    )
    mgr._run_job(job_order)
    assert order[:2] == ["close", "done"]
    assert job_order.started_at is not None
    assert job_order.last_progress_at is not None

    job2 = PipelineJob(
        id="jerr",
        project_path=str(proj),
        from_step=None,
        only_step=None,
        kind="render_preview",
    )
    job2.steps.append(StepTiming(name="render", started_at=0.0, status="running"))
    mgr._run_job(job2)
    assert job2.status == "error"

    # Archive eviction
    mgr._archive_job(job)
    mgr._archive_job(job2)
    assert mgr.get_job("jerr") is not None

    # cancel / get_job / shared manager / busy spawn
    assert mgr.cancel() is None
    mgr._job = job2
    job2.status = "ok"
    assert mgr.cancel(job2.id) is job2
    job2.status = "running"
    assert mgr.cancel("nope") is None
    assert mgr.cancel(job2.id) is job2
    assert mgr.get_job() is job2
    shared_job_manager(reset=True)
    busy = shared_job_manager()
    busy._job = PipelineJob(
        id="busy",
        project_path=str(proj),
        from_step=None,
        only_step=None,
        status="running",
    )
    try:
        busy.start(proj)
        raise AssertionError("expected busy error")
    except RuntimeError as exc:
        assert "already running" in str(exc)

    # Successful run that was cancel-requested mid-flight
    job3 = PipelineJob(
        id="jok",
        project_path=str(proj),
        from_step=None,
        only_step="clean_audio",
        cancel_requested=True,
    )
    job3.steps.append(StepTiming(name="clean_audio", started_at=0.0, status="running"))

    class OkSvc:
        def run(self, **_kwargs):
            return None

    monkeypatch.setattr("podcast_mcp.gui.jobs.PipelineService", lambda _ws: OkSvc())
    mgr._run_job(job3)
    assert job3.status == "cancelled"


def test_timed_command_emits_on_active_task(monkeypatch, capsys) -> None:
    from podcast_mcp.cli.timed import timed_command

    monkeypatch.setattr(sys.stderr, "isatty", lambda: True)

    @timed_command("unit")
    def work():
        return 7

    rec = RecordingProgress()
    with bind_progress(rec), progress_task("op", "Op", reporter=rec):
        assert work() == 7
    assert any(e.message and "Running unit" in e.message for e in rec.events)
    assert "Finished unit" in capsys.readouterr().err


def test_progress_task_fail_then_cancelled_progress() -> None:
    rec = RecordingProgress()
    with pytest.raises(CancelledProgress):
        with progress_task("job", "Job", reporter=rec) as p:
            p.fail("gave up")
            raise CancelledProgress("later cancel")
    kinds = [e.kind for e in rec.events]
    assert "fail" in kinds


def test_progress_task_fail_then_runtime_error_skips_second_fail() -> None:
    rec = RecordingProgress()
    with pytest.raises(RuntimeError, match="after fail"):
        with progress_task("job", "Job", reporter=rec) as p:
            p.set_phase("mid", "halfway")
            p.fail("gave up")
            raise RuntimeError("after fail")
    assert sum(1 for e in rec.events if e.kind == "fail") == 1


def test_cli_progress_disabled_and_rich_end_without_total(monkeypatch) -> None:
    from podcast_mcp.util.progress import CliProgressReporter

    disabled = CliProgressReporter(enabled=False)
    disabled.start("t", "Quiet", total=1)
    disabled.fail("t", message="nope")
    disabled.cancel("t", message="stop")
    disabled.end("t")
    disabled.close()

    monkeypatch.setattr(sys.stderr, "isatty", lambda: True)
    rich = CliProgressReporter(enabled=True)
    rich.start("u", "Indeterminate", total=None)
    rich.end("u")  # rich bar present, but no state.total → skip completed= update
    rich.start("v", "Gone")
    rich._finish_task("v")  # leave bar entry without task state
    rich.fail("v", message="orphan")
    rich.cancel("w", message="never started")
    rich.close()


def test_cli_progress_heartbeat(monkeypatch) -> None:
    import time

    from podcast_mcp.util.progress import CliProgressReporter

    monkeypatch.setattr(sys.stderr, "isatty", lambda: False)
    reporter = CliProgressReporter(enabled=True)
    reporter._heartbeat_sec = 0.01
    reporter.start("t", "Long", total=2)
    time.sleep(1.2)
    reporter.end("t")
    reporter.close()


def test_elapsed_mixin_heartbeat_drops_finished_task(monkeypatch) -> None:
    import threading
    import time

    from podcast_mcp.util.progress import ElapsedProgressMixin

    class Probe(ElapsedProgressMixin):
        def __init__(self) -> None:
            super().__init__()
            self._heartbeat_sec = 0.01
            self.emitted: list[str] = []

        def _emit_heartbeat(self, task_id: str, state, elapsed_sec: float) -> None:
            self.emitted.append(task_id)
            # Simulate finish between stale snapshot and last_emit write.
            with self._lock:
                self._tasks.pop(task_id, None)

    probe = Probe()
    probe._register_task("t", "Task", 1)
    with probe._lock:
        probe._tasks["t"].last_emit = time.monotonic() - 1.0
    probe._stop = threading.Event()
    # One loop iteration: wait returns False once, then True to exit.
    waits = iter([False, True])
    monkeypatch.setattr(probe._stop, "wait", lambda _timeout: next(waits))
    probe._heartbeat_loop()
    assert probe.emitted == ["t"]


def test_bootstrap_job_manager_cancel_and_error(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import BootstrapJobManager

    mgr = BootstrapJobManager()
    assert mgr.cancel() is None
    assert mgr.get_job() is None

    job = BootstrapJob(id="b2", components=["ffmpeg"])
    job.status = "running"
    mgr._job = job
    assert mgr.get_job() is job
    assert mgr.get_job("b2") is job
    assert mgr.cancel("nope") is None
    assert mgr.cancel("b2") is job
    assert job.cancel_requested is True

    done = BootstrapJob(id="b3", components=["ffmpeg"], status="ok")
    mgr._job = done
    assert mgr.cancel("b3") is done
    assert mgr.get_job("missing") is None

    pre = BootstrapJob(id="b-pre", components=["ffmpeg"], cancel_requested=True)
    mgr._run_job(pre)
    assert pre.status == "cancelled"

    def boom(*_a, **_k):
        raise RuntimeError("bootstrap exploded")

    monkeypatch.setattr("podcast_mcp.gui.bootstrap_jobs.run_bootstrap", boom)
    err_job = BootstrapJob(id="b4", components=["ffmpeg"])
    mgr._run_job(err_job)
    assert err_job.status == "error"
    assert "exploded" in (err_job.error or "")


def test_job_progress_reporter_non_pipeline_task() -> None:
    job = PipelineJob(
        id="j2",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        total=4,
        current=1,
    )
    reporter = _JobProgressReporter(job)
    reporter.start("step", "Step label", total=9)  # must not overwrite job.total
    assert job.total == 4
    reporter.update("step", 2, total=9, message="still going")
    assert job.current == 1
    assert job.message == "still going"
    reporter.update("pipeline", 3, total=None, message=None)
    assert job.current == 3
    assert job.total == 4
    job.steps.append(StepTiming(name="clean_audio", started_at=0.0, status="ok"))
    reporter.update(
        "pipeline",
        3,
        message="Completed clean_audio: already finished",
    )  # last step not running
    reporter.fail("pipeline", message=None)  # skip error assignment
    assert job.error is None
    reporter.close()


def test_sse_sink_requires_live_job_and_subscribers() -> None:
    mgr = PipelineJobManager()
    assert mgr.listening_progress_reporter() is None
    assert mgr.sse_subscriber_count() == 0

    live = PipelineJob(
        id="live",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=0.0,
        message="Pipeline",
    )
    finished = PipelineJob(
        id="done",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="ok",
    )
    mgr._job = live
    assert mgr.listening_progress_reporter() is None
    assert mgr.add_sse_subscriber_for(finished) is False
    assert mgr.sse_subscriber_count() == 0
    assert mgr.add_sse_subscriber_for(live) is True
    mgr.add_sse_subscriber()
    assert mgr.sse_subscriber_count() == 2
    mgr.remove_sse_subscriber()
    assert mgr.sse_subscriber_count() == 1

    reporter = mgr.listening_progress_reporter()
    assert isinstance(reporter, _SsePublishReporter)
    reporter.message("tool", "Running steal")
    reporter.fail("tool", message="hijack")
    assert live.message == "Pipeline"
    assert live.error is None
    stolen = []
    while True:
        try:
            item = live.events.get_nowait()
        except Empty:
            break
        if isinstance(item, dict):
            stolen.append(item.get("kind"))
    assert stolen == []
    reporter.message("pipeline", "Owned wrap")
    reporter.fail("pipeline", message="pipeline fail")
    kinds = []
    while True:
        try:
            item = live.events.get_nowait()
        except Empty:
            break
        if isinstance(item, dict):
            kinds.append(item.get("kind"))
    assert "message" in kinds
    assert "fail" in kinds

    live.status = "ok"
    reporter.start("tool", "after done")
    extra = []
    while True:
        try:
            extra.append(live.events.get_nowait())
        except Empty:
            break
    assert extra == []


def test_gui_sse_progress_sink_skips_without_listener() -> None:
    from podcast_mcp.gui.jobs import gui_sse_progress_sink, shared_job_manager

    shared_job_manager(reset=True)
    assert gui_sse_progress_sink() is None


def test_bootstrap_result_not_ok(monkeypatch) -> None:
    from podcast_mcp.gui.bootstrap_jobs import BootstrapJobManager

    monkeypatch.setattr(
        "podcast_mcp.gui.bootstrap_jobs.run_bootstrap",
        lambda *_a, **_k: {
            "ok": False,
            "results": {"ffmpeg": {"ok": False, "error": "missing bin"}},
        },
    )
    job = BootstrapJob(id="b-fail", components=["ffmpeg"])
    BootstrapJobManager()._run_job(job)
    assert job.status == "error"
    assert "missing bin" in (job.error or "")


def test_pipeline_runner_selection_errors(minimal_project) -> None:
    from podcast_mcp.models import load_project
    from podcast_mcp.pipeline.runner import PipelineRunner, select_pipeline_steps

    assert select_pipeline_steps(None, "clean_audio", {"clean_audio"}) == []
    try:
        select_pipeline_steps(None, "nope", set())
        raise AssertionError("expected")
    except ValueError:
        pass
    try:
        select_pipeline_steps("nope", None, set())
        raise AssertionError("expected")
    except ValueError:
        pass

    proj = load_project(minimal_project)
    runner = PipelineRunner(defaults={})
    try:
        runner.run(proj, skip_steps=["not_a_step"], unattended=True)
        raise AssertionError("expected")
    except ValueError as exc:
        assert "unknown skip_steps" in str(exc)
    try:
        runner.run(proj, only_step="clean_audio", skip_steps=["clean_audio"], unattended=True)
        raise AssertionError("expected")
    except ValueError as exc:
        assert "no pipeline steps" in str(exc)


def test_last_progress_at_ignores_snapshot_keepalive() -> None:
    import time

    job = PipelineJob(
        id="stale",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=time.monotonic(),
        last_progress_at=42.0,
        message="Quiet step",
    )
    job._sse_listeners = 1
    reporter = _JobProgressReporter(job)
    try:
        snap = job.snapshot()
        assert snap["last_progress_at"] == 42.0
        time.sleep(0.02)
        keep = job.snapshot()
        assert keep["last_progress_at"] == 42.0
        assert keep["elapsed_sec"] >= snap["elapsed_sec"]

        reporter.start("pipeline", "Pipeline", total=1)
        bumped = job.last_progress_at
        assert bumped is not None and bumped != 42.0

        headline = job.message
        reporter.heartbeat("pipeline")
        assert job.message == headline
        assert job.last_progress_at is not None
        assert job.last_progress_at >= bumped
        reporter.heartbeat("pipeline", message="still working")
        assert job.message == "still working"

        reporter.end("pipeline", message="done")
        after_end = job.last_progress_at
        reporter.heartbeat("pipeline")
        reporter.heartbeat("pipeline", message="resurrect")
        assert job.last_progress_at == after_end
        assert job.message == "done"
        assert "pipeline" not in reporter._tasks
        kinds = []
        while True:
            try:
                item = job.events.get_nowait()
            except Empty:
                break
            if isinstance(item, dict):
                kinds.append(item.get("kind"))
        assert "heartbeat" in kinds
        assert kinds[-1] == "end"
    finally:
        reporter.close()


def test_job_reporter_mixin_heartbeat_bumps_last_progress_at(monkeypatch) -> None:
    import time

    job = PipelineJob(
        id="hb",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=time.monotonic(),
        message="Pipeline",
    )
    job._sse_listeners = 1
    reporter = _JobProgressReporter(job)
    reporter._heartbeat_sec = 0.01
    try:
        reporter.start("pipeline", "Pipeline", total=1)
        first = job.last_progress_at
        assert first is not None
        with reporter._lock:
            reporter._tasks["pipeline"].last_emit = time.monotonic() - 1.0
        waits = iter([False, True])
        monkeypatch.setattr(reporter._stop, "wait", lambda _timeout: next(waits))
        reporter._heartbeat_loop()
        assert job.last_progress_at is not None
        assert job.last_progress_at >= first
        assert job.message == "Pipeline"
        kinds = []
        while True:
            try:
                item = job.events.get_nowait()
            except Empty:
                break
            if isinstance(item, dict):
                kinds.append(item.get("kind"))
        assert "heartbeat" in kinds
    finally:
        reporter.close()


def test_mixin_heartbeat_does_not_reregister_finished_task() -> None:
    import time

    job = PipelineJob(
        id="dead",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=time.monotonic(),
        message="Pipeline",
    )
    job._sse_listeners = 1
    reporter = _JobProgressReporter(job)
    try:
        reporter.start("pipeline", "Pipeline", total=1)
        reporter.end("pipeline", message="done")
        after_end = job.last_progress_at
        reporter._emit_heartbeat("pipeline", object(), 12.0)
        assert "pipeline" not in reporter._tasks
        assert job.last_progress_at == after_end
        kinds = []
        while True:
            try:
                item = job.events.get_nowait()
            except Empty:
                break
            if isinstance(item, dict):
                kinds.append(item.get("kind"))
        assert kinds.count("heartbeat") == 0
        assert kinds[-1] == "end"
    finally:
        reporter.close()


def test_job_reporter_refuses_emit_after_close() -> None:
    import time

    job = PipelineJob(
        id="closed",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=time.monotonic(),
        message="Pipeline",
    )
    job._sse_listeners = 1
    reporter = _JobProgressReporter(job)
    reporter.start("pipeline", "Pipeline", total=1)
    reporter.close()
    last = job.last_progress_at
    reporter.heartbeat("pipeline")
    reporter.start("pipeline", "again")
    reporter.update("pipeline", 1, message="late")
    reporter.message("pipeline", "late-msg")
    reporter.end("pipeline")
    reporter.fail("pipeline", message="late-fail")
    reporter.cancel("pipeline", message="late-cancel")
    assert job.last_progress_at == last
    assert job.message == "Pipeline"
    kinds = []
    types = []
    while True:
        try:
            item = job.events.get_nowait()
        except Empty:
            break
        if isinstance(item, dict):
            types.append(item.get("type"))
            kinds.append(item.get("kind"))
    assert "heartbeat" not in kinds
    assert types[-1] != "done"
