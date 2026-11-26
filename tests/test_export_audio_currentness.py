"""Canonical audio is listed as stale once an edit follows the export (#2806).

End to end: the real ``PipelineService.export_audio`` and the pipeline export step write real
files with real ffmpeg; only the mastered WAV is replaced by a one-second sine.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.pipeline import steps as pipeline_steps
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ExportFilesService
from podcast_mcp.services.pipeline import PipelineService

FFMPEG = os.environ.get("PODCAST_MCP_FFMPEG") or shutil.which("ffmpeg")

pytestmark = [
    pytest.mark.skipif(FFMPEG is None, reason="needs ffmpeg"),
    pytest.mark.unscoped_ok,
]


@pytest.fixture
def ws(minimal_project: Path) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


@pytest.fixture
def master(ws: ProjectWorkspace):
    path = ws.project.artifacts_dir() / "sine-master.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            FFMPEG,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-ar",
            "44100",
            str(path),
        ],
        check=True,
    )
    with patch.object(pipeline_steps, "ensure_current_master", lambda *_a, **_k: path):
        yield path


def _fader(ws: ProjectWorkspace, db: float) -> None:
    ws.mutate("fader", "fader", lambda p: setattr(p.track_by_id("host"), "fader_db", db))


def _audio(ws: ProjectWorkspace) -> dict[str, bool]:
    stem = sanitize_export_stem(ws.project.name)
    names = {f"{stem}.wav", f"{stem}.mp3"}
    return {f.id: f.current for f in ExportFilesService(ws).list() if f.id in names}


def _both(ws: ProjectWorkspace, value: bool) -> dict[str, bool]:
    stem = sanitize_export_stem(ws.project.name)
    return {f"{stem}.wav": value, f"{stem}.mp3": value}


def test_exported_audio_is_current_stale_after_an_edit_and_current_after_undo(ws, master) -> None:
    PipelineService(ws).export_audio([{"ext": "mp3"}])
    assert _audio(ws) == _both(ws, True)

    _fader(ws, -6.0)
    assert _audio(ws) == _both(ws, False)

    ws.undo()
    assert _audio(ws) == _both(ws, True)


def test_exporting_again_after_an_edit_makes_the_audio_current(ws, master) -> None:
    PipelineService(ws).export_audio([{"ext": "mp3"}])
    _fader(ws, -6.0)
    assert _audio(ws) == _both(ws, False)

    PipelineService(ws).export_audio([{"ext": "mp3"}])

    assert _audio(ws) == _both(ws, True)


def test_the_pipeline_export_step_records_the_head_it_exported(ws, master) -> None:
    defaults = load_defaults()
    defaults["export"] = {**defaults.get("export", {}), "formats": [{"ext": "mp3"}]}

    pipeline_steps.export_deliverables(ws.project, defaults)
    assert _audio(ws) == _both(ws, True)

    _fader(ws, -6.0)
    assert _audio(ws) == _both(ws, False)
