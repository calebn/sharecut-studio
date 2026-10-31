"""Level helpers: the room floor, the speech level and the track profile (``engines/level_profile.py``),
and the band levels of ``edits/audio_cache.py``."""

from __future__ import annotations

import os
import time
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import BandLevels, build_track_audio_caches, track_level_profile
from podcast_mcp.engines import audio_audit as audio_audit_module
from podcast_mcp.engines import decode_memo
from podcast_mcp.engines import level_profile as level_profile_module
from podcast_mcp.engines.level_profile import (
    SILENT,
    LevelProfile,
    file_level_profile,
    level_profile,
    room_floor_db,
    speech_level_db,
)
from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, LOW_BAND, SPEECH_BAND, frame_band_filtered_db

RATE = 16_000


def test_room_floor_is_a_low_percentile_over_the_frames_asked_for() -> None:
    levels = np.concatenate([np.full(50, -70.0), np.full(50, -20.0)])
    between = np.arange(100) < 50

    assert room_floor_db(levels) == pytest.approx(-70.0)
    assert room_floor_db(levels, percentile=90.0) == pytest.approx(-20.0)
    assert room_floor_db(levels, among=~between) == pytest.approx(-20.0)
    assert room_floor_db(levels, among=between, percentile=50.0) == pytest.approx(-70.0)


def test_speech_level_is_the_90th_percentile_of_the_live_frames() -> None:
    gate = np.full(500, DIGITAL_SILENCE_DB)
    voice = np.linspace(-50.0, -10.0, 100)

    assert speech_level_db(np.concatenate([gate, voice])) == pytest.approx(-14.0)


def test_speech_level_needs_half_a_second_of_live_frames_unless_told_otherwise() -> None:
    few = np.concatenate([np.full(500, DIGITAL_SILENCE_DB), np.full(49, -20.0)])

    assert speech_level_db(few) is None
    assert speech_level_db(few, min_live_sec=0.0) == pytest.approx(-20.0)
    assert speech_level_db(np.full(10, DIGITAL_SILENCE_DB), min_live_sec=0.0) is None


def test_a_whole_track_profile_reads_the_room_over_every_frame_digital_silence_included() -> None:
    # 3 s of room tone at 0.001 and 1 s of voice at 0.1, then 6 s a gate holds at zero.
    samples = np.concatenate(
        [
            np.full(3 * RATE, 0.001, dtype=np.float32),
            np.full(RATE, 0.1, dtype=np.float32),
            np.zeros(6 * RATE, dtype=np.float32),
        ]
    )

    local = level_profile(samples, RATE)
    whole = level_profile(samples, RATE, whole_track=True)
    assert local is not None and whole is not None
    assert (local.room_db, local.speech_db, local.loud_db) == pytest.approx((-60.0, -20.0, -20.0))
    assert (whole.room_db, whole.speech_db, whole.loud_db) == pytest.approx(
        (DIGITAL_SILENCE_DB, -20.0, -20.0)
    )


def test_a_whole_track_profile_reads_it_a_minute_at_a_time() -> None:
    from podcast_mcp.util.dsp import frame_rms_db

    # 150 s: three chunks, the last one partial.
    rng = np.random.default_rng(4)
    samples = rng.standard_normal(150 * RATE) * np.repeat(rng.uniform(0.001, 0.2, 1500), 1600)
    levels = frame_rms_db(samples.astype(np.float32), 160, 160)

    profile = level_profile(samples.astype(np.float32), RATE)

    assert profile is not None
    assert [profile.room_db, profile.speech_db, profile.loud_db] == pytest.approx(
        np.percentile(levels, (10, 90, 99))
    )


def test_a_local_profile_needs_half_a_second_of_live_audio() -> None:
    assert level_profile(np.zeros(RATE, dtype=np.float32), RATE) is None
    assert level_profile(np.full(int(0.4 * RATE), 0.01, dtype=np.float32), RATE) is None


