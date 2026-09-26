"""Guest render status never exposes another project's job or host details."""

from pathlib import Path
from types import SimpleNamespace

from podcast_mcp.gui.jobs import guest_render_job


def test_guest_render_job_scoped_and_sanitized() -> None:
    job = SimpleNamespace(
        id="render-1",
        kind="render_preview",
        project_path="/host/one/episode.project.json",
        snapshot=lambda: {
            "status": "running",
            "current": 2,
            "total": 4,
            "message": "Reading /host/private/audio.wav",
            "error": "/host/private/audio.wav",
            "project_path": "/host/one/episode.project.json",
            "result": {"premix_path": "/host/private/mix.wav"},
        },
    )
    assert guest_render_job(job, Path("/host/two/episode.project.json")) is None
    assert guest_render_job(job, Path(job.project_path)) == {
        "id": "render-1",
        "status": "running",
        "current": 2,
        "total": 4,
        "message": "Rendering preview",
        "error": None,
    }
    job.snapshot = lambda: {
        "status": "error",
        "current": 3,
        "total": 4,
        "error": "/host/private/audio.wav",
    }
    assert guest_render_job(job, Path(job.project_path))["error"] == "Render preview failed"
    job.snapshot = lambda: {"status": "cancelled", "current": 3, "total": 4}
    assert guest_render_job(job, Path(job.project_path))["status"] == "cancelled"
    job.kind = "pipeline"
    assert guest_render_job(job, Path(job.project_path)) is None
