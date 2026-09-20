from __future__ import annotations

from pathlib import Path
from queue import Empty

import pytest

from podcast_mcp.gui.jobs import (
    AgentJobFanInReporter,
    PipelineJob,
    PipelineJobManager,
    _JobProgressReporter,
    gui_agent_job_progress_sink,
    shared_job_manager,
)
from podcast_mcp.util.progress import bind_progress, progress_task


def _drain(job: PipelineJob) -> list[dict]:
    items: list[dict] = []
    while True:
        try:
            item = job.events.get_nowait()
        except Empty:
            break
        if isinstance(item, dict):
            items.append(item)
    return items


def test_gui_agent_job_progress_sink_skips_without_studio_manager() -> None:
    import podcast_mcp.gui.jobs as jobs_mod

    prior = jobs_mod._SHARED_JOBS
    try:
        jobs_mod._SHARED_JOBS = None
        assert gui_agent_job_progress_sink() is None
    finally:
        jobs_mod._SHARED_JOBS = prior


def test_instant_tool_does_not_create_agent_job() -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    with bind_progress(sink), progress_task("list_clips_tool", "list_clips_tool", reporter=sink):
        pass
    sink._on_lazy_timer()
    assert mgr.status()["job"] is None
    assert mgr.status()["running_count"] == 0
    assert mgr._agent_live == {}


def test_rich_mcp_wrap_creates_agent_job_and_sse_payload() -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    with bind_progress(sink), progress_task("align_tracks", "align_tracks", reporter=sink) as task:
        task.advance(1, message="Scoring bleed windows")
        job = sink._job
        assert job is not None
        assert job.kind == "agent"
        assert job.tool_id == "align_tracks"
        snap = job.snapshot()
        assert snap["kind"] == "agent"
        assert snap["tool_id"] == "align_tracks"
        assert snap["label"] == "align_tracks"
        assert snap["message"] == "Scoring bleed windows"
        assert snap["project_path"] == ""
        assert mgr.add_sse_subscriber_for(job) is True
        task.advance(2, message="Still scoring")
        events = _drain(job)
        assert any(
            item.get("type") == "progress" and (item.get("job") or {}).get("kind") == "agent"
            for item in events
        )
    st = mgr.status()
    assert st["job"] is not None
    assert st["job"]["kind"] == "agent"
    assert st["job"]["status"] == "ok"
    assert st["running"] is False
    assert mgr._agent_live == {}


def test_agent_fanin_inherits_served_project_and_scopes_status(tmp_path) -> None:
    """Standalone agent wraps belong to the currently served project (#170)."""
    mgr = PipelineJobManager()
    served = (tmp_path / "served" / "episode.project.json").resolve()
    other = (tmp_path / "other" / "episode.project.json").resolve()
    mgr.set_served_project(served)
    sink = AgentJobFanInReporter(mgr)
    sink.start("align_tracks", "Align tracks")
    sink.update("align_tracks", 1, message="Scoring")
    assert sink._job is not None
    assert sink._job.project_path == str(served)
    assert [row["id"] for row in mgr.status(str(served))["jobs"]] == [sink._job.id]
    assert mgr.status(str(other))["jobs"] == []
    sink.end("align_tracks")


def test_heartbeat_or_lazy_timer_creates_agent_job() -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    sink.start("transcribe_tracks", "Transcribing tracks")
    assert sink._job is None
    sink.heartbeat("transcribe_tracks")
    assert sink._job is not None
    assert sink._job.kind == "agent"
    first = sink._job.last_progress_at
    assert first is not None
    headline = sink._job.message
    sink.heartbeat("transcribe_tracks")
    assert sink._job.message == headline
    assert sink._job.last_progress_at is not None
    assert sink._job.last_progress_at >= first
    sink.end("transcribe_tracks", message="done")
    assert sink._job.status == "ok"

    sink2 = AgentJobFanInReporter(mgr)
    sink2.start("mix_with_music", "Mix")
    sink2._on_lazy_timer()
    assert sink2._job is not None
    sink2.end("mix_with_music")


