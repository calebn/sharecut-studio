from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.models import EpisodeProject, Track, TrackRole, load_project, save_project


def test_v2_round_trip(tmp_path: Path):
    project = EpisodeProject.create("roundtrip", str(tmp_path))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    path = save_project(project)
    loaded = load_project(path)
    assert loaded.version == "2.0"
    assert loaded.meta.name == "roundtrip"
    assert loaded.tracks[0].id == "host"


def test_rejects_v1_project_file(tmp_path: Path):
    v1_path = tmp_path / "episode.project.json"
    v1_path.write_text(
        json.dumps(
            {
                "version": "1.0",
                "name": "legacy",
                "workspace_dir": str(tmp_path),
                "tracks": [],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match=r"Unsupported episode.project.json version"):
        load_project(v1_path)


def test_track_room_tone_round_trip(tmp_path: Path):
    from podcast_mcp.models import MediaAsset

    project = EpisodeProject.create("room-tone", str(tmp_path))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            room_tone=MediaAsset(
                path="raw/room-tone/p_host.wav",
                duration_sec=3.0,
                sample_rate=48000,
                channels=1,
            ),
        )
    )
    path = save_project(project)
    loaded = load_project(path)
    bed = loaded.tracks[0].room_tone
    assert bed is not None
    assert bed.path == "raw/room-tone/p_host.wav"
    assert bed.duration_sec == 3.0