def _signal(seconds: float) -> np.ndarray:
    """Noise with a loud 400 Hz burst from 29.9 s to 30.3 s, straddling the first block edge."""
    x = np.random.default_rng(9).standard_normal(round(seconds * RATE)).astype(np.float32) * 0.001
    i = round(29.9 * RATE)
    n = round(0.4 * RATE)
    x[i : i + n] += 0.1 * np.sin(2 * np.pi * 400.0 * np.arange(n) / RATE).astype(np.float32)
    return x


def _reader(x: np.ndarray, calls: list[float] | None = None):
    def read(start: float, duration: float) -> np.ndarray:
        if calls is not None:
            calls.append(start)
        i = round(start * RATE)
        return x[i : i + round(duration * RATE)]

    return read


@pytest.mark.parametrize("band", [SPEECH_BAND, LOW_BAND])
def test_band_levels_across_a_block_edge_match_the_levels_of_the_whole_signal(band) -> None:
    x = _signal(75.0)
    calls: list[float] = []

    levels = BandLevels(_reader(x, calls), RATE, band).all_levels()
    whole = frame_band_filtered_db(x, RATE, 160, band, floor_db=DIGITAL_SILENCE_DB)

    assert levels is not None and levels.size == 7500
    # The burst straddles the 30 s block edge; the margin read either side of each block
    # keeps the filter's ringing at the edge out of the levels. The first and last few
    # frames of a file are the filter's own end effects, whichever way they are cut.
    assert levels[20:-20] == pytest.approx(whole[20:-20], abs=0.01)
    assert len(calls) == 3


def test_each_block_of_levels_is_read_once_however_often_it_is_asked_for() -> None:
    x = _signal(75.0)
    calls: list[float] = []
    bands = BandLevels(_reader(x, calls), RATE)

    first = bands.all_levels()
    second = bands.all_levels()

    assert first is not None and second is not None and len(calls) == 3
    assert second == pytest.approx(first)


def test_band_levels_end_where_the_audio_ends_whatever_the_media_says() -> None:
    # No duration is given or needed: the recording is as long as its audio. One whose
    # length is a whole number of blocks ends at the first empty read.
    assert BandLevels(_reader(_signal(42.0)), RATE).all_levels().size == 4200
    assert BandLevels(_reader(_signal(60.0)), RATE).all_levels().size == 6000


def test_band_levels_are_none_where_the_audio_is_unreadable_or_empty() -> None:
    def broken(start: float, duration: float) -> np.ndarray:
        raise OSError("no such file")

    def not_finite(start: float, duration: float) -> np.ndarray:
        return np.full(round(duration * RATE), np.nan, dtype=np.float32)

    def nothing(start: float, duration: float) -> np.ndarray:
        return np.empty(0, dtype=np.float32)

    assert BandLevels(_reader(_signal(35.0)), RATE).all_levels() is not None
    assert BandLevels(broken, RATE).all_levels() is None
    assert BandLevels(not_finite, RATE).all_levels() is None
    assert BandLevels(nothing, RATE).all_levels() is None


def test_a_block_that_cannot_be_read_late_in_a_recording_makes_it_unreadable() -> None:
    x = _signal(75.0)

    def fails_late(start: float, duration: float) -> np.ndarray:
        if start > 40.0:
            raise OSError("disk error")
        return _reader(x)(start, duration)

    assert BandLevels(fails_late, RATE).all_levels() is None


def _decoded_project(tmp_path: Path, name: str, samples: np.ndarray) -> EpisodeProject:
    path = tmp_path / "raw" / f"{name}.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(np.rint(samples * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("floors", str(tmp_path))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{name}.wav", duration_sec=samples.size / RATE),
        )
    )
    return project


def _speech_over_room(seconds: int = 4) -> np.ndarray:
    rng = np.random.default_rng(3)
    samples = rng.standard_normal(seconds * RATE) * 1e-4
    t = np.arange(RATE) / RATE
    for start in range(seconds - 1):
        samples[start * RATE : (start + 1) * RATE] += 0.1 * np.sin(2 * np.pi * 150 * t)
    return samples