def test_agent_job_coexists_with_pipeline_job() -> None:
    mgr = PipelineJobManager()
    pipeline = PipelineJob(
        id="pipe",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=1.0,
        kind="pipeline",
    )
    mgr._job = pipeline
    sink = AgentJobFanInReporter(mgr)
    sink.start("tighten_from_transcript", "tighten_from_transcript")
    sink.update("tighten_from_transcript", 1, message="Removing fillers")
    agent = sink._job
    assert agent is not None
    st = mgr.status()
    assert st["running_count"] == 2
    kinds = {row["kind"] for row in st["jobs"]}
    assert kinds == {"pipeline", "agent"}
    try:
        mgr.start(Path("/tmp/p.json"))
        raise AssertionError("pipeline lock should still apply")
    except RuntimeError as exc:
        assert "already running" in str(exc)
    sink.end("tighten_from_transcript")
    assert agent.status == "ok"
    assert pipeline.status == "running"


def test_agent_job_fail_strips_traceback_and_does_not_stay_running() -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    with pytest.raises(RuntimeError, match="boom"):
        with (
            bind_progress(sink),
            progress_task("align_tracks", "align_tracks", reporter=sink) as task,
        ):
            task.advance(1, message="working")
            raise RuntimeError("boom\nTraceback (most recent call last):\n  File")
    job = sink._job
    assert job is not None
    assert job.status == "error"
    assert job.error is not None
    assert "Traceback" not in job.error
    assert "File" not in job.error
    assert job.error.startswith("align_tracks failed")
    assert mgr.status()["running"] is False


def test_agent_job_cancel_maps_to_cancelled() -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    sink.start("focus_from_transcript", "focus")
    sink.message("focus_from_transcript", "cutting tangents")
    sink.cancel("focus_from_transcript", message="stopped")
    assert sink._job is not None
    assert sink._job.status == "cancelled"
    assert sink._job.message == "stopped"
    assert sink._job.error is None


@pytest.mark.asyncio
async def test_install_mcp_progress_fans_into_shared_agent_job() -> None:
    from podcast_mcp.util.progress import (
        clear_progress_sinks,
        current_progress_task,
        install_mcp_progress,
        register_progress_sink,
    )

    clear_progress_sinks()
    shared_job_manager(reset=True)
    register_progress_sink(gui_agent_job_progress_sink)

    class FakeServer:
        def add_tool(self, fn, name=None, **kwargs):
            return None

        async def call_tool(self, name, arguments, context=None, *args, **kwargs):
            task = current_progress_task()
            assert task is not None
            task.advance(1, message="working")
            return {"ok": name}

    server = FakeServer()
    install_mcp_progress(server)
    try:
        result = await server.call_tool("align_tracks", {})
        assert result["ok"] == "align_tracks"
        st = shared_job_manager().status()
        assert st["job"] is not None
        assert st["job"]["kind"] == "agent"
        assert st["job"]["tool_id"] == "align_tracks"
        assert st["job"]["status"] == "ok"
    finally:
        clear_progress_sinks()
        shared_job_manager(reset=True)


def test_agent_fanin_child_events_helpers_and_lookups() -> None:
    from podcast_mcp.gui.jobs import _gui_fail_message

    assert _gui_fail_message(None) is None
    assert _gui_fail_message("   ") is None
    assert _gui_fail_message("Traceback (most recent call last):") is None
    assert _gui_fail_message("Traceback (most recent call last):", phase="align") == "align"
    assert _gui_fail_message("\n", phase="mix") == "mix"

    mgr = PipelineJobManager()
    mgr.add_sse_subscriber()
    mgr._job = PipelineJob(
        id="done-pipe",
        project_path="/tmp/ep.json",
        from_step=None,
        only_step=None,
        status="ok",
        kind="pipeline",
    )
    assert mgr.listening_progress_reporter() is None

    pipe = PipelineJob(
        id="pipe-live",
        project_path="/tmp/ep.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=1.0,
        kind="pipeline",
    )
    mgr._job = pipe
    sink = AgentJobFanInReporter(mgr)
    sink.start("align_tracks", "align_tracks", total=4)
    sink.update("align_tracks", 1, total=4, message="go")
    job = sink._job
    assert job is not None
    assert mgr.get_job(job.id) is job
    claimed = mgr.adopt_agent_job(
        tool_id="align_tracks",
        label="align_tracks",
        claim=sink._claim,
    )
    assert claimed is job
    assert job.project_path == "/tmp/ep.json"

    wrap_headline = job.message
    sink.start("child", "Child pass", total=2)
    assert job.message == wrap_headline
    sink.update("child", 1, message="child work")
    sink.message("child", "child headline")
    sink.end("child", message="child done")
    sink.start("child2", "c2")
    sink.fail("child2", message="child boom", phase="mid")
    sink.start("child3", "c3")
    sink.cancel("child3", message="child stop")
    sink.heartbeat("align_tracks", message="still going")
    sink.update("align_tracks", 2, message="again")
    sink.end("align_tracks", message="wrap done")
    assert job.status == "ok"
    mgr.complete_agent_job(job, status="error", message="nope")
    assert job.status == "ok"
    assert mgr.get_job(job.id) is job

    sink2 = AgentJobFanInReporter(mgr)
    sink2.start("late", "late")
    sink2._closed = True
    sink2.start("late", "late")
    sink2._wrap_task_id = None
    sink2._on_lazy_timer()

    shared_job_manager(reset=True)
    assert gui_agent_job_progress_sink() is not None


