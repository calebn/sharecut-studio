"""Characterization: Studio job fields, snapshot shape, SSE event order, lookup bounds, claims.

Pins what the pipeline-slot, agent and bootstrap jobs do today so the services/jobs
refactor (#1819) can move them without changing a byte the browser or MCP sees.
"""

from __future__ import annotations

import pytest

from job_event_helpers import JobEventTap
from podcast_mcp.engines.models.whisper import DEFAULT_WHISPER_MODEL
from podcast_mcp.services.jobs import GUEST_RENDER_KINDS, Job, JobManager, guest_job_view
from podcast_mcp.services.jobs.job import cancelled_copy

PIPELINE_SNAPSHOT_KEYS = {
    "id",
    "project_path",
    "from_step",
    "only_step",
    "kind",
    "label",
    "tool_id",
    "status",
    "current",
    "total",
    "message",
    "error",
    "error_code",
    "error_model",
    "result",
    "last_progress_at",
    "elapsed_sec",
    "unattended",
    "skip_steps",
    "steps",
}
BOOTSTRAP_SNAPSHOT_KEYS = {
    "id",
    "kind",
    "components",
    "whisper_model",
    "status",
    "current",
    "total",
    "message",
    "error",
    "download",
    "failure",
    "elapsed_sec",
    "result",
}


def test_pipeline_job_defaults_and_snapshot_shape() -> None:
    job = Job(id="p1", project_path="/proj/ep.json", from_step=None, only_step="clean")
    assert (job.status, job.kind, job.label, job.tool_id) == ("queued", "pipeline", None, None)
    assert (job.result, job.started_at, job.finished_at, job.last_progress_at) == (
        None,
        None,
        None,
        None,
    )
    assert (job.error, job.current, job.total, job.message) == (None, None, None, None)
    assert (job.unattended, job.skip_steps, job.config, job.cancel_requested) == (
        False,
        [],
        None,
        False,
    )
    assert (job.steps, job.result_step) == ([], None)
    assert job.snapshot() == {
        "id": "p1",
        "project_path": "/proj/ep.json",
        "from_step": None,
        "only_step": "clean",
        "kind": "pipeline",
        "label": None,
        "tool_id": None,
        "status": "queued",
        "current": None,
        "total": None,
        "message": None,
        "error": None,
        "error_code": None,
        "error_model": None,
        "result": None,
        "last_progress_at": None,
        "elapsed_sec": 0.0,
        "unattended": False,
        "skip_steps": [],
        "steps": [],
    }


def test_pipeline_snapshot_copies_mutable_fields_and_blanks_agent_project() -> None:
    job = Job(
        id="p2",
        project_path="/proj/ep.json",
        from_step="a",
        only_step=None,
        skip_steps=["x"],
        result={"k": 1},
        started_at=10.0,
        finished_at=12.345,
    )
    snap = job.snapshot()
    assert set(snap) == PIPELINE_SNAPSHOT_KEYS
    assert snap["elapsed_sec"] == round(12.345 - 10.0, 2)
    snap["skip_steps"].append("y")
    snap["result"]["k"] = 2
    assert job.skip_steps == ["x"]
    assert job.result == {"k": 1}
    job.kind = "agent"
    assert job.snapshot()["project_path"] == ""


def test_bootstrap_job_defaults_and_snapshot_shape() -> None:
    job = Job.bootstrap("b1", ["whisper"])
    assert (job.whisper_model, job.force, job.status) == (DEFAULT_WHISPER_MODEL, False, "queued")
    assert (job.started_at, job.finished_at, job.error) == (None, None, None)
    assert (job.current, job.total, job.message) == (None, None, None)
    assert (job.result, job.cancel_requested) == (None, False)
    snap = job.snapshot()
    assert set(snap) == BOOTSTRAP_SNAPSHOT_KEYS
    assert snap["kind"] == "bootstrap"
    assert snap["components"] == ["whisper"]
    assert snap["components"] is not job.components
    assert snap["elapsed_sec"] == 0.0


def test_guest_job_view_projection_shape() -> None:
    from pathlib import Path

    job = Job(
        id="r1",
        project_path=str(Path("/tmp/guest.json").resolve()),
        from_step=None,
        only_step=None,
        kind="render_preview",
        status="running",
    )
    assert guest_job_view(job, Path("/tmp/guest.json"), GUEST_RENDER_KINDS) == {
        "id": "r1",
        "status": "running",
        "current": None,
        "total": None,
        "message": "Rendering preview",
        "error": None,
    }
    assert guest_job_view(job, Path("/tmp/other.json"), GUEST_RENDER_KINDS) is None


