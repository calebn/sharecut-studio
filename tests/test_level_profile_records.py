"""A pipeline run records each track's level profile, so a later process reads it back (#2359).

Planning paths read ``artifacts/level_profiles`` but never write it; the pipeline writes it.
"""

from __future__ import annotations

import os
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from podcast_mcp.edits import audio_cache
from podcast_mcp.edits.audio_cache import (
    JUMP_SAMPLE_RATE,
    WAVEFORM_SAMPLE_RATE,
    build_track_audio_caches,
    record_track_level_profiles,
    track_level_profile,
)
from podcast_mcp.engines import level_profile
from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole

RATE = 16_000
RATES = (JUMP_SAMPLE_RATE, WAVEFORM_SAMPLE_RATE)


def _project(tmp_path: Path, tracks: tuple[str, ...] = ("host",)) -> EpisodeProject:
    rng = np.random.default_rng(3)
    project = EpisodeProject.create("records", str(tmp_path))
    t = np.arange(RATE) / RATE
    for index, name in enumerate(tracks):
        samples = rng.standard_normal(4 * RATE) * 1e-4
        for start in range(3):
            samples[start * RATE : (start + 1) * RATE] += 0.1 * np.sin(
                2 * np.pi * (150 + index) * t
            )
        path = tmp_path / "raw" / f"{name}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(RATE)
            handle.writeframes(np.rint(samples * 32767).astype("<i2").tobytes())
        project.timeline.tracks.append(
            Track(
                id=name,
                label=name,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{name}.wav", duration_sec=4.0),
            )
        )
    return project


@pytest.fixture
def measures(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    level_profile._FILE_PROFILES.clear()
    seen: list[int] = []
    real = level_profile.frame_levels_db

    def counting(samples: np.ndarray, rate: int) -> np.ndarray:
        seen.append(rate)
        return real(samples, rate)

    monkeypatch.setattr(level_profile, "frame_levels_db", counting)
    return seen


def _records(project: EpisodeProject) -> list[Path]:
    return sorted((project.artifacts_dir() / "level_profiles").glob("*.json"))


def test_a_profile_measured_earlier_in_the_process_is_recorded_when_asked(
    tmp_path: Path, measures: list[int]
) -> None:
    project = _project(tmp_path)
    measured = track_level_profile(project, "host")
    assert not _records(project)

    assert track_level_profile(project, "host", record=True) == measured
    assert len(_records(project)) == 1
    assert len(measures) == 1

    level_profile._FILE_PROFILES.clear()
    assert track_level_profile(project, "host") == measured
    assert len(measures) == 1


def test_recording_a_projects_profiles_makes_a_fresh_process_decode_nothing(
    tmp_path: Path, measures: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, ("host", "guest"))
    computed = {
        (tid, rate): level_profile.file_level_profile(
            audio_cache.track_audio_path(project, tid), sample_rate=rate
        )
        for tid in ("host", "guest")
        for rate in RATES
    }
    level_profile._FILE_PROFILES.clear()
    measures.clear()

    record_track_level_profiles(project)
    assert len(_records(project)) == 4

    level_profile._FILE_PROFILES.clear()
    measures.clear()
    decodes: list[Path] = []
    monkeypatch.setattr(
        level_profile, "load_mono_full", lambda *args, **kwargs: decodes.append(args) or 1 / 0
    )
    for (tid, rate), expected in computed.items():
        assert track_level_profile(project, tid, sample_rate=rate) == expected
    assert not decodes and not measures


def test_recording_only_dialogue_tracks_with_media(tmp_path: Path) -> None:
    project = _project(tmp_path, ("host",))
    project.timeline.tracks.append(Track(id="empty", label="empty", role=TrackRole.DIALOGUE))
    record_track_level_profiles(project)
    assert len(_records(project)) == len(RATES)


def test_a_record_is_a_few_dozen_bytes(tmp_path: Path) -> None:
    project = _project(tmp_path)
    record_track_level_profiles(project)
    records = _records(project)
    assert len(records) == len(RATES)
    assert all(record.stat().st_size < 150 for record in records)


@pytest.mark.parametrize("change", ["size", "mtime", "inode"])
def test_a_changed_recording_is_measured_again(
    tmp_path: Path, measures: list[int], change: str
) -> None:
    project = _project(tmp_path)
    raw = tmp_path / "raw" / "host.wav"
    record_track_level_profiles(project)
    measures.clear()

    if change == "size":
        raw.write_bytes(raw.read_bytes() + b"\0\0")
    elif change == "mtime":
        stat = raw.stat()
        os.utime(raw, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    else:
        data, stat = raw.read_bytes(), raw.stat()
        copy = raw.with_name("copy.wav")
        copy.write_bytes(data)
        os.utime(copy, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        copy.replace(raw)
    level_profile._FILE_PROFILES.clear()

    track_level_profile(project, "host", sample_rate=WAVEFORM_SAMPLE_RATE)
    assert measures == [WAVEFORM_SAMPLE_RATE]


@pytest.mark.parametrize("damage", ["garbage", "partial", "not_finite"])
def test_a_damaged_record_is_measured_again(
    tmp_path: Path, measures: list[int], damage: str
) -> None:
    project = _project(tmp_path)
    record_track_level_profiles(project)
    level_profile._FILE_PROFILES.clear()
    expected = track_level_profile(project, "host")
    for record in _records(project):
        record.write_text(
            {
                "garbage": "{not json",
                "partial": '{"room_db": -60.0}',
                "not_finite": '{"room_db": -Infinity, "speech_db": 1, "loud_db": 2}',
            }[damage],
            encoding="utf-8",
        )
    level_profile._FILE_PROFILES.clear()
    measures.clear()

    assert track_level_profile(project, "host") == expected
    assert measures == [WAVEFORM_SAMPLE_RATE]


@pytest.mark.parametrize("step_name", ["analyze_fillers_pauses", "apply_sound_actions"])
def test_a_pipeline_step_that_decodes_the_tracks_records_their_profiles(
    tmp_path: Path, measures: list[int], monkeypatch: pytest.MonkeyPatch, step_name: str
) -> None:
    from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
    from podcast_mcp.pipeline import meta, steps

    project = _project(tmp_path, ("host", "guest"))
    monkeypatch.setattr(REFINE_GATE, "assert_clear", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(meta, "step_noop_reason", lambda *_args, **_kwargs: None)

    def propose(proj: EpisodeProject, *_args: object, **_kwargs: object) -> SimpleNamespace:
        build_track_audio_caches(proj, ["host", "guest"])
        return SimpleNamespace(summary=lambda: "proposed", decisions=[])

    monkeypatch.setattr(steps, "propose_tighten_edits", propose)
    assert not _records(project)

    getattr(steps, step_name)(project, {})

    assert len(_records(project)) == 4
    measured = len(measures)
    level_profile._FILE_PROFILES.clear()
    for tid in ("host", "guest"):
        for rate in RATES:
            track_level_profile(project, tid, sample_rate=rate)
    assert len(measures) == measured