def test_agent_fanin_closed_and_child_before_job() -> None:
    from podcast_mcp.gui.jobs import _gui_fail_message, _SsePublishReporter

    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    sink.start("wrap", "wrap")
    sink.start("child", "child")
    sink.end("child")
    sink.start("c2", "c2")
    sink.fail("c2", message="boom")
    sink.start("c3", "c3")
    sink.cancel("c3", message="stop")
    sink._closed = True
    sink.update("wrap", 1, message="late")
    sink.message("wrap", "late-msg")
    assert sink._job is None
    sink.end("wrap")

    instant = AgentJobFanInReporter(mgr)
    instant.start("quick", "quick")
    instant.cancel("quick", message="never mind")
    assert instant._job is None

    with_job = AgentJobFanInReporter(mgr)
    with_job.start("slow", "slow")
    with_job.message("slow", "working")
    with_job.start("nested", "nested")
    with_job.end("nested")
    with_job.start("nested-fail", "nf")
    with_job.fail("nested-fail", message="nf")
    with_job.start("nested-cancel", "nc")
    with_job.cancel("nested-cancel", message="nc")
    with_job.end("slow")

    racing = AgentJobFanInReporter(mgr)
    racing.start("race", "race")
    real_adopt = mgr.adopt_agent_job

    def _adopt(*, tool_id: str, label: str, claim: str, project_path: str = "") -> PipelineJob:
        job = real_adopt(
            tool_id=tool_id,
            label=label,
            claim=claim,
            project_path=project_path,
        )
        racing._closed = True
        racing._terminal = None
        return job

    mgr.adopt_agent_job = _adopt  # type: ignore[method-assign]
    racing.update("race", 1, message="mid")
    assert racing._job is not None
    assert racing._job.status in ("cancelled", "ok", "error")

    dup = AgentJobFanInReporter(mgr)
    dup.start("dup", "dup")
    real2 = mgr.adopt_agent_job
    pre = PipelineJob(
        id="pre-existing",
        project_path="",
        from_step=None,
        only_step=None,
        kind="agent",
        status="running",
    )

    captured: list[PipelineJob] = []

    def _adopt_dup(
        *,
        tool_id: str,
        label: str,
        claim: str,
        project_path: str = "",
    ) -> PipelineJob:
        job = real2(
            tool_id=tool_id,
            label=label,
            claim=claim,
            project_path=project_path,
        )
        captured.append(job)
        dup._job = pre
        return job

    mgr.adopt_agent_job = _adopt_dup  # type: ignore[method-assign]
    dup.update("dup", 1, message="keep-existing")
    assert dup._job is pre
    assert captured[0].status == "cancelled"
    assert captured[0].id not in mgr._agent_live

    only_agent = PipelineJobManager()
    agent_live = only_agent.adopt_agent_job(
        tool_id="t",
        label="T",
        claim="c1",
        project_path="/tmp/p.json",
    )
    assert only_agent.add_sse_subscriber_for(agent_live) is True
    assert only_agent.get_job(agent_live.id) is agent_live
    st = only_agent.status()
    assert st["job"]["kind"] == "agent"
    assert st["running_count"] == 1
    only_agent.complete_agent_job(agent_live, status="ok", message="done")
    st2 = only_agent.status()
    assert st2["running"] is False
    assert st2["job"]["id"] == agent_live.id

    sse_mgr = PipelineJobManager()
    ghost = _SsePublishReporter(sse_mgr)
    ghost.start("t", "nope")
    sse_mgr._job = PipelineJob(
        id="sse",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=1.0,
    )
    sse_mgr.add_sse_subscriber()
    reporter = _SsePublishReporter(sse_mgr)
    reporter.start("t", "lab")
    reporter.update("t", 1, message="m")
    stolen = []
    while True:
        try:
            stolen.append(sse_mgr._job.events.get_nowait())
        except Empty:
            break
    assert stolen == []
    reporter.start("pipeline", "lab")
    reporter.update("pipeline", 1, message="m")
    long_fail = _gui_fail_message("x" * 250)
    assert long_fail is not None and len(long_fail) == 200
    assert _gui_fail_message("/Users/host/secret/episode.project.json", phase="align") == "align"
    assert _gui_fail_message("failed at /Users/host/secret/episode.project.json") == "failed at"


