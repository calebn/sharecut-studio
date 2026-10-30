"""The guest render-preview URLs: the status codes, bodies and error codes a share guest sees."""

from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

CODE = "x-sharecut-error-code"
CAPABILITY_MESSAGE = "This action isn't available on this link. Ask the host to update its access."


@pytest.fixture
def world(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    release = threading.Event()

    def fake_preview(self, *, rerender=True, progress=None, cancel_check=None):
        release.wait(timeout=5)
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview", fake_preview
    )
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="Parity")["id"]
    tokens = {
        role: ShareService(ws).create(
            review_version_id=version, capabilities=capabilities_for_role(role)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    app = create_app()
    try:
        yield SimpleNamespace(
            client=TestClient(app), app=app, ws=ws, tokens=tokens, share=ShareService(ws)
        )
    finally:
        release.set()


def test_the_render_preview_start_answers_202_with_the_job(world) -> None:
    ok = world.client.post(f"/api/review/{world.tokens['editor']}/daw/render-preview")

    assert ok.status_code == 202
    assert set(ok.json()) == {"job"}
    job = ok.json()["job"]
    assert set(job) == {"id", "status", "current", "total", "message", "error"}
    assert job["error"] is None
    assert str(world.ws.path.parent) not in ok.text


def test_the_render_preview_status_answers_with_the_job(world) -> None:
    token = world.tokens["editor"]
    job_id = world.client.post(f"/api/review/{token}/daw/render-preview").json()["job"]["id"]

    status = world.client.get(f"/api/review/{token}/daw/render-preview/{job_id}")

    assert status.status_code == 200
    assert set(status.json()["job"]) == {"id", "status", "current", "total", "message", "error"}
    assert status.json()["job"]["id"] == job_id
    assert status.json()["job"]["message"] == "Rendering preview"


@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_a_lesser_role_is_refused_with_the_capability_message(world, role) -> None:
    token = world.tokens[role]
    start = world.client.post(f"/api/review/{token}/daw/render-preview")
    status = world.client.get(f"/api/review/{token}/daw/render-preview/any")

    for res in (start, status):
        assert res.status_code == 403
        assert res.json() == {"detail": CAPABILITY_MESSAGE}
        assert res.headers[CODE] == "share_capability_required"


def test_the_start_needs_the_host_opt_in_but_the_status_does_not(world, monkeypatch) -> None:
    token = world.tokens["editor"]
    job_id = world.client.post(f"/api/review/{token}/daw/render-preview").json()["job"]["id"]
    monkeypatch.delenv("PODCAST_GUEST_RENDER")

    start = world.client.post(f"/api/review/{token}/daw/render-preview")
    status = world.client.get(f"/api/review/{token}/daw/render-preview/{job_id}")

    assert (start.status_code, start.headers[CODE]) == (403, "share_capability_required")
    assert status.status_code == 200


def test_a_revoked_or_unknown_token_is_404(world) -> None:
    token = world.tokens["editor"]
    world.share.revoke(token)

    for path, method in (
        (f"/api/review/{token}/daw/render-preview", "post"),
        (f"/api/review/{token}/daw/render-preview/x", "get"),
        ("/api/review/nope/daw/render-preview", "post"),
    ):
        assert getattr(world.client, method)(path).status_code == 404


def test_a_busy_slot_is_409(world) -> None:
    world.app.state.jobs.start_render_preview(world.ws.path)

    busy = world.client.post(f"/api/review/{world.tokens['editor']}/daw/render-preview")

    assert busy.status_code == 409


def test_a_job_of_another_project_or_kind_is_404(world, monkeypatch) -> None:
    token = world.tokens["editor"]
    foreign = SimpleNamespace(kind="render_preview", project_path="/another/episode.sharecut")
    other_kind = SimpleNamespace(kind="pipeline", project_path=str(world.ws.path))

    for job in (foreign, other_kind, None):
        monkeypatch.setattr(world.app.state.jobs, "get_job", lambda _id, job=job: job)
        res = world.client.get(f"/api/review/{token}/daw/render-preview/j1")
        assert res.status_code == 404
        assert res.json() == {"detail": "Render preview job not found"}
        assert res.headers[CODE] == "job_not_found"