def test_a_caller_with_no_decode_reads_the_floor_the_cached_proposals_did(tmp_path) -> None:
    project = _decoded_project(tmp_path, "host", _speech_over_room())
    cache = build_track_audio_caches(project, ["host"])["host"]

    assert track_level_profile(project, "host") == cache.profile
    assert track_level_profile(project, "host", cache) is cache.profile
    assert cache.profile.voice_floor_db == pytest.approx(cache.profile.speech_db - 27.0)


def test_the_profile_of_a_track_is_decoded_once_per_audio_file(tmp_path, monkeypatch) -> None:
    project = _decoded_project(tmp_path, "memo", _speech_over_room())
    then = time.time_ns() - 3600 * 10**9
    os.utime(tmp_path / "raw" / "memo.wav", ns=(then, then))
    monkeypatch.setattr(decode_memo, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)
    decode_memo._MEMO.clear()
    reads = []
    real = level_profile_module.load_mono_full

    def counting(*args, **kwargs):
        if kwargs.get("sample_rate") == RATE:
            reads.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(level_profile_module, "load_mono_full", counting)
    monkeypatch.setattr(audio_audit_module, "load_mono_full", counting)

    first = track_level_profile(project, "host")
    second = track_level_profile(project, "host")
    caches = build_track_audio_caches(project, ["host"])

    assert first == second == caches["host"].profile
    assert len(reads) == 1


def test_a_track_with_no_live_audio_has_every_frame_quiet(tmp_path) -> None:
    project = _decoded_project(tmp_path, "silent", np.zeros(2 * RATE))

    assert track_level_profile(project, "host").voice_floor_db == np.inf
    assert build_track_audio_caches(project, ["host"])["host"].profile.speech_db == -np.inf


def test_a_track_with_no_live_audio_judges_every_frame_quiet_and_reads_as_recorded() -> None:
    assert (SILENT.voice_floor_db, SILENT.audibility_floor_db, SILENT.voice_reach_db) == (
        np.inf,
        np.inf,
        np.inf,
    )
    assert SILENT.voice_gain == 1.0


def test_a_track_without_contrast_judges_nothing_inaudible() -> None:
    """A steady tone: its loudest frames sit within 6 dB of its room."""
    flat = LevelProfile(room_db=-30.0, speech_db=-27.0, loud_db=-26.0)
    assert flat.audibility_floor_db == -np.inf
    assert flat.voice_reach_db == -np.inf


def test_a_sparse_speakers_voice_is_read_from_the_loudest_frames() -> None:
    """Under a tenth of the time talking: the speech level is the room, so the voice and the
    reach a stretch must clear come from the loudest frames."""
    sparse = LevelProfile(room_db=-70.0, speech_db=-66.0, loud_db=-20.0)
    assert sparse.voice_db == -26.0
    assert sparse.voice_floor_db == -64.0
    assert sparse.voice_reach_db == -47.0
    dense = LevelProfile(room_db=-70.0, speech_db=-18.0, loud_db=-13.0)
    assert dense.voice_db == -18.0


def test_a_floor_is_read_at_the_rate_of_the_frames_it_is_compared_with(tmp_path) -> None:
    """White room tone reads lower once band-limited to 8 kHz; each rate keeps its own floor."""
    rng = np.random.default_rng(5)
    room = rng.standard_normal(4 * RATE) * 0.003
    t = np.arange(RATE) / RATE
    room[RATE : 2 * RATE] += 0.1 * np.sin(2 * np.pi * 150 * t)
    project = _decoded_project(tmp_path, "rates", room)
    path = tmp_path / "raw" / "rates.wav"

    at_8k = file_level_profile(path, sample_rate=8000)
    at_16k = file_level_profile(path)
    cache_8k = build_track_audio_caches(project, ["host"])["host"].jump

    assert at_8k.room_db < at_16k.room_db - 2.0
    assert cache_8k.profile == at_8k
    assert file_level_profile(path, levels=np.zeros(1), sample_rate=8000) is at_8k


def test_the_per_file_profile_memory_is_bounded() -> None:
    cache = level_profile_module._FILE_PROFILES
    for i in range(cache.maxsize + 50):
        cache.put((f"/f/{i}", (1, i, 3, 4), 16000), SILENT)
    assert cache.maxsize == 256
    assert len(cache) == cache.maxsize