def test_ensure_job_completes_orphan_when_post_adopt_raises() -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    sink.start("wrap", "wrap")

    def _boom(job: PipelineJob) -> PipelineJob:
        raise RuntimeError("reporter failed")

    import podcast_mcp.gui.jobs as jobs_mod

    orig = jobs_mod._JobProgressReporter
    jobs_mod._JobProgressReporter = _boom  # type: ignore[misc, assignment]
    try:
        with pytest.raises(RuntimeError, match="reporter failed"):
            sink.update("wrap", 1, message="mid")
    finally:
        jobs_mod._JobProgressReporter = orig
    assert mgr._agent_live == {}
    finished = list(mgr._finished.values())
    assert finished
    assert finished[-1].status == "cancelled"


def test_agent_live_cap_evicts_oldest() -> None:
    mgr = PipelineJobManager()
    mgr._agent_live_limit = 2
    first = mgr.adopt_agent_job(tool_id="a", label="A", claim="c1")
    second = mgr.adopt_agent_job(tool_id="b", label="B", claim="c2")
    third = mgr.adopt_agent_job(tool_id="c", label="C", claim="c3")
    assert first.status == "cancelled"
    assert first.id not in mgr._agent_live
    assert set(mgr._agent_live) == {second.id, third.id}


def test_agent_publish_skips_without_subscriber_and_bounds_queue() -> None:
    from podcast_mcp.gui.jobs import _EVENT_QUEUE_MAX

    mgr = PipelineJobManager()
    job = mgr.adopt_agent_job(tool_id="t", label="T", claim="c")
    reporter = _JobProgressReporter(job)
    reporter.message("t", "silent")
    assert _drain(job) == []
    assert mgr.add_sse_subscriber_for(job) is True
    reporter.message("t", "live")
    events = _drain(job)
    assert events
    assert events[-1].get("message") == "live"
    for i in range(_EVENT_QUEUE_MAX + 8):
        job.publish({"type": "progress", "n": i})
    queued = _drain(job)
    assert len(queued) <= _EVENT_QUEUE_MAX


def test_sse_wrap_events_stay_off_pipeline_when_agent_has_listeners() -> None:
    from podcast_mcp.gui.jobs import _SsePublishReporter

    mgr = PipelineJobManager()
    pipe = PipelineJob(
        id="pipe",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=1.0,
        kind="pipeline",
        message="Pipeline",
    )
    mgr._job = pipe
    agent = mgr.adopt_agent_job(tool_id="align_tracks", label="align", claim="c")
    assert mgr.add_sse_subscriber_for(agent) is True
    assert mgr.listening_progress_reporter() is None
    wrap = _SsePublishReporter(mgr)
    wrap.message("align_tracks", "should not land on pipeline")
    assert _drain(pipe) == []
    assert any(item.get("kind") == "message" for item in _drain(agent))
    mgr.add_sse_subscriber()
    wrap.message("align_tracks", "still agent-owned")
    assert _drain(pipe) == []
    kinds = [item.get("kind") for item in _drain(agent)]
    assert "message" in kinds


