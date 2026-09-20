from __future__ import annotations

import json
import subprocess

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app

pytestmark = pytest.mark.e2e
runner = CliRunner()


def _ffprobe_duration(path: str) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def test_play_dry_run_each_track(e2e_workspace) -> None:
    from podcast_mcp.models import load_project

    proj = load_project(e2e_workspace)
    for track in proj.tracks:
        result = runner.invoke(
            app,
            [
                "play",
                "--project",
                str(e2e_workspace),
                "--source",
                f"track:{track.id}",
                "--start",
                "0",
                "--end",
                "10",
                "--dry-run",
            ],
        )
        assert result.exit_code == 0, result.stdout + result.stderr
        data = json.loads(result.stdout)
        dur = _ffprobe_duration(data["wav"])
        assert 9.0 <= dur <= 11.0


def test_play_processed_dry_run(e2e_workspace) -> None:
    from podcast_mcp.models import load_project

    proj = load_project(e2e_workspace)
    track = proj.tracks[0]
    result = runner.invoke(
        app,
        [
            "play",
            "--project",
            str(e2e_workspace),
            "--source",
            f"processed:{track.id}",
            "--start",
            "0",
            "--end",
            "8",
            "--dry-run",
        ],
    )
    assert result.exit_code == 0, result.stdout + result.stderr
    data = json.loads(result.stdout)
    assert data.get("tier") in ("stem", "segment_render", "segment_cache")
    dur = _ffprobe_duration(data["wav"])
    assert 7.0 <= dur <= 9.5