class _RenderSvc:
    def render_preview(self, *, progress, **_kwargs):
        progress.start("render", "Render preview", total=2)
        progress.update("render", 1, message="halfway")
        progress.update("render", 2)
        progress.end("render", message="done")
        return {"ok": True}


def _stub_services(monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.ProjectWorkspace.open", lambda _p: object()
    )
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.PipelineService", lambda _ws: _RenderSvc()
    )


def test_pipeline_slot_job_publishes_status_then_progress_then_done(tmp_path, monkeypatch) -> None:
    _stub_services(monkeypatch)
    mgr = JobManager()
    job = Job(
        id="evt-order",
        project_path=str(tmp_path),
        from_step=None,
        only_step=None,
        kind="render_preview",
    )
    mgr._catalog._job = job
    with JobEventTap(job.id) as tap:
        mgr._run_job(job)
        events = tap.drain()
    types = [e["type"] for e in events]
    assert types[0] == "status"
    assert types[-1] == "done"
    assert set(types[1:-1]) == {"progress"}
    progress = [e for e in events if e["type"] == "progress"]
    assert [e["kind"] for e in progress] == ["start", "update", "update", "end"]
    assert {e["label"] for e in progress} == {"Render preview"}
    assert progress[1]["message"] == "halfway"
    assert set(events[0]["job"]) == PIPELINE_SNAPSHOT_KEYS
    assert events[0]["job"]["status"] == "running"
    assert events[-1]["job"]["status"] == "ok"
    assert events[-1]["job"]["message"] == "done"
    assert job.status == "ok"
    assert job.finished_at is not None
    assert job.last_progress_at is not None
    # The finished slot job is archived so a poll can still find it.
    assert mgr._finished[job.id] is job


def test_pipeline_slot_job_failure_event_order(tmp_path, monkeypatch) -> None:
    class Boom:
        def render_preview(self, **_kwargs):
            raise RuntimeError("explode at /secret/path now")

    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.ProjectWorkspace.open", lambda _p: object()
    )
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.PipelineService", lambda _ws: Boom())
    mgr = JobManager()
    job = Job(
        id="evt-fail",
        project_path=str(tmp_path),
        from_step=None,
        only_step=None,
        kind="render_preview",
    )
    mgr._catalog._job = job
    with JobEventTap(job.id) as tap:
        mgr._run_job(job)
        events = tap.drain()
    assert [e["type"] for e in events] == ["status", "done"]
    assert events[-1]["job"]["status"] == "error"
    assert events[-1]["job"]["error"] == "explode at now"
    assert events[-1]["job"]["message"] == "explode at now"


def test_finished_job_lookup_is_bounded_to_eight_oldest_first() -> None:
    mgr = JobManager()
    jobs = []
    for i in range(10):
        job = mgr.adopt_agent_job(tool_id=f"t{i}", label=f"L{i}", claim=f"c{i}")
        mgr.complete_agent_job(job, status="ok")
        jobs.append(job)
    assert mgr._finished_limit == 8
    assert len(mgr._finished) == 8
    assert mgr.get_job(jobs[0].id) is None
    assert mgr.get_job(jobs[1].id) is None
    for job in jobs[2:]:
        assert mgr.get_job(job.id) is job


def test_slot_job_is_archived_when_a_successor_replaces_it(tmp_path, monkeypatch) -> None:
    _stub_services(monkeypatch)
    mgr = JobManager()
    first = mgr.start_render_preview(tmp_path / "ep.json")
    mgr.wait(first, timeout=5)
    second = mgr.start_render_preview(tmp_path / "ep.json")
    mgr.wait(second, timeout=5)
    assert mgr.get_job() is second
    assert mgr.get_job(first.id) is first
    assert {row["id"] for row in mgr.status()["jobs"]} == {first.id, second.id}


def test_agent_claim_semantics() -> None:
    mgr = JobManager()
    a = mgr.adopt_agent_job(tool_id="tool", label="Tool", claim="claim-1")
    assert a.kind == "agent"
    assert a.status == "running"
    assert a.tool_id == "tool"
    assert a.message == "Tool"
    assert a.started_at is not None
    assert a.snapshot()["project_path"] == ""
    # Same claim is the same job; another claim is another job.
    assert mgr.adopt_agent_job(tool_id="tool", label="Tool", claim="claim-1") is a
    b = mgr.adopt_agent_job(tool_id="tool", label="Tool", claim="claim-2")
    assert b is not a
    assert mgr.get_job(a.id) is a
    # The agent job never takes the pipeline slot.
    assert mgr.get_job() is None
    assert mgr.status()["running_count"] == 2
    # Completion is idempotent and releases the claim.
    mgr.complete_agent_job(a, status="error", error="first", message="m1")
    finished_at = a.finished_at
    mgr.complete_agent_job(a, status="ok", error="second", message="m2")
    assert (a.status, a.error, a.message, a.finished_at) == ("error", "first", "m1", finished_at)
    again = mgr.adopt_agent_job(tool_id="tool", label="Tool", claim="claim-1")
    assert again is not a
    assert mgr.get_job(a.id) is a  # archived


