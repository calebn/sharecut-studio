"""Guest render status never exposes another project's job or host details."""

from pathlib import Path
from types import SimpleNamespace

from podcast_mcp.services.jobs import GUEST_RENDER_KINDS, guest_job_view


def test_guest_job_view_scoped_and_sanitized() -> None:
    job = SimpleNamespace(
        id="render-1",
        kind="render_preview",
        project_path="/host/one/episode.sharecut",
        snapshot=lambda: {
            "id": "render-1",
            "kind": "render_preview",
            "status": "running",
            "current": 2,
            "total": 4,
            "message": "Reading /host/private/audio.wav",
            "error": "/host/private/audio.wav",
            "project_path": "/host/one/episode.sharecut",
            "result": {"premix_path": "/host/private/mix.wav"},
        },
    )
    assert guest_job_view(job, Path("/host/two/episode.sharecut"), GUEST_RENDER_KINDS) is None
    assert guest_job_view(job, Path(job.project_path), GUEST_RENDER_KINDS) == {
        "id": "render-1",
        "status": "running",
        "current": 2,
        "total": 4,
        "message": "Rendering preview",
        "error": None,
    }
    job.snapshot = lambda: {
        "id": "render-1",
        "kind": "render_preview",
        "status": "error",
        "current": 3,
        "total": 4,
        "error": "/host/private/audio.wav",
    }
    assert (
        guest_job_view(job, Path(job.project_path), GUEST_RENDER_KINDS)["error"]
        == "Render preview failed"
    )
    job.snapshot = lambda: {
        "id": "render-1",
        "kind": "render_preview",
        "status": "cancelled",
        "current": 3,
        "total": 4,
    }
    assert guest_job_view(job, Path(job.project_path), GUEST_RENDER_KINDS)["status"] == "cancelled"
    job.kind = "export"
    assert guest_job_view(job, Path(job.project_path), GUEST_RENDER_KINDS) is None
