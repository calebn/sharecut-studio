from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from unittest.mock import patch

import numpy as np

from podcast_mcp.engines.speaker_id import (
    MockSpeakerBackend,
    enroll_track,
    list_profiles,
    load_all_profiles,
    load_profile,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.project.transcript_context import SpeakerIdConfig


def _enrolled_project(tmp_path: Path, sample_wav: Path) -> tuple[Path, EpisodeProject]:
    project = EpisodeProject.create("speaker", str(tmp_path))
    project.ensure_dirs()
    raw = project.raw_dir()
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.2, end=0.8, confidence=0.95),
                TranscriptWord(text="again", start=1.0, end=1.6, confidence=0.92),
            ],
        )
    ]
    path = save_project(project)
    cfg = SpeakerIdConfig(min_enrollment_sec=0.5, min_enrollment_confidence=0.5)
    with patch(
        "podcast_mcp.engines.speaker_id.load_mono_window",
        return_value=np.linspace(-0.1, 0.1, 8000, dtype=np.float32),
    ):
        assert enroll_track(project, "host", cfg, MockSpeakerBackend()) is not None
    return path, project


def _copied(path: Path, project: EpisodeProject, tmp_path: Path) -> EpisodeProject:
    source = project.workspace_path()
    target = tmp_path / "copy"
    shutil.copytree(source, target)
    copied_stem = target / "raw" / "host.wav"
    os.utime(copied_stem, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    return load_project(target / path.name)


def test_profiles_survive_a_copied_project(tmp_path, sample_wav):
    path, project = _enrolled_project(tmp_path, sample_wav)
    assert set(load_all_profiles(project)) == {"host"}

    copied = _copied(path, project, tmp_path)

    assert set(load_all_profiles(copied)) == {"host"}
    assert load_profile(copied, "host") is not None


def test_a_rewritten_stem_still_invalidates_the_profile(tmp_path, sample_wav):
    path, project = _enrolled_project(tmp_path, sample_wav)
    copied = _copied(path, project, tmp_path)
    stem = copied.workspace_path() / "raw" / "host.wav"
    data = bytearray(stem.read_bytes())
    data[-8:] = bytes(8)
    data[100] ^= 0xFF
    stem.write_bytes(bytes(data))

    assert load_all_profiles(copied) == {}


def test_profiles_that_exist_but_fail_validation_are_reported(tmp_path, sample_wav, caplog):
    path, project = _enrolled_project(tmp_path, sample_wav)
    copied = _copied(path, project, tmp_path)
    stem = copied.workspace_path() / "raw" / "host.wav"
    stem.write_bytes(stem.read_bytes()[:-400])

    with caplog.at_level("WARNING"):
        assert load_all_profiles(copied) == {}

    assert any("speaker profile" in r.message.lower() for r in caplog.records)
    listed = list_profiles(copied)
    assert listed and listed[0]["valid"] is False


def test_a_same_size_interior_rewrite_invalidates_the_profile(tmp_path, sample_wav):
    path, project = _enrolled_project(tmp_path, sample_wav)
    copied = _copied(path, project, tmp_path)
    stem = copied.workspace_path() / "raw" / "host.wav"
    data = bytearray(stem.read_bytes())
    data[len(data) // 2] ^= 0x7F
    stem.write_bytes(bytes(data))

    assert load_all_profiles(copied) == {}


def test_a_legacy_profile_without_a_content_key_is_stale_after_a_copy(tmp_path, sample_wav):
    path, project = _enrolled_project(tmp_path, sample_wav)
    for profile_file in (project.artifacts_dir() / "speaker_profiles").glob("*.json"):
        data = json.loads(profile_file.read_text(encoding="utf-8"))
        data.pop("stem_content", None)
        profile_file.write_text(json.dumps(data), encoding="utf-8")
    assert set(load_all_profiles(project)) == {"host"}

    copied = _copied(path, project, tmp_path)

    assert load_all_profiles(copied) == {}


def test_the_stale_warning_fires_once_per_workspace(tmp_path, sample_wav, caplog):
    path, project = _enrolled_project(tmp_path, sample_wav)
    copied = _copied(path, project, tmp_path)
    stem = copied.workspace_path() / "raw" / "host.wav"
    stem.write_bytes(stem.read_bytes()[:-400])

    with caplog.at_level("WARNING"):
        for _ in range(3):
            assert load_all_profiles(copied) == {}

    warnings = [r for r in caplog.records if "speaker profile" in r.message.lower()]
    assert len(warnings) == 1


def test_a_size_change_skips_hashing_the_stem(tmp_path, sample_wav):
    path, project = _enrolled_project(tmp_path, sample_wav)
    copied = _copied(path, project, tmp_path)
    stem = copied.workspace_path() / "raw" / "host.wav"
    stem.write_bytes(stem.read_bytes()[:-400])

    with patch("podcast_mcp.engines.speaker_id._content_digest") as digest:
        assert load_all_profiles(copied) == {}

    digest.assert_not_called()


def test_listing_reports_status_for_valid_and_legacy_profiles(tmp_path, sample_wav):
    path, project = _enrolled_project(tmp_path, sample_wav)
    assert [(p["valid"], p["status"]) for p in list_profiles(project)] == [(True, "ok")]

    copied = _copied(path, project, tmp_path)
    assert [(p["valid"], p["status"]) for p in list_profiles(copied)] == [(True, "ok")]

    for profile_file in (copied.artifacts_dir() / "speaker_profiles").glob("*.json"):
        data = json.loads(profile_file.read_text(encoding="utf-8"))
        data.pop("stem_content", None)
        data["stem_hash"] = "old"
        profile_file.write_text(json.dumps(data), encoding="utf-8")
    assert [(p["valid"], p["status"]) for p in list_profiles(copied)] == [(False, "legacy_key")]
