"""The guest pipeline twins: job status, events and cancel for Editors."""

from __future__ import annotations

import asyncio
import copy
import json
import threading
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from model_pin_helpers import isolate_model_env
from podcast_mcp.gui import job_events
from podcast_mcp.gui.routes import sse_common
from podcast_mcp.gui.schemas import GuestPipelineRunRequest, GuestRequest
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.jobs import (
    GUEST_PIPELINE_KINDS,
    Job,
    guest_status_view,
)
from podcast_mcp.services.jobs.job import GUEST_JOB_VIEW, GuestJobView
from podcast_mcp.services.pipeline import config_store
from podcast_mcp.util.coded_error import GENERIC_GUEST_MESSAGE

CODE = "x-sharecut-error-code"
RELAYED = {"x-sharecut-relayed": "1"}
NOT_FOUND = {"detail": "Job not found"}
PREFIX = "/api/review/{token}/daw/pipeline"


@pytest.fixture
def world(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.delenv("PODCAST_GUEST_RENDER", raising=False)
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="Pipeline")["id"]
    tokens = {
        role: ShareService(ws).create(
            review_version_id=version, capabilities=capabilities_for_role(role)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    app = create_app()
    world = SimpleNamespace(
        client=TestClient(app), app=app, ws=ws, tokens=tokens, share=ShareService(ws)
    )
    world.slot = lambda job: setattr(app.state.jobs._catalog, "_job", job)
    return world


def _job(world, kind="pipeline", status="running", path=None, **fields) -> Job:
    job = Job(
        id=f"{kind}-1",
        kind=kind,
        status=status,
        project_path=str(world.ws.path if path is None else path),
        **fields,
    )
    world.slot(job)
    return job


def _urls(world, job_id: str, role: str = "editor") -> dict[str, tuple[str, str]]:
    base = PREFIX.format(token=world.tokens[role])
    return {
        "status": ("GET", f"{base}/jobs/{job_id}"),
        "events": ("GET", f"{base}/jobs/{job_id}/events"),
        "cancel": ("POST", f"{base}/jobs/{job_id}/cancel"),
    }


def test_the_editor_reads_the_status_of_a_running_pipeline_job(world) -> None:
    _job(world, current=2, total=7, error="/host/secret.wav", message="/host/log line")

    res = world.client.get(_urls(world, "pipeline-1")["status"][1])

    assert res.status_code == 200
    assert res.json()["job"] == {
        "id": "pipeline-1",
        "status": "running",
        "current": 2,
        "total": 7,
        "message": "Running pipeline",
        "error": None,
    }
    assert "/host" not in res.text


def test_a_failed_job_shows_fixed_copy_never_the_host_error(world) -> None:
    _job(world, status="error", error="boom at /home/host/ep/raw.wav")

    body = world.client.get(_urls(world, "pipeline-1")["status"][1]).json()["job"]

    assert body["error"] == "Pipeline failed"
    assert body["message"] is None


def test_the_project_status_lists_only_visible_jobs_of_this_project(world) -> None:
    _job(world)
    token = world.tokens["editor"]

    res = world.client.get(f"{PREFIX.format(token=token)}/status")

    assert res.status_code == 200
    body = res.json()
    assert body["running"] is True
    assert body["job"]["id"] == "pipeline-1"
    assert [j["id"] for j in body["jobs"]] == ["pipeline-1"]
    assert str(world.ws.path.parent) not in res.text

    _job(world, kind="export")
    hidden = world.client.get(f"{PREFIX.format(token=token)}/status").json()
    assert hidden == {"running": False, "job": None, "jobs": []}


def _snap(job_id: str, kind: str, path: Path | str, status: str = "ok") -> dict:
    return {
        "id": job_id,
        "kind": kind,
        "project_path": str(path),
        "status": status,
        "current": 1,
        "total": 1,
    }


def test_the_project_status_drops_other_projects_empty_paths_and_other_kinds(tmp_path) -> None:
    project = tmp_path / "a" / "episode.sharecut"
    snaps = [
        _snap("own", "pipeline", project),
        _snap("other", "pipeline", tmp_path / "b"),
        _snap("bare", "pipeline", ""),
        _snap("agent", "agent", project),
        _snap("render", "render_preview", project),
    ]

    view = guest_status_view({"jobs": snaps}, project, GUEST_PIPELINE_KINDS)

    assert [j["id"] for j in view["jobs"]] == ["own"]
    assert view["job"]["id"] == "own"
    assert view["running"] is False


def test_the_project_status_picks_the_live_job_and_ignores_a_hidden_newer_one(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    snaps = [
        _snap("analyze", "analyze", project, "running"),
        _snap("old", "pipeline", project),
        _snap("live", "pipeline", project, "running"),
    ]

    view = guest_status_view({"jobs": snaps}, project, GUEST_PIPELINE_KINDS)

    assert view["running"] is True
    assert view["job"]["id"] == "live"
    assert [j["id"] for j in view["jobs"]] == ["old", "live"]


def test_the_project_status_matches_a_symlinked_share_path(tmp_path) -> None:
    real = tmp_path / "real" / "episode.sharecut"
    real.parent.mkdir()
    real.write_text("{}")
    link = tmp_path / "link.sharecut"
    link.symlink_to(real)
    snaps = [_snap("own", "pipeline", real)]

    for share_path in (real, link):
        view = guest_status_view({"jobs": snaps}, share_path, GUEST_PIPELINE_KINDS)
        assert [j["id"] for j in view["jobs"]] == ["own"]


def test_status_clients_read_jobs_and_running(world) -> None:
    _job(world, kind="analyze")

    body = world.client.get(f"{PREFIX.format(token=world.tokens['editor'])}/status").json()

    assert set(body) == {"running", "job", "jobs"}
    assert body == {"running": False, "job": None, "jobs": []}
    _job(world)
    body = world.client.get(f"{PREFIX.format(token=world.tokens['editor'])}/status").json()
    assert body["running"] is True
    assert [j["id"] for j in body["jobs"]] == ["pipeline-1"]


@pytest.mark.parametrize("which", ["status", "events", "cancel"])
@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_a_lesser_role_is_refused(world, which, role) -> None:
    _job(world)
    method, url = _urls(world, "pipeline-1", role)[which]

    res = world.client.request(method, url)

    assert res.status_code == 403
    assert res.headers[CODE] == "share_capability_required"


@pytest.mark.parametrize("which", ["status", "events", "cancel"])
def test_a_revoked_token_is_404_with_the_share_code(world, which) -> None:
    _job(world)
    method, url = _urls(world, "pipeline-1")[which]
    world.share.revoke(world.tokens["editor"])

    res = world.client.request(method, url)

    assert res.status_code == 404
    assert res.headers[CODE] == "share_not_found"


@pytest.mark.parametrize("which", ["status", "events", "cancel"])
def test_every_job_a_guest_may_not_reach_answers_the_same_404(world, which) -> None:
    cases = {
        "unknown": None,
        "other project": Job(id="job-x", kind="pipeline", project_path="/elsewhere/ep.sharecut"),
        "host analyze": Job(id="job-x", kind="analyze", project_path=str(world.ws.path)),
        "host export": Job(id="job-x", kind="export", project_path=str(world.ws.path)),
        "agent, no path": Job(id="job-x", kind="agent"),
        "pipeline, no path": Job(id="job-x", kind="pipeline", project_path=""),
        "bootstrap": Job.bootstrap("job-x", ["whisper"]),
    }
    seen = set()
    for name, job in cases.items():
        world.slot(job)
        method, url = _urls(world, "job-x")[which]
        res = world.client.request(method, url)
        assert res.status_code == 404, name
        seen.add((json.dumps(res.json()), res.headers[CODE]))
    assert seen == {(json.dumps(NOT_FOUND), "job_not_found")}
    assert world.app.state.jobs.get_job("job-x") is not None


def test_cancel_stops_a_job_of_the_share_with_the_flag_off(world) -> None:
    job = _job(world)

    res = world.client.post(_urls(world, "pipeline-1")["cancel"][1])

    assert res.status_code == 200
    assert job.cancel_requested
    assert res.json()["job"]["id"] == "pipeline-1"
    assert str(world.ws.path.parent) not in res.text


def test_cancel_of_a_finished_job_answers_like_the_owner_route(world) -> None:
    _job(world, status="ok")

    res = world.client.post(_urls(world, "pipeline-1")["cancel"][1])
    owner = world.client.post("/api/pipeline/cancel", json={"job_id": "pipeline-1"})

    assert res.status_code == owner.status_code == 200
    assert res.json()["job"]["status"] == owner.json()["job"]["status"] == "ok"
    assert not world.app.state.jobs.get_job("pipeline-1").cancel_requested


@pytest.mark.parametrize("which", ["status", "events", "cancel"])
def test_a_render_preview_job_is_not_served_by_the_pipeline_routes(world, which) -> None:
    job = _job(world, kind="render_preview")
    method, url = _urls(world, job.id)[which]

    res = world.client.request(method, url)

    assert (res.status_code, res.json()) == (404, NOT_FOUND)
    assert res.headers[CODE] == "job_not_found"
    assert not job.cancel_requested


def test_a_pipeline_job_is_not_served_by_the_render_preview_status(world) -> None:
    _job(world)

    res = world.client.get(f"/api/review/{world.tokens['editor']}/daw/render-preview/pipeline-1")

    assert (res.status_code, res.json()) == (404, NOT_FOUND)


def test_the_render_preview_status_still_serves_a_render_preview_job(world) -> None:
    _job(world, kind="render_preview")

    res = world.client.get(
        f"/api/review/{world.tokens['editor']}/daw/render-preview/render_preview-1"
    )

    assert res.status_code == 200
    assert res.json()["job"]["message"] == "Rendering preview"


def test_the_guest_mcp_job_tool_does_not_read_a_pipeline_job(world, monkeypatch) -> None:
    from podcast_mcp.services.remote_mcp import tools as rt
    from podcast_mcp.util.coded_error import CodedKeyError

    jobs = world.app.state.jobs
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: SimpleNamespace(workspace=world.ws),
    )
    monkeypatch.setattr("podcast_mcp.services.jobs.shared_job_manager", lambda: jobs)
    _job(world)

    with pytest.raises(CodedKeyError) as raised:
        rt.guest_render_preview_job("pipeline-1")
    assert raised.value.code == "job_not_found"

    _job(world, kind="render_preview")
    assert rt.guest_render_preview_job("render_preview-1")["job"]["id"] == "render_preview-1"


def test_cancel_never_touches_a_host_job_of_the_same_project(world) -> None:
    job = _job(world, kind="export")

    res = world.client.post(_urls(world, "export-1")["cancel"][1])

    assert res.status_code == 404
    assert not job.cancel_requested


def test_status_and_events_work_with_the_flag_off(world) -> None:
    _job(world, status="ok")
    urls = _urls(world, "pipeline-1")

    assert world.client.get(urls["status"][1]).status_code == 200
    assert world.client.get(urls["events"][1]).status_code == 200


def test_the_events_of_a_finished_job_are_one_projected_done_frame(world) -> None:
    _job(world, status="error", error="/host/secret", message="/host/log", result={"paths": ["/h"]})

    res = world.client.get(_urls(world, "pipeline-1")["events"][1])

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    frames = [json.loads(f.removeprefix("data: ")) for f in res.text.split("\n\n") if f]
    assert [f["type"] for f in frames] == ["done"]
    assert frames[0]["job"]["error"] == "Pipeline failed"
    assert "/host" not in res.text and "project_path" not in res.text


def test_the_stream_closes_when_the_link_is_revoked(world, monkeypatch) -> None:
    _job(world)
    monkeypatch.setattr(
        sse_common,
        "stream_guest_job_events",
        partial(job_events.stream_guest_job_events, keepalive_sec=0.01, recheck_sec=0.0),
    )
    url = _urls(world, "pipeline-1")["events"][1]
    frames: list[str] = []
    with world.client.stream("GET", url) as res:
        for line in res.iter_lines():
            if not line.startswith("data: "):
                continue
            frames.append(line)
            if len(frames) == 2:
                world.share.revoke(world.tokens["editor"])
    assert 2 <= len(frames) <= 6
    assert {json.loads(f.removeprefix("data: "))["type"] for f in frames} == {"status"}


async def _collect(stream, limit=50) -> list[dict]:
    frames = []
    async for frame in stream:
        frames.append(json.loads(frame.removeprefix("data: ")))
        if len(frames) >= limit:
            break
    return frames


def _stream(job, project, kinds=GUEST_PIPELINE_KINDS, token="tok", **kwargs):
    lease = job_events.GUEST_STREAM_SLOTS.acquire(token)
    assert lease is not None
    kwargs.setdefault("still_shared", lambda: True)
    return job_events.stream_guest_job_events(
        job, project, kinds, lease=lease, keepalive_sec=0.005, **kwargs
    )


def _slots_free(token: str) -> bool:
    slots = job_events.GUEST_STREAM_SLOTS
    leases = [slots.acquire(token) for _ in range(job_events.GUEST_STREAMS_PER_SHARE)]
    for lease in leases:
        if lease is not None:
            lease.release()
    return all(leases)


def test_a_project_change_mid_stream_stops_the_stream(tmp_path) -> None:
    project = tmp_path / "a" / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="running")

    async def go() -> list[dict]:
        frames = []
        async for frame in _stream(job, project):
            frames.append(json.loads(frame.removeprefix("data: ")))
            if len(frames) == 2:
                job.project_path = str(tmp_path / "b" / "episode.sharecut")
        return frames

    assert len(asyncio.run(go())) == 2


def test_a_share_that_stops_reaching_the_project_stops_the_stream(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="running")
    live = threading.Event()
    live.set()

    async def go() -> list[dict]:
        frames = []
        stream = _stream(job, project, still_shared=live.is_set, recheck_sec=0.0)
        async for frame in stream:
            frames.append(json.loads(frame.removeprefix("data: ")))
            if len(frames) == 2:
                live.clear()
        return frames

    assert len(asyncio.run(go())) == 2


def test_the_stream_ends_after_its_lifetime(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="running")

    frames = asyncio.run(_collect(_stream(job, project, max_sec=0.05)))

    assert 1 <= len(frames) < 50


def test_a_stream_that_ends_with_the_job_sends_done_once(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="running")

    async def go() -> list[dict]:
        frames = []
        async for frame in _stream(job, project):
            frames.append(json.loads(frame.removeprefix("data: ")))
            if len(frames) == 2:
                job.status = "cancelled"
        return frames

    types = [f["type"] for f in asyncio.run(go())]
    assert types == ["status", "status", "done"]


def test_the_stream_frames_are_the_projection_not_raw_events(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="running")
    job.error = "/host/err"
    job.publish({"type": "progress", "path": "/host/raw.wav", "log": "secret"})

    frames = asyncio.run(_collect(_stream(job, project), limit=3))

    for frame in frames:
        assert set(frame["job"]) == {"id", "status", "current", "total", "message", "error"}
    assert "/host" not in json.dumps(frames)


def test_open_streams_per_link_are_capped(world) -> None:
    _job(world, status="ok")
    slots = job_events.GUEST_STREAM_SLOTS
    token = world.tokens["editor"]
    held = [slots.acquire(token) for _ in range(job_events.GUEST_STREAMS_PER_SHARE)]
    try:
        res = world.client.get(_urls(world, "pipeline-1")["events"][1])
        assert None not in held
        assert res.status_code == 429
        assert res.headers[CODE] == "rate_limited"
        assert res.headers["retry-after"] == "5"
        assert slots.acquire(token) is None
    finally:
        for lease in held:
            lease.release()
    assert world.client.get(_urls(world, "pipeline-1")["events"][1]).status_code == 200
    assert _slots_free(token)


def test_a_burst_of_opens_gets_exactly_the_cap_and_never_an_empty_200() -> None:
    slots = job_events.GuestStreamSlots()
    opens = job_events.GUEST_STREAMS_PER_SHARE + 8
    gate = threading.Barrier(opens)
    got: list[object] = []

    def open_one() -> None:
        gate.wait()
        got.append(slots.acquire("tok"))

    threads = [threading.Thread(target=open_one) for _ in range(opens)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sum(lease is not None for lease in got) == job_events.GUEST_STREAMS_PER_SHARE
    assert sum(lease is None for lease in got) == 8


def test_releasing_a_lease_twice_frees_one_slot(tmp_path) -> None:
    slots = job_events.GuestStreamSlots()
    first = slots.acquire("tok")
    others = [slots.acquire("tok") for _ in range(job_events.GUEST_STREAMS_PER_SHARE - 1)]
    first.release()
    first.release()

    assert slots.acquire("tok") is not None
    assert slots.acquire("tok") is None
    assert None not in others


def test_a_finished_stream_gives_its_slot_back(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="ok")

    for _ in range(job_events.GUEST_STREAMS_PER_SHARE + 2):
        assert [f["type"] for f in asyncio.run(_collect(_stream(job, project)))] == ["done"]

    assert _slots_free("tok")


def test_a_client_that_goes_away_gives_its_slot_back(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="running")

    async def go() -> None:
        stream = _stream(job, project)
        await anext(stream)
        assert not _slots_free("tok")
        await stream.aclose()

    asyncio.run(go())

    assert _slots_free("tok")


def test_a_failed_subscribe_gives_its_slot_back(tmp_path, monkeypatch) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="pipeline", project_path=str(project), status="running")

    def refuse(*_args, **_kwargs):
        raise RuntimeError("no loop")

    monkeypatch.setattr(job_events.job_events_hub(), "subscribe", refuse)

    with pytest.raises(RuntimeError):
        asyncio.run(_collect(_stream(job, project)))

    assert _slots_free("tok")


def test_the_stream_of_a_job_of_another_kind_ends_without_a_frame(tmp_path) -> None:
    project = tmp_path / "episode.sharecut"
    job = Job(id="j", kind="render_preview", project_path=str(project), status="running")

    assert asyncio.run(_collect(_stream(job, project))) == []
    assert _slots_free("tok")


def test_the_view_table_is_immutable_and_names_its_terminal_statuses() -> None:
    with pytest.raises(TypeError):
        GUEST_JOB_VIEW["bounce"] = GuestJobView("x", "y")  # type: ignore[index]
    for view in GUEST_JOB_VIEW.values():
        assert view.failure <= view.terminal


def test_every_view_kind_is_a_job_kind() -> None:
    from typing import get_args

    from podcast_mcp.services.jobs import JobKind

    assert set(GUEST_JOB_VIEW) <= set(get_args(JobKind))


def test_owner_routes_keep_their_behaviour(world) -> None:
    job = _job(world)
    jobs = world.app.state.jobs

    status = world.client.get("/api/pipeline/status")
    events_missing = world.client.get("/api/pipeline/events", params={"job_id": "nope"})
    cancel_missing = world.client.post("/api/pipeline/cancel", json={"job_id": "nope"})
    cancel = world.client.post("/api/pipeline/cancel", json={"job_id": job.id})

    assert status.status_code == 200
    assert set(status.json()) == {"running", "job", "jobs", "running_count"}
    for res in (events_missing, cancel_missing):
        assert res.status_code == 404
        assert res.json() == {"detail": "No pipeline job"}
        assert res.headers[CODE] == "job_not_found"
    assert cancel.status_code == 200
    assert cancel.json()["job"]["project_path"] == job.project_path
    assert jobs.get_job(job.id).cancel_requested


def test_relayed_owner_status_events_and_cancel_are_refused(world) -> None:
    calls = (
        world.client.get("/api/pipeline/status", headers=RELAYED),
        world.client.get("/api/pipeline/events", headers=RELAYED),
        world.client.post("/api/pipeline/cancel", json={"job_id": "x"}, headers=RELAYED),
    )
    for res in calls:
        assert res.status_code == 403
        assert res.headers[CODE] == "authz_denied"


def test_only_the_pipeline_start_needs_the_render_flag() -> None:
    rows = {n: r for n, r in GUEST_OWNER_ROUTES.items() if n.startswith("pipeline_")}
    assert len(rows) == 5
    assert [n for n, r in rows.items() if r.needs_guest_render] == ["pipeline_run"]
    assert rows["pipeline_job_cancel"].rate_kind == "mutate"
    assert rows["pipeline_run"].rate_kind == "mutate"


@pytest.fixture
def runner(world, monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    gate, started, finished = threading.Event(), threading.Event(), threading.Event()
    calls: list[dict] = []

    def fake_run(self, **kwargs):
        calls.append(kwargs)
        started.set()
        try:
            gate.wait(5)
        finally:
            finished.set()
        return SimpleNamespace(last_step=None, job_result=dict)

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", fake_run)
    for name in ("ensure_whisper_cached_for_run", "ensure_word_aligner_for_run"):
        monkeypatch.setattr(f"podcast_mcp.gui.routes.pipeline_jobs.{name}", lambda *_a, **_k: None)
    world.gate, world.started, world.calls = gate, started, calls
    yield world
    gate.set()
    if started.is_set():
        assert finished.wait(5)


RUN_URL = PREFIX + "/run"


def _run(world, role: str = "editor", **body):
    return world.client.post(RUN_URL.format(token=world.tokens[role]), json=body)


def _working_set(world) -> dict:
    return copy.deepcopy(vars(config_store().peek(world.ws.path)))


@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_a_lesser_role_cannot_start_a_run(runner, role) -> None:
    res = _run(runner, role)

    assert res.status_code == 403
    assert res.headers[CODE] == "share_capability_required"
    assert runner.calls == []
    assert not runner.app.state.jobs.status()["running"]


def test_a_revoked_link_cannot_start_a_run(runner) -> None:
    runner.share.revoke(runner.tokens["editor"])

    res = _run(runner)

    assert res.status_code == 404
    assert res.headers[CODE] == "share_not_found"
    assert runner.calls == []


def test_the_start_needs_the_host_opt_in(runner, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_GUEST_RENDER")

    res = _run(runner)

    assert (res.status_code, res.headers[CODE]) == (403, "share_capability_required")
    assert runner.calls == []


def test_the_editor_starts_a_run_and_gets_only_the_projection(runner) -> None:
    res = _run(runner)

    assert res.status_code == 202
    assert set(res.json()) == {"job"}
    job = res.json()["job"]
    assert set(job) == {"id", "status", "current", "total", "message", "error"}
    assert str(runner.ws.path.parent) not in res.text
    for hidden in ("project_path", "config", "log", "skip_steps", "from_step"):
        assert hidden not in res.text
    assert runner.app.state.jobs.get_job(job["id"]).kind == "pipeline"


@pytest.mark.parametrize(
    "field",
    [
        {"path": "/etc"},
        {"config": {"transcribe": {"model": "tiny"}}},
        {"use_working_set": False},
        {"unattended": False},
        {"enabled_steps": ["ingest_tracks"]},
        {"overwrite_edited": True},
        {"skip_steps": ["ingest_tracks"] * 25},
    ],
)
def test_the_run_body_refuses_what_only_the_host_may_send(runner, field) -> None:
    res = _run(runner, **field)

    assert res.status_code == 422
    assert runner.calls == []


def test_the_run_body_models_only_the_run_choices() -> None:
    assert issubclass(GuestPipelineRunRequest, GuestRequest)
    assert set(GuestPipelineRunRequest.model_fields) == {
        "from_step",
        "only_step",
        "skip_steps",
        "force_transcribe",
        "retime_words",
    }


@pytest.mark.parametrize(
    ("field", "code"),
    [
        ({"from_step": "nope"}, "pipeline_from_step_unknown"),
        ({"only_step": "nope"}, "pipeline_only_step_unknown"),
        ({"skip_steps": ["nope"]}, "pipeline_skip_steps_unknown"),
    ],
)
def test_bad_step_names_answer_the_owner_codes(runner, field, code) -> None:
    res = _run(runner, **field)
    owner = runner.client.post("/api/pipeline/run", json={"path": str(runner.ws.path), **field})

    assert res.status_code == owner.status_code == 400
    assert res.headers[CODE] == owner.headers[CODE] == code
    assert res.json() == owner.json()
    assert runner.calls == []


@pytest.mark.parametrize("field", ["from_step", "only_step"])
def test_a_guest_cannot_select_the_export_step(runner, field) -> None:
    res = _run(runner, **{field: "export_deliverables"})

    assert res.status_code == 400
    assert res.headers[CODE] == "pipeline_step_not_shared"
    assert res.json() == {"detail": "That step is not available on a share link."}
    assert runner.calls == []


@pytest.mark.parametrize("skip", [None, [], ["align_tracks"], ["export_deliverables"]])
def test_a_guest_run_always_skips_the_export_step(runner, skip) -> None:
    body = {} if skip is None else {"skip_steps": skip}

    assert _run(runner, **body).status_code == 202
    assert runner.started.wait(5)

    steps = runner.calls[0]["skip_steps"]
    assert steps.count("export_deliverables") == 1
    if skip:
        assert set(skip) <= set(steps)


def test_the_run_uses_the_host_working_set(runner) -> None:
    config_store().put(
        runner.ws.path,
        config={"transcribe": {"model": "tiny.en"}},
        enabled_steps=["ingest_tracks", "transcribe_tracks"],
    )
    staged = config_store().peek(runner.ws.path)

    res = _run(runner, only_step="transcribe_tracks")

    assert res.status_code == 202
    assert runner.started.wait(5)
    (call,) = runner.calls
    assert call["config"] == staged.config
    assert call["only_step"] == "transcribe_tracks"
    assert call["unattended"] is True
    assert "align_tracks" in call["skip_steps"]
    assert "ingest_tracks" not in call["skip_steps"]


def test_a_run_with_nothing_staged_is_unattended(runner) -> None:
    assert _run(runner).status_code == 202
    assert runner.started.wait(5)

    assert runner.calls[0]["unattended"] is True


def test_an_attended_working_set_is_refused_before_any_job(runner) -> None:
    config_store().put(runner.ws.path, unattended=False)

    res = _run(runner)

    assert (res.status_code, res.headers[CODE]) == (409, "pipeline_attended")
    assert res.json() == {
        "detail": "The host set this project to attended runs; ask the host to start it."
    }
    assert runner.calls == []
    assert not runner.app.state.jobs.status()["running"]


def test_a_guest_run_never_changes_the_working_set(runner) -> None:
    config_store().put(
        runner.ws.path, config={"transcribe": {"model": "tiny.en"}}, enabled_steps=["ingest_tracks"]
    )
    before = _working_set(runner)

    res = _run(runner, force_transcribe=True, skip_steps=["align_tracks"])

    assert res.status_code == 202
    assert _working_set(runner) == before


def test_a_guest_run_stages_no_working_set(runner) -> None:
    assert config_store().peek(runner.ws.path) is None

    assert _run(runner).status_code == 202

    assert config_store().peek(runner.ws.path) is None


def test_a_guest_run_never_writes_through_the_store(runner, monkeypatch) -> None:
    def refuse(*_a, **_k):
        raise AssertionError("a guest must not write the working set")

    store_type = type(config_store())
    monkeypatch.setattr(store_type, "put", refuse)
    monkeypatch.setattr(store_type, "_put_locked", refuse)

    assert _run(runner, force_transcribe=True).status_code == 202


def test_the_staged_config_is_not_shared_with_the_run(runner) -> None:
    config_store().put(runner.ws.path, config={"transcribe": {"model": "tiny.en"}})

    assert _run(runner).status_code == 202
    assert runner.started.wait(5)

    assert runner.calls[0]["config"] is not config_store().peek(runner.ws.path).config


def test_force_transcribe_is_run_only_config(runner) -> None:
    res = _run(runner, force_transcribe=True)

    assert res.status_code == 202
    assert runner.started.wait(5)
    transcribe = runner.calls[0]["config"]["transcribe"]
    assert transcribe["overwrite"] is True
    assert transcribe["overwrite_edited"] is False
    assert (
        config_store().get(runner.ws.path, stage=False).config["transcribe"]["overwrite"] is False
    )


def test_force_with_retime_words_is_the_owner_400(runner) -> None:
    body = {"force_transcribe": True, "retime_words": True}
    res = _run(runner, **body)
    owner = runner.client.post("/api/pipeline/run", json={"path": str(runner.ws.path), **body})

    assert res.status_code == owner.status_code == 400
    assert res.headers[CODE] == owner.headers[CODE] == "pipeline_retime_with_force"
    assert runner.calls == []


def test_a_second_start_while_a_job_runs_is_409_job_running(runner) -> None:
    first = _run(runner)
    second = _run(runner)

    assert first.status_code == 202
    assert second.status_code == 409
    assert second.headers[CODE] == "job_running"
    assert second.json() == {"detail": GENERIC_GUEST_MESSAGE}
    assert str(runner.ws.path.parent) not in second.text


@pytest.mark.parametrize("kind", ["render_preview", "analyze", "export"])
def test_a_host_job_holding_the_slot_is_the_same_409(runner, kind) -> None:
    job = _job(runner, kind=kind)

    res = _run(runner)

    assert (res.status_code, res.headers[CODE]) == (409, "job_running")
    assert res.json() == {"detail": GENERIC_GUEST_MESSAGE}
    assert job.id not in res.text
    assert runner.calls == []


def test_a_crash_while_starting_is_the_fixed_500(runner, monkeypatch) -> None:
    def refuse(*_a, **_k):
        raise RuntimeError(f"cannot start at {runner.ws.path}")

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.JobManager.start", refuse)

    res = _run(runner)

    assert (res.status_code, res.headers[CODE]) == (500, "internal_error")
    assert str(runner.ws.path.parent) not in res.text


def _no_download(monkeypatch, tmp_path) -> list[object]:
    isolate_model_env(monkeypatch, tmp_path)
    cache = tmp_path / "empty"
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: cache)
    reached: list[object] = []

    def download(*a, **_k):
        reached.append(a)
        raise AssertionError("a guest run must not download")

    import huggingface_hub

    cache_lookup = huggingface_hub.snapshot_download

    def snapshot_download(*a, **k):
        if k.get("local_files_only"):
            return cache_lookup(*a, **k)
        return download(*a)

    monkeypatch.setattr("huggingface_hub.snapshot_download", snapshot_download)
    monkeypatch.setattr("podcast_mcp.services.pipeline.bootstrap.install_model", download)
    monkeypatch.setattr("podcast_mcp.services.pipeline.bootstrap.run_bootstrap", download)
    monkeypatch.setattr(
        "podcast_mcp.services.jobs.manager.JobManager.start",
        lambda *a, **k: reached.append(("start", a)),
    )
    return reached


MODEL_NEEDED = {
    "detail": "The host needs to download a model first; ask the host to open ShareCut Studio."
}


def test_a_missing_model_is_the_coded_409_and_nothing_downloads(
    world, monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    reached = _no_download(monkeypatch, tmp_path)

    res = _run(world, only_step="transcribe_tracks")

    assert (res.status_code, res.headers[CODE]) == (409, "model_needed")
    assert res.json() == MODEL_NEEDED
    assert "bootstrap" not in res.text
    assert reached == []
    assert not (tmp_path / "empty").exists()
    assert not world.app.state.jobs.status()["running"]


def test_retime_words_without_the_aligner_is_the_coded_409(world, monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    reached = _no_download(monkeypatch, tmp_path)
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.pipeline_jobs.ensure_whisper_cached_for_run", lambda **_k: None
    )

    res = _run(world, only_step="transcribe_tracks", retime_words=True)

    assert (res.status_code, res.headers[CODE]) == (409, "model_needed")
    assert res.json() == MODEL_NEEDED
    assert reached == []
    assert not world.app.state.jobs.status()["running"]


def test_an_unusable_aligner_override_is_the_same_409(world, monkeypatch, tmp_path) -> None:
    from podcast_mcp.engines.models.word_aligner import WORD_ALIGNER_ENV

    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    reached = _no_download(monkeypatch, tmp_path)
    monkeypatch.setenv(WORD_ALIGNER_ENV, str(tmp_path / "no-aligner-here"))
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.pipeline_jobs.ensure_whisper_cached_for_run", lambda **_k: None
    )

    res = _run(world, only_step="transcribe_tracks", retime_words=True)

    assert (res.status_code, res.headers[CODE]) == (409, "model_needed")
    assert res.json() == MODEL_NEEDED
    assert str(tmp_path) not in res.text
    assert reached == []


def test_a_started_run_is_visible_and_cancellable_through_the_twins(runner) -> None:
    job_id = _run(runner).json()["job"]["id"]
    urls = _urls(runner, job_id)

    status = runner.client.get(urls["status"][1])
    listing = runner.client.get(f"{PREFIX.format(token=runner.tokens['editor'])}/status")
    cancel = runner.client.post(urls["cancel"][1])

    assert status.status_code == 200
    assert status.json()["job"]["id"] == job_id
    assert [j["id"] for j in listing.json()["jobs"]] == [job_id]
    assert cancel.status_code == 200
    assert runner.app.state.jobs.get_job(job_id).cancel_requested
    events = runner.client.get(urls["events"][1])
    assert events.status_code == 200
    assert "project_path" not in events.text


def test_the_owner_run_keeps_its_behaviour(runner) -> None:
    path = str(runner.ws.path)

    res = runner.client.post(
        "/api/pipeline/run",
        json={"path": path, "config": {"transcribe": {"model": "tiny.en"}}, "unattended": False},
    )

    assert res.status_code == 200
    job = res.json()["job"]
    assert job["kind"] == "pipeline"
    assert job["project_path"] == str(runner.ws.path.resolve())
    staged = config_store().peek(runner.ws.path)
    assert staged.config["transcribe"]["model"] == "tiny.en"
    assert staged.unattended is False
    busy = runner.client.post("/api/pipeline/run", json={"path": path})
    assert (busy.status_code, busy.headers[CODE]) == (409, "job_running")


def test_the_owner_run_derives_skip_steps_from_the_staged_steps(runner) -> None:
    config_store().put(runner.ws.path, enabled_steps=["ingest_tracks"])

    res = runner.client.post("/api/pipeline/run", json={"path": str(runner.ws.path)})

    assert res.status_code == 200
    assert runner.started.wait(5)
    skipped = runner.calls[0]["skip_steps"]
    assert "ingest_tracks" not in skipped
    assert "export_deliverables" in skipped


def test_the_owner_run_writes_the_working_set_before_the_model_check(
    world, monkeypatch, tmp_path
) -> None:
    _no_download(monkeypatch, tmp_path)

    res = world.client.post(
        "/api/pipeline/run",
        json={
            "path": str(world.ws.path),
            "config": {"transcribe": {"model": "tiny.en"}},
            "only_step": "transcribe_tracks",
        },
    )

    assert (res.status_code, res.headers[CODE]) == (409, "model_needed")
    assert config_store().peek(world.ws.path).config["transcribe"]["model"] == "tiny.en"


def test_the_owner_run_without_the_working_set_writes_nothing(runner) -> None:
    res = runner.client.post(
        "/api/pipeline/run", json={"path": str(runner.ws.path), "use_working_set": False}
    )

    assert res.status_code == 200
    assert config_store().peek(runner.ws.path) is None


def test_a_relayed_owner_run_is_refused(world) -> None:
    res = world.client.post("/api/pipeline/run", json={"path": str(world.ws.path)}, headers=RELAYED)

    assert res.status_code == 403
    assert res.headers[CODE] == "authz_denied"