def test_agent_live_cap_cancels_the_oldest(monkeypatch) -> None:
    mgr = JobManager()
    ticks = iter(range(1000, 2000))
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.catalog.time.monotonic", lambda: float(next(ticks))
    )
    jobs = [mgr.adopt_agent_job(tool_id=f"t{i}", label="L", claim=f"c{i}") for i in range(8)]
    with JobEventTap(jobs[0].id) as tap:
        newest = mgr.adopt_agent_job(tool_id="t8", label="L", claim="c8")
        events = tap.drain()
    assert jobs[0].status == "cancelled"
    assert jobs[0].message == "Replaced by newer activity"
    assert [e["type"] for e in events] == ["done"]
    assert set(mgr._agent_live) == {j.id for j in jobs[1:]} | {newest.id}
    assert mgr.get_job(jobs[0].id) is jobs[0]


def test_bootstrap_lifecycle_event_order_and_fields(monkeypatch) -> None:
    def fake_run(components, *, whisper_model, force, progress, **_extra):
        progress.start("bootstrap", "Downloading", total=2)
        progress.update("bootstrap", 1, message="half")
        progress.end("bootstrap", message="fin")
        return {"ok": True, "results": {}}

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.run_bootstrap", fake_run)
    mgr = JobManager()
    job = Job.bootstrap("boot-1", ["whisper"])
    with JobEventTap(job.id) as tap:
        mgr._run_bootstrap_job(job)
        events = tap.drain()
    assert [e["type"] for e in events] == ["status", "progress", "progress", "progress", "done"]
    assert [e["kind"] for e in events if e["type"] == "progress"] == ["start", "update", "end"]
    assert events[0]["job"]["status"] == "running"
    assert set(events[0]["job"]) == BOOTSTRAP_SNAPSHOT_KEYS
    assert events[1]["label"] == "Downloading"
    assert events[1]["elapsed_sec"] == 0.0
    last = events[-1]["job"]
    assert (last["status"], last["message"], last["result"]) == (
        "ok",
        "Bootstrap complete",
        {"ok": True, "results": {}},
    )
    assert job.finished_at is not None


def test_bootstrap_failed_component_sets_error(monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.run_bootstrap",
        lambda *_a, **_k: {"ok": False, "results": {"whisper": {"ok": False, "error": "no net"}}},
    )
    job = Job.bootstrap("boot-2", ["whisper"])
    JobManager()._run_bootstrap_job(job)
    assert (job.status, job.error, job.message) == ("error", "no net", "no net")


def test_bootstrap_single_flight_and_archive(monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.run_bootstrap",
        lambda *_a, **_k: {"ok": True, "results": {}},
    )
    mgr = JobManager()
    live = Job.bootstrap("live", ["whisper", "ffmpeg"])
    live.status = "running"
    mgr._catalog._bootstrap_job = live
    with pytest.raises(
        RuntimeError, match=r"Another download is already running \(whisper, ffmpeg\)"
    ):
        mgr.start_bootstrap(components=["rnnoise"])
    live.status = "ok"
    nxt, adopted = mgr.start_bootstrap(components=["whisper"])
    assert adopted is False
    assert nxt.id != "live"
    assert mgr.get_bootstrap_job() is nxt
    assert mgr.get_bootstrap_job("live") is live
    assert mgr.get_bootstrap_job("missing") is None
    assert mgr.cancel_bootstrap("live") is None
    assert mgr.cancel_bootstrap() is nxt


def test_bootstrap_slot_is_independent_of_the_pipeline_slot(monkeypatch) -> None:
    from podcast_mcp.services.jobs import JobSlotBusyError

    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.run_bootstrap",
        lambda *_a, **_k: {"ok": True, "results": {}},
    )
    mgr = JobManager()
    pipeline = Job(id="p1", project_path="/tmp/p.json", status="running")
    mgr._catalog._job = pipeline
    download, _ = mgr.start_bootstrap(components=["whisper"])
    assert download.kind == "bootstrap"
    assert mgr.get_job() is pipeline
    assert mgr.get_bootstrap_job() is download
    download.status = "running"
    with pytest.raises(JobSlotBusyError, match="Another download is already running"):
        mgr.start_bootstrap(components=["rnnoise"])
    assert cancelled_copy("bootstrap") == "Bootstrap cancelled"
