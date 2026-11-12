from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from podcast_mcp.models import EpisodeProject, Track, TrackRole, load_project, save_project
from podcast_mcp.util.coded_error import CodedValueError


def test_v2_round_trip(tmp_path: Path):
    project = EpisodeProject.create("roundtrip", str(tmp_path))
    project.timeline.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
    path = save_project(project)
    loaded = load_project(path)
    assert loaded.version == "2.1"
    assert loaded.meta.name == "roundtrip"
    assert loaded.tracks[0].id == "host"


def test_rejects_v1_project_file(tmp_path: Path):
    v1_path = tmp_path / "episode.sharecut"
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
    with pytest.raises(CodedValueError, match=r"can't open") as refusal:
        load_project(v1_path)
    assert refusal.value.code == "project_version_unsupported"


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


V20 = Path(__file__).parent / "fixtures" / "project_compat" / "format_2_0" / "episode.sharecut"


def test_a_2_0_document_opens_in_memory_and_is_written_as_2_1_only_by_a_save(tmp_path: Path):
    shutil.copy(V20, tmp_path / "episode.sharecut")
    path = tmp_path / "episode.sharecut"
    before = path.read_bytes()
    project = load_project(path)
    assert project.version == "2.1"
    assert project.timeline.join_fade_max_ms is None
    assert path.read_bytes() == before
    assert json.loads(before)["version"] == "2.0"
    save_project(project)
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == "2.1"


@pytest.mark.parametrize(
    ("version", "code", "advice"),
    [
        ("3.0", "project_version_newer", "Update the app"),
        ("2.10", "project_version_newer", "Update the app"),
        ("1.0", "project_version_unsupported", "restore a backup"),
        ("two", "project_version_unsupported", "restore a backup"),
        (None, "project_version_unsupported", "restore a backup"),
        (["2.0"], "project_version_unsupported", "restore a backup"),
    ],
)
def test_a_newer_or_unknown_version_is_a_coded_refusal_with_a_fix(
    tmp_path: Path, version, code, advice
):
    document = json.loads(V20.read_text(encoding="utf-8"))
    document["version"] = version
    path = tmp_path / "episode.sharecut"
    path.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(CodedValueError) as refusal:
        load_project(path)
    assert refusal.value.code == code
    assert advice in str(refusal.value)
    assert str(tmp_path) not in str(refusal.value)