def test_pipeline_run_uses_studio_job_lock(tmp_path, monkeypatch) -> None:
    from podcast_mcp.gui.jobs import shared_job_manager
    from podcast_mcp.mcp.tools import pipeline as mcp_pipeline

    proj = tmp_path / "ep.json"
    proj.write_text("{}")

    class FakeWs:
        path = proj

        @classmethod
        def open(cls, _path):
            return cls()

    class FakeSvc:
        def run(self, **_kwargs):
            return "ingest_tracks"

    monkeypatch.setattr("podcast_mcp.mcp.tools.pipeline.ProjectWorkspace.open", FakeWs.open)
    monkeypatch.setattr("podcast_mcp.mcp.tools.pipeline.PipelineService", lambda _ws: FakeSvc())
    monkeypatch.setattr("podcast_mcp.gui.jobs.ProjectWorkspace.open", FakeWs.open)
    monkeypatch.setattr("podcast_mcp.gui.jobs.PipelineService", lambda _ws: FakeSvc())
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline_config.config_store",
        lambda: type(
            "Store",
            (),
            {"get": staticmethod(lambda _p: None), "put": staticmethod(lambda *_a, **_k: None)},
        )(),
    )

    mgr = shared_job_manager(reset=True)
    busy = PipelineJob(
        id="busy",
        project_path=str(proj),
        from_step=None,
        only_step=None,
        status="running",
        kind="pipeline",
    )
    mgr._job = busy
    with pytest.raises(RuntimeError, match="already running"):
        mcp_pipeline.pipeline_run(str(proj), only_step="ingest_tracks", use_working_set=False)

    mgr._job = None
    out = mcp_pipeline.pipeline_run(str(proj), only_step="ingest_tracks", use_working_set=False)
    assert "ingest_tracks" in out
    shared_job_manager(reset=True)


def test_pipeline_run_wrap_does_not_create_agent_job() -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    sink.start("pipeline_run", "pipeline_run")
    sink.update("pipeline_run", 1, message="Running ingest")
    sink._on_lazy_timer()
    assert sink._job is None
    assert mgr._agent_live == {}
    sink.end("pipeline_run")


def test_wait_timeout_and_sse_helpers() -> None:
    from podcast_mcp.gui.jobs import (
        _drop_unread_events,
        _gui_fail_message,
        _token_looks_like_abs_path,
        studio_job_manager,
    )

    assert _token_looks_like_abs_path(".,;") is False
    assert _gui_fail_message(r"C:\host\secret\episode.project.json", phase="align") == "align"
    studio_job_manager()

    mgr = PipelineJobManager()
    mgr.remove_sse_subscriber()
    live = PipelineJob(
        id="wait-me",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
    )
    with pytest.raises(TimeoutError, match="wait-me"):
        mgr.wait(live, timeout=0.01)
    live.status = "ok"
    assert mgr.wait(live) is live

    job = mgr.adopt_agent_job(tool_id="t", label="T", claim="c-end")
    assert mgr.add_sse_subscriber_for(job) is True
    job.close_stream()
    assert mgr.add_sse_subscriber_for(job) is True
    drained = _drain(job)
    assert drained == [] or None in drained
    _drop_unread_events(job)
    mgr.complete_agent_job(job, status="ok", message="done")


def test_agent_finalize_closes_reporter_if_complete_raises(monkeypatch) -> None:
    mgr = PipelineJobManager()
    sink = AgentJobFanInReporter(mgr)
    sink.start("wrap", "wrap")
    sink.message("wrap", "working")
    reporter = sink._job_reporter
    assert reporter is not None

    def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("complete failed")

    monkeypatch.setattr(mgr, "complete_agent_job", _boom)
    with pytest.raises(RuntimeError, match="complete failed"):
        sink.end("wrap", message="done")
    assert reporter._closed
    assert sink._job_reporter is None

    mgr2 = PipelineJobManager()
    closed_fan = AgentJobFanInReporter(mgr2)
    closed_fan.start("late", "late")
    closed_fan.message("late", "go")
    closed_fan.end("late")
    closed_fan.update("late", 1, message="after-close")
    closed_fan.message("late", "after-msg")
    closed_fan.heartbeat("late")
