from __future__ import annotations

import json
import shutil
import wave
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines import audio_audit
from podcast_mcp.engines.audio_audit import build_track_rms_caches
from podcast_mcp.mcp.tools.timeline import audibility_map_tool, reconcile_transcript_tool
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    load_project,
    save_project,
)

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


def _multi_source_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("multi-source", str(tmp_path))
    project.ensure_dirs()
    project.tracks.append(Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav")))
    for name, level in (("host", 0.125), ("extra", 0.25)):
        path = tmp_path / "raw" / f"{name}.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(8000)
            handle.writeframes(np.full(16000, round(level * 32768), dtype="<i2").tobytes())
    project.sources.append(SourceRecording(id="extra", path="raw/extra.wav"))
    project.clips = [
        Clip(id="primary", track_id="host", source_start=0, source_end=1, timeline_start=1),
        Clip(
            id="extra",
            track_id="host",
            source_id="extra",
            source_start=0,
            source_end=1,
            timeline_start=1.5,
        ),
    ]
    return project


def test_raw_cache_plays_selected_files_and_sums_overlap(tmp_path: Path) -> None:
    project = _multi_source_project(tmp_path)

    cache = build_track_rms_caches(project).get("host")

    assert cache is not None
    assert cache.samples.size == 20000
    np.testing.assert_array_equal(cache.window(0, 1), 0)
    np.testing.assert_array_equal(cache.window(1, 1.5), 0.125)
    np.testing.assert_array_equal(cache.window(1.5, 2), 0.375)
    np.testing.assert_array_equal(cache.window(2, 2.5), 0.25)


@pytest.mark.parametrize("primary", ["missing", "unset"])
def test_raw_cache_uses_extra_without_primary_media(tmp_path: Path, primary: str) -> None:
    project = _multi_source_project(tmp_path)
    project.clips = [project.clips[1]]
    if primary == "missing":
        (tmp_path / "raw" / "host.wav").unlink()
    else:
        project.tracks[0].media = None

    cache = build_track_rms_caches(project).get("host")

    assert cache is not None
    np.testing.assert_array_equal(cache.window(1.5, 2.5), 0.25)


@pytest.mark.parametrize("unavailable", ["missing", "dangling", "short", "escape", "invalid"])
def test_unavailable_selected_extra_omits_entire_raw_cache(
    tmp_path: Path, unavailable: str
) -> None:
    project = _multi_source_project(tmp_path)
    available = build_track_rms_caches(project).get("host")
    assert available is not None
    np.testing.assert_array_equal(available.window(2, 2.5), 0.25)
    extra = project.clips[1]
    if unavailable == "missing":
        (tmp_path / "raw" / "extra.wav").unlink()
    elif unavailable == "dangling":
        extra.source_id = "unknown"
    elif unavailable == "short":
        extra.source_end = 3
    elif unavailable == "escape":
        project.sources[0].path = "../outside.wav"
    else:
        (tmp_path / "raw" / "extra.wav").write_bytes(b"not audio")

    caches = build_track_rms_caches(project)

    assert caches.get("host") is None
    assert caches.echo_pairs() == []


def test_raw_cache_plays_moved_source_on_current_lane(tmp_path: Path) -> None:
    project = _multi_source_project(tmp_path)
    project.tracks.append(Track(id="guest", label="Guest", media=MediaAsset(path="raw/extra.wav")))
    project.sources.append(SourceRecording(id="host-source", path="raw/host.wav"))
    project.clips = [
        Clip(
            id="moved",
            track_id="guest",
            source_id="host-source",
            source_start=0,
            source_end=1,
            timeline_start=1,
        ),
    ]

    caches = build_track_rms_caches(project)
    guest = caches.get("guest")
    host = caches.get("host")

    assert guest is not None and host is not None
    np.testing.assert_array_equal(guest.window(0, 1), 0)
    np.testing.assert_array_equal(guest.window(1, 2), 0.125)
    np.testing.assert_array_equal(host.window(0, 2), 0.125)


def test_repeated_media_decodes_once_across_lane_placements(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _multi_source_project(tmp_path)
    project.tracks.append(Track(id="guest", label="Guest", media=MediaAsset(path="raw/host.wav")))
    project.clips.append(
        Clip(
            id="repeated",
            track_id="host",
            source_id="extra",
            source_start=1,
            source_end=2,
            timeline_start=3,
        )
    )
    calls: list[Path] = []
    decode = audio_audit.load_mono_full

    def record_decode(path: Path, *, sample_rate: int) -> np.ndarray:
        calls.append(path)
        return decode(path, sample_rate=sample_rate)

    monkeypatch.setattr(audio_audit, "load_mono_full", record_decode)

    caches = build_track_rms_caches(project)
    host = caches.get("host")
    guest = caches.get("guest")

    assert host is not None and guest is not None
    np.testing.assert_array_equal(host.window(3, 4), 0.25)
    np.testing.assert_array_equal(guest.window(0, 2), 0.125)
    assert sorted(calls) == sorted([tmp_path / "raw" / "host.wav", tmp_path / "raw" / "extra.wav"])
