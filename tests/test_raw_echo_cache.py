from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.audio_audit import build_track_rms_caches
from podcast_mcp.mcp.tools.timeline import audibility_map_tool, reconcile_transcript_tool
from podcast_mcp.models import Clip, load_project, save_project

FIXTURE = Path(__file__).parent / "fixtures" / "synthetic_bleed_60s"
runner = CliRunner()


def _raw_only_fixture(tmp_path: Path) -> Path:
    workspace = tmp_path / "synthetic_bleed_60s"
    shutil.copytree(FIXTURE, workspace)
    project_path = workspace / "episode.project.json"
    project = load_project(project_path)
    project.clips = [
        Clip(
            id=f"{track_id}_early",
            track_id=track_id,
            source_start=0,
            source_end=8,
            timeline_start=1,
        )
        for track_id in ("host", "guest")
    ] + [
        Clip(
            id=f"{track_id}_late",
            track_id=track_id,
            source_start=10,
            source_end=60,
            timeline_start=9,
        )
        for track_id in ("host", "guest")
    ]
    save_project(project, project_path)
    assert not list(project.artifacts_dir().glob("tracks/*.wav"))
    return project_path


@pytest.mark.parametrize("surface", ["mcp", "cli"])
def test_public_audibility_and_reconcile_measure_raw_echo_without_stems(
    tmp_path: Path, surface: str
) -> None:
    project_path = _raw_only_fixture(tmp_path)

    if surface == "mcp":
        rows = json.loads(audibility_map_tool(str(project_path)))
        reconcile = json.loads(reconcile_transcript_tool(str(project_path), dry_run=True))
    else:
        audibility = runner.invoke(app, ["edit", "audibility-map", "--project", str(project_path)])
        reconcile_result = runner.invoke(
            app,
            ["edit", "reconcile-transcript", "--project", str(project_path), "--dry-run"],
        )
        assert audibility.exit_code == 0, audibility.output
        assert reconcile_result.exit_code == 0, reconcile_result.output
        rows = json.loads(audibility.output)
        reconcile = json.loads(reconcile_result.output)

    host_bleed = [
        row for row in rows if row["track_id"] == "host" and row["audibility_status"] == "bleed"
    ]
    assert len(host_bleed) >= 3
    assert all(row["dominant_track"] == "guest" for row in host_bleed)
    assert len(reconcile["suppress"]) >= 3
    assert all(row["audibility_status"] == "bleed" for row in reconcile["suppress"])
    assert not list((project_path.parent / "artifacts").glob("tracks/*.wav"))


def test_missing_raw_source_does_not_create_echo_evidence(tmp_path: Path) -> None:
    project_path = _raw_only_fixture(tmp_path)
    (project_path.parent / "raw" / "guest.wav").unlink()
    project = load_project(project_path)

    caches = build_track_rms_caches(project)

    assert set(caches.caches) == {"host"}
    assert caches.echo_pairs() == []


def test_raw_cache_omits_zero_offset_cut_and_truncated_tail(tmp_path: Path) -> None:
    project_path = _raw_only_fixture(tmp_path)
    project = load_project(project_path)
    project.clips = [
        Clip(id="host-first", track_id="host", source_start=0, source_end=8, timeline_start=0),
        Clip(id="host-last", track_id="host", source_start=10, source_end=20, timeline_start=10),
    ]

    cache = build_track_rms_caches(project).get("host")

    assert cache is not None
    assert cache.samples.size == 20 * cache.sample_rate
    np.testing.assert_array_equal(cache.window(8, 10), 0)
    assert cache.window(20, 21).size == 0
    assert np.any(cache.window(1, 2) != 0)
