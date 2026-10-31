"""The guest export twin: an Editor starts the deliverables export and follows it."""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import get_args

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.export.audio import GUEST_EXPORT_FORMATS, M4A_AAC, ExportFormatSpec
from podcast_mcp.gui.schemas import GuestExportRequest, GuestRequest
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService, lookup_share
from podcast_mcp.services.collaboration.share_capabilities import (
    capabilities_for_role,
    share_review_source,
)
from podcast_mcp.services.jobs import GUEST_EXPORT_KINDS, GUEST_PIPELINE_KINDS, Job
from podcast_mcp.util.coded_error import GENERIC_GUEST_MESSAGE
from podcast_mcp.util.proxy_paths import is_allowed_local_gui_path

OPS_LOGGER = "podcast_mcp.services.collaboration.guest_project_ops"
CODE = "x-sharecut-error-code"
RELAYED = {"x-sharecut-relayed": "1"}
NOT_FOUND = {"detail": "Job not found"}
PREFIX = "/api/review/{token}/daw/export"
PROJECTION = {"id", "status", "current", "total", "message", "error"}


@pytest.fixture
def world(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="Export")["id"]
    tokens = {
        role: ShareService(ws).create(
            review_version_id=version, capabilities=capabilities_for_role(role)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    app = create_app()
    gate, started, finished = threading.Event(), threading.Event(), threading.Event()
    calls: list[list[dict] | None] = []

    def fake_export(self, formats=None, **_kwargs):
        calls.append(formats)
        started.set()
        try:
            gate.wait(5)
        finally:
            finished.set()
        return SimpleNamespace(job_result=dict)

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.export_audio", fake_export)
    world = SimpleNamespace(
        client=TestClient(app),
        app=app,
        ws=ws,
        tokens=tokens,
        share=ShareService(ws),
        gate=gate,
        started=started,
        calls=calls,
    )
    world.slot = lambda job: setattr(app.state.jobs._catalog, "_job", job)
    yield world
    gate.set()
    if started.is_set():
        assert finished.wait(5)


def _start(world, role: str = "editor", **body):
    return world.client.post(PREFIX.format(token=world.tokens[role]), json=body)


def _urls(world, job_id: str, role: str = "editor") -> dict[str, tuple[str, str]]:
    base = PREFIX.format(token=world.tokens[role]) + f"/jobs/{job_id}"
    return {
        "status": ("GET", base),
        "events": ("GET", base + "/events"),
        "cancel": ("POST", base + "/cancel"),
    }


def _job(world, kind: str = "export", status: str = "running") -> Job:
    job = Job(id=f"{kind}-1", kind=kind, status=status, project_path=str(world.ws.path))
    world.slot(job)
    return job


@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_a_lesser_role_cannot_start_an_export(world, role) -> None:
    res = _start(world, role)

    assert res.status_code == 403
    assert res.headers[CODE] == "share_capability_required"
    assert world.calls == []
    assert not world.app.state.jobs.status()["running"]


def test_a_revoked_link_cannot_start_an_export(world) -> None:
    world.share.revoke(world.tokens["editor"])

    res = _start(world)

    assert (res.status_code, res.headers[CODE]) == (404, "share_not_found")
    assert world.calls == []


def test_the_start_needs_the_host_opt_in(world, monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_GUEST_RENDER")

    res = _start(world)

    assert (res.status_code, res.headers[CODE]) == (403, "share_capability_required")
    assert world.calls == []


def test_the_editor_starts_an_export_and_gets_only_the_projection(world) -> None:
    res = _start(world)

    assert res.status_code == 202
    assert set(res.json()) == {"job"}
    job = res.json()["job"]
    assert set(job) == PROJECTION
    assert job["message"] == "Exporting deliverables"
    assert str(world.ws.path.parent) not in res.text
    for hidden in ("project_path", "config", "formats", "paths", "export/"):
        assert hidden not in res.text
    assert world.app.state.jobs.get_job(job["id"]).kind == "export"
    assert world.started.wait(5)
    assert world.calls == [None]


def test_named_formats_become_the_hosts_fixed_specs(world) -> None:
    res = _start(world, formats=["m4a", "mp3", "flac"])

    assert res.status_code == 202
    assert world.started.wait(5)
    assert world.calls == [[dict(GUEST_EXPORT_FORMATS[n]) for n in ("m4a", "mp3", "flac")]]
    assert "formats" not in res.text


def test_the_closed_formats_are_the_fixed_specs_and_name_no_path() -> None:
    listed = get_args(GuestExportRequest.model_fields["formats"].annotation)[0]
    names = set(get_args(get_args(listed)[0]))
    assert names == set(GUEST_EXPORT_FORMATS)
    for name, raw in GUEST_EXPORT_FORMATS.items():
        assert set(raw) <= {"ext", "codec", "bitrate_kbps"}
        assert raw["ext"] == name
        spec = ExportFormatSpec.from_dict(dict(raw))
        assert (spec.extra_args, spec.sample_rate, spec.channels) == ((), None, None)
    assert ExportFormatSpec.from_dict(dict(GUEST_EXPORT_FORMATS["m4a"])) == M4A_AAC


@pytest.mark.parametrize(
    "field", ["path", "dest", "output_dir", "filename", "ext", "codec", "extra_args", "config"]
)
def test_the_body_refuses_what_only_the_host_may_send(world, field) -> None:
    res = _start(world, **{field: "../../etc/passwd"})

    assert res.status_code == 422
    assert world.calls == []


def test_the_body_models_only_the_formats() -> None:
    assert issubclass(GuestExportRequest, GuestRequest)
    assert set(GuestExportRequest.model_fields) == {"formats"}


@pytest.mark.parametrize(
    "formats",
    [
        ["wav"],
        ["opus"],
        ["MP3"],
        [".mp3"],
        ["../mp3"],
        ["/etc/passwd"],
        ["mp3", "mp3"],
        ["mp3", "flac", "m4a", "mp3"],
        [],
        "mp3",
        [{"ext": "mp3"}],
        [{"ext": "../x", "extra_args": ["-f", "/tmp/y"]}],
        [None],
    ],
)
def test_a_format_outside_the_enum_is_422(world, formats) -> None:
    res = _start(world, formats=formats)

    assert res.status_code == 422
    assert world.calls == []
    assert not world.app.state.jobs.status()["running"]


def test_a_second_start_while_a_job_runs_is_409_job_running(world) -> None:
    first = _start(world)
    second = _start(world)

    assert first.status_code == 202
    assert second.status_code == 409
    assert second.headers[CODE] == "job_running"
    assert second.json() == {"detail": GENERIC_GUEST_MESSAGE}
    assert str(world.ws.path.parent) not in second.text


@pytest.mark.parametrize("kind", ["pipeline", "render_preview", "analyze"])
def test_another_job_holding_the_slot_is_the_same_409(world, monkeypatch, kind) -> None:
    monkeypatch.setattr("podcast_mcp.services.jobs.manager.EXPORT_PREVIEW_WAIT_S", 3600.0)
    job = _job(world, kind=kind)

    began = time.monotonic()
    res = _start(world)

    assert time.monotonic() - began < 5
    assert (res.status_code, res.headers[CODE]) == (409, "job_running")
    assert res.json() == {"detail": GENERIC_GUEST_MESSAGE}
    assert job.id not in res.text
    assert world.calls == []


def test_a_crash_while_starting_is_the_fixed_500(world, monkeypatch) -> None:
    def refuse(*_a, **_k):
        raise ValueError(f"cannot start at {world.ws.path}")

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.JobManager.start_export", refuse)

    res = _start(world)

    assert (res.status_code, res.headers[CODE]) == (500, "internal_error")
    assert str(world.ws.path.parent) not in res.text


@pytest.mark.parametrize(
    "failure",
    [
        FileNotFoundError("ffmpeg not found at /opt/host/bin/ffmpeg"),
        RuntimeError("encode failed in /home/host/episode/export"),
    ],
)
def test_a_host_failure_shows_fixed_copy_never_the_host_text(world, monkeypatch, failure) -> None:
    def broken(self, formats=None, **_kwargs):
        raise failure

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.export_audio", broken)
    job_id = _start(world).json()["job"]["id"]
    world.app.state.jobs.wait(world.app.state.jobs.get_job(job_id), timeout=5)
    urls = _urls(world, job_id)

    status = world.client.get(urls["status"][1])
    events = world.client.get(urls["events"][1])

    assert status.json()["job"]["status"] == "error"
    assert status.json()["job"]["error"] == "Export failed"
    for text in (status.text, events.text):
        assert "/opt/host" not in text
        assert "/home/host" not in text
        assert "ffmpeg" not in text


def test_a_started_export_is_visible_and_cancellable_through_the_export_twins(world) -> None:
    job_id = _start(world).json()["job"]["id"]
    urls = _urls(world, job_id)

    status = world.client.get(urls["status"][1])
    cancel = world.client.post(urls["cancel"][1])
    events = world.client.get(urls["events"][1])

    assert status.status_code == 200
    assert status.json()["job"]["id"] == job_id
    assert cancel.status_code == 200
    assert set(cancel.json()["job"]) == PROJECTION
    assert world.app.state.jobs.get_job(job_id).cancel_requested
    assert events.status_code == 200
    assert "project_path" not in events.text


def test_the_export_twins_work_with_the_flag_off(world, monkeypatch) -> None:
    job = _job(world)
    monkeypatch.delenv("PODCAST_GUEST_RENDER")
    urls = _urls(world, job.id)

    assert world.client.get(urls["status"][1]).status_code == 200
    assert world.client.post(urls["cancel"][1]).status_code == 200
    assert job.cancel_requested
    job.status = "ok"
    assert world.client.get(urls["events"][1]).status_code == 200


@pytest.mark.parametrize("which", ["status", "events", "cancel"])
@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_a_lesser_role_is_refused_by_the_export_twins(world, which, role) -> None:
    job = _job(world)
    method, url = _urls(world, job.id, role)[which]

    res = world.client.request(method, url)

    assert (res.status_code, res.headers[CODE]) == (403, "share_capability_required")
    assert not job.cancel_requested


@pytest.mark.parametrize("which", ["status", "events", "cancel"])
def test_a_revoked_token_is_404_on_the_export_twins(world, which) -> None:
    job = _job(world)
    method, url = _urls(world, job.id)[which]
    world.share.revoke(world.tokens["editor"])

    res = world.client.request(method, url)

    assert (res.status_code, res.headers[CODE]) == (404, "share_not_found")
    assert not job.cancel_requested


@pytest.mark.parametrize("which", ["status", "events", "cancel"])
def test_every_job_the_export_twins_may_not_reach_answers_the_same_404(world, which) -> None:
    cases = {
        "unknown": None,
        "other project": Job(id="job-x", kind="export", project_path="/elsewhere/ep.sharecut"),
        "no path": Job(id="job-x", kind="export", project_path=""),
        "pipeline": Job(id="job-x", kind="pipeline", project_path=str(world.ws.path)),
        "render preview": Job(id="job-x", kind="render_preview", project_path=str(world.ws.path)),
        "bounce": Job(id="job-x", kind="bounce", project_path=str(world.ws.path)),
        "analyze": Job(id="job-x", kind="analyze", project_path=str(world.ws.path)),
        "agent": Job(id="job-x", kind="agent"),
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
    assert not world.app.state.jobs.get_job("job-x").cancel_requested


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("GET", "pipeline/jobs/{id}"),
        ("GET", "pipeline/jobs/{id}/events"),
        ("POST", "pipeline/jobs/{id}/cancel"),
        ("GET", "render-preview/{id}"),
    ],
)
def test_an_export_job_is_not_served_by_the_other_twins(world, method, suffix) -> None:
    job = _job(world)
    url = f"/api/review/{world.tokens['editor']}/daw/" + suffix.format(id=job.id)

    res = world.client.request(method, url)

    assert (res.status_code, res.json()) == (404, NOT_FOUND)
    assert not job.cancel_requested


def test_the_status_listings_are_per_kind(world) -> None:
    _job(world)
    base = f"/api/review/{world.tokens['editor']}/daw"

    pipeline = world.client.get(f"{base}/pipeline/status").json()
    export = world.client.get(f"{base}/export/status").json()

    assert pipeline == {"running": False, "job": None, "jobs": []}
    assert export["running"] is True
    assert [j["id"] for j in export["jobs"]] == ["export-1"]
    assert set(export["job"]) == PROJECTION
    assert "project_path" not in json.dumps(export)


def test_the_export_listing_finds_a_started_export_and_needs_no_flag(world, monkeypatch) -> None:
    job_id = _start(world).json()["job"]["id"]
    monkeypatch.delenv("PODCAST_GUEST_RENDER")

    res = world.client.get(f"/api/review/{world.tokens['editor']}/daw/export/status")

    assert res.status_code == 200
    assert [j["id"] for j in res.json()["jobs"]] == [job_id]


@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_a_lesser_role_cannot_list_exports(world, role) -> None:
    res = world.client.get(f"/api/review/{world.tokens[role]}/daw/export/status")

    assert (res.status_code, res.headers[CODE]) == (403, "share_capability_required")


def test_the_kind_sets_do_not_overlap() -> None:
    assert not GUEST_EXPORT_KINDS & GUEST_PIPELINE_KINDS
    assert "export" in GUEST_EXPORT_KINDS


def test_the_guest_mcp_job_tool_does_not_read_an_export_job(world, monkeypatch) -> None:
    from podcast_mcp.services.remote_mcp import tools as rt
    from podcast_mcp.util.coded_error import CodedKeyError

    jobs = world.app.state.jobs
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    monkeypatch.setattr(rt, "get_remote_mcp_context", lambda: SimpleNamespace(workspace=world.ws))
    monkeypatch.setattr("podcast_mcp.services.jobs.shared_job_manager", lambda: jobs)
    job = _job(world)

    with pytest.raises(CodedKeyError) as raised:
        rt.guest_render_preview_job(job.id)
    assert raised.value.code == "job_not_found"


def _owner_start(world, **body):
    return world.client.post("/api/export/deliverables", json={"path": str(world.ws.path), **body})


def test_the_owner_export_keeps_its_behaviour(world) -> None:
    spec = {"ext": "mp3", "codec": "libmp3lame", "bitrate_kbps": 96, "extra_args": ["-q:a", "2"]}

    res = _owner_start(world, formats=[spec])

    assert res.status_code == 200
    assert set(res.json()) == {"job_id", "job"}
    assert res.json()["job"]["kind"] == "export"
    assert res.json()["job"]["project_path"] == str(world.ws.path.resolve())
    assert world.started.wait(5)
    assert world.calls == [[spec]]


def test_the_owner_export_busy_slot_is_the_coded_409(world) -> None:
    _job(world, kind="pipeline")

    res = _owner_start(world)

    assert (res.status_code, res.headers[CODE]) == (409, "job_running")
    assert res.json() == {"detail": "Another job is still running. Try again when it finishes."}
    assert world.calls == []


@pytest.mark.parametrize("error", [ValueError("bad"), FileNotFoundError("gone")])
def test_the_owner_export_invalid_request_is_the_coded_400(world, monkeypatch, error) -> None:
    def refuse(*_a, **_k):
        raise error

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.JobManager.start_export", refuse)

    res = _owner_start(world)

    assert (res.status_code, res.headers[CODE]) == (400, "export_request_invalid")
    assert res.json() == {"detail": str(error)}


def test_the_owner_export_conflict_is_the_coded_409(world, monkeypatch) -> None:
    def refuse(*_a, **_k):
        raise RuntimeError("another export")

    monkeypatch.setattr("podcast_mcp.services.jobs.manager.JobManager.start_export", refuse)

    res = _owner_start(world)

    assert (res.status_code, res.headers[CODE]) == (409, "export_job_conflict")
    assert res.json() == {"detail": "another export"}


def test_a_relayed_owner_export_is_refused(world) -> None:
    res = world.client.post(
        "/api/export/deliverables", json={"path": str(world.ws.path)}, headers=RELAYED
    )

    assert (res.status_code, res.headers[CODE]) == (403, "authz_denied")
    assert world.calls == []


def test_the_tunnel_allowlist_admits_the_export_twins_and_not_the_owner_routes() -> None:
    assert not is_allowed_local_gui_path("/api/export/deliverables", "tok")
    assert not is_allowed_local_gui_path("/api/export/bounce", "tok")
    for row in GUEST_OWNER_ROUTES.values():
        if row.name.startswith("export_"):
            assert is_allowed_local_gui_path(row.path.format(token="tok", job_id="j"), "tok")


def test_a_start_logs_the_share_that_started_it_and_no_token(world, caplog) -> None:
    with caplog.at_level(logging.INFO, logger=OPS_LOGGER):
        job_id = _start(world).json()["job"]["id"]

    line = next(r.getMessage() for r in caplog.records if "guest export started" in r.getMessage())
    assert str(share_review_source(lookup_share(world.tokens["editor"]))) in line
    assert world.tokens["editor"][:8] not in line
    assert job_id in line


@pytest.mark.parametrize("name", sorted(GUEST_EXPORT_FORMATS))
def test_each_guest_format_builds_exactly_the_expected_ffmpeg_command(
    world, monkeypatch, tmp_path, name
) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.export.audio import render_audio_formats, resolve_export_formats

    commands: list[list[str]] = []
    monkeypatch.setattr(
        "podcast_mcp.engines.ffmpeg._run_cancellable", lambda cmd, _cancel: commands.append(cmd)
    )
    monkeypatch.setattr(FFmpegEngine, "supports_encode", lambda self, codec, muxer: True)
    engine = FFmpegEngine()
    entry = dict(GUEST_EXPORT_FORMATS[name])
    (spec,) = resolve_export_formats({"formats": [entry]})
    source, out = tmp_path / "master.wav", tmp_path / f"episode.{name}"

    render_audio_formats(engine, source, [(spec, out)], metadata={"title": "T"}, cancel_check=bool)

    args = {
        "mp3": ["-codec:a", "libmp3lame", "-b:a", "128k"],
        "flac": ["-codec:a", "flac"],
        "m4a": ["-f", "ipod", "-codec:a", "aac", "-b:a", "128k"],
    }[name]
    assert commands == [
        [engine.ffmpeg, "-y", "-i", str(source), *args, "-metadata", "title=T", str(out)]
    ]


def test_an_export_holding_the_slot_refuses_an_editor_pipeline_run(
    world, skip_run_preflight
) -> None:
    assert _start(world).status_code == 202

    res = world.client.post(f"/api/review/{world.tokens['editor']}/daw/pipeline/run", json={})

    assert (res.status_code, res.headers[CODE]) == (409, "job_running")
    assert res.json() == {"detail": GENERIC_GUEST_MESSAGE}


def test_a_host_started_export_is_visible_and_cancellable_with_the_fixed_projection(
    world,
) -> None:
    job_id = _owner_start(world).json()["job_id"]
    urls = _urls(world, job_id)

    status = world.client.get(urls["status"][1])
    cancel = world.client.post(urls["cancel"][1])

    assert status.status_code == cancel.status_code == 200
    assert set(status.json()["job"]) == set(cancel.json()["job"]) == PROJECTION
    assert str(world.ws.path.parent) not in status.text + cancel.text
    assert world.app.state.jobs.get_job(job_id).cancel_requested


def test_the_export_start_is_rate_limited_before_anything_else(world, monkeypatch) -> None:
    from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests

    monkeypatch.setenv("PODCAST_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_RPM", "60")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_BURST", "1")
    reset_host_limiters_for_tests(clock=lambda: 0.0)
    try:
        first, second = _start(world), _start(world)
    finally:
        reset_host_limiters_for_tests()

    assert first.status_code == 202
    assert (second.status_code, second.headers[CODE]) == (429, "rate_limited")
