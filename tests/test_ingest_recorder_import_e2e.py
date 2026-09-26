"""US-3: import recorder-folder audio onto one session clock (CLI -> Studio API)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import load_project

runner = CliRunner()

GUEST_LEAD_SEC = 4.0


def _tone_file(path: Path, *, lead_sec: float, total_sec: float, freq: int) -> None:
    """Silence for ``lead_sec`` then a tone, padded to ``total_sec``."""
    ms = int(lead_sec * 1000)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq}:duration={total_sec - lead_sec}",
            "-af",
            f"volume=0.6,adelay={ms}|{ms},apad=whole_dur={total_sec}",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _invoke(*args: str) -> str:
    res = runner.invoke(app, list(args))
    assert res.exit_code == 0, res.output
    return res.output


def test_recorder_folder_import_places_tracks_on_session_clock(tmp_path: Path) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    audio = tmp_path / "recorder"
    audio.mkdir()
    # Session t=0 is host file t=2; the guest recorder started 4 s earlier.
    _tone_file(audio / "host_maya.wav", lead_sec=2.0, total_sec=30.0, freq=300)
    _tone_file(audio / "guest_ann.wav", lead_sec=2.0 + GUEST_LEAD_SEC, total_sec=34.0, freq=500)
    manifest = tmp_path / "ingest.yaml"

    _invoke(
        "ingest",
        "import",
        str(audio),
        "--out",
        str(manifest),
        "--speaker",
        "host_maya.wav=Host Maya",
        "--speaker",
        "guest_ann.wav=Guest Ann",
    )
    assert sorted(p.name for p in audio.iterdir()) == ["guest_ann.wav", "host_maya.wav"]

    project_dir = tmp_path / "episode"
    _invoke("episode", "init", "--dir", str(project_dir), "--name", "us3")
    project = project_dir / "episode.project.json"
    _invoke(
        "ingest",
        "consolidate",
        "--audio-dir",
        str(audio),
        "--manifest",
        str(manifest),
        "--project",
        str(project),
    )

    proj = load_project(project)
    clips = {c.track_id: c for c in proj.timeline.clips}
    guest = next(c for tid, c in clips.items() if "guest" in tid)
    host = next(c for tid, c in clips.items() if "host" in tid)
    assert host.timeline_start == pytest.approx(0.0, abs=0.01)
    assert guest.timeline_start == pytest.approx(0.0, abs=0.01)
    assert guest.source_start == pytest.approx(GUEST_LEAD_SEC, abs=0.01)
    assert guest.source_start > host.source_start

    client = TestClient(create_app())
    res = client.get("/api/project", params={"path": str(project)})
    assert res.status_code == 200
    api_guest = res.json()["clips"]["tracks"]["guest_ann"][0]
    assert api_guest["source_start"] == pytest.approx(guest.source_start)
    assert api_guest["timeline_start"] == pytest.approx(0.0, abs=0.01)

    out = _invoke(
        "ingest", "verify", "--project", str(project), "--no-waveforms", "--window", "0:20"
    )
    assert json.loads(out[out.index("{") :])["status"] in {"pass", "warn", "fail"}
