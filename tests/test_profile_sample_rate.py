"""#1482: a level is compared with a floor read at the same sample rate, cached or not.

White room tone reads about 3.5 dB lower at 8 kHz than at 16 kHz, so a window RMS read at
8 kHz must meet the 8 kHz profile, whether the track's decode is cached or not.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.audio_cache import (
    JUMP_SAMPLE_RATE,
    WAVEFORM_SAMPLE_RATE,
    build_track_audio_caches,
    track_level_profile,
)
from podcast_mcp.edits.speech_energy_guard import _voice_reach_db
from podcast_mcp.engines.audio_audit import (
    TrackRmsCache,
    build_track_rms_caches,
    measure_timeline_rms_db,
    measure_window_rms_db,
)
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.util.tracks import track_audio_path

RATE = 48000
DURATION = 20.0


def _white_room_project(tmp_path: Path) -> EpisodeProject:
    """A track of syllable-rate white-noise speech over a white room floor 40 dB under it."""
    clock = np.arange(int(DURATION * RATE)) / RATE
    rng = np.random.default_rng(3)
    envelope = 0.5 * (1 - np.cos(2 * np.pi * 4 * clock)) * (clock % 4.0 < 2.5)
    samples = 0.15 * rng.normal(size=clock.size) * envelope + 0.0015 * rng.normal(size=clock.size)
    path = tmp_path / "raw" / "host.wav"
    path.parent.mkdir(parents=True)
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(np.round(np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("profile rate", str(tmp_path))
    project.ensure_dirs()
    project.timeline.tracks.append(
        Track(
            id="host",
            label="host",
            media=MediaAsset(path="raw/host.wav", duration_sec=DURATION),
            role=TrackRole.DIALOGUE,
        )
    )
    project.timeline.clips.append(
        Clip(
            id="clip-host",
            track_id="host",
            source_start=0.0,
            source_end=DURATION,
            timeline_start=0.0,
        )
    )
    return project


def test_white_room_floor_reads_lower_at_8_khz_than_16_khz(tmp_path: Path) -> None:
    project = _white_room_project(tmp_path)
    low = track_level_profile(project, "host", sample_rate=JUMP_SAMPLE_RATE).voice_floor_db
    high = track_level_profile(project, "host", sample_rate=WAVEFORM_SAMPLE_RATE).voice_floor_db
    assert high - low > 1.0


def test_cut_quality_floor_is_the_8_khz_one_with_or_without_a_cache(tmp_path: Path) -> None:
    project = _white_room_project(tmp_path)
    cache = build_track_audio_caches(project, ["host"])["host"]
    cached = track_level_profile(project, "host", cache, sample_rate=JUMP_SAMPLE_RATE)
    uncached = track_level_profile(project, "host", sample_rate=JUMP_SAMPLE_RATE)
    assert cached.voice_floor_db == pytest.approx(uncached.voice_floor_db, abs=0.01)


def test_guard_voice_reach_agrees_cached_and_uncached(tmp_path: Path) -> None:
    project = _white_room_project(tmp_path)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    assert _voice_reach_db(project, "host", caches) == pytest.approx(
        _voice_reach_db(project, "host", None), abs=0.01
    )


@pytest.mark.parametrize("start", [0.0, 0.3, 5.5, 12.0, DURATION - 0.02])
def test_uncached_window_rms_matches_the_decoded_track_on_broadband_noise(
    tmp_path: Path, start: float
) -> None:
    """#1542: the window reader low-passes before it resamples, as the whole-file decode does."""
    project = _white_room_project(tmp_path)
    path = track_audio_path(project, "host")
    cache = TrackRmsCache.from_timeline_stem(path)
    uncached = measure_window_rms_db(path, start, start + 0.02)
    cached = cache.rms_db(start, start + 0.02)
    assert uncached == pytest.approx(cached, abs=1.0)


def test_lowpass_of_a_signal_shorter_than_its_kernel_is_not_shifted() -> None:
    from podcast_mcp.engines.align import _antialias_margin, _lowpass

    margin = _antialias_margin(48_000, 8_000)
    noise = np.random.default_rng(1).normal(size=40)
    short = _lowpass(noise, 48_000, 8_000, margin)
    padded = _lowpass(np.concatenate([np.zeros(500), noise, np.zeros(500)]), 48_000, 8_000, margin)
    assert short.shape == noise.shape
    np.testing.assert_allclose(short, padded[500:540], atol=1e-12)


@pytest.mark.parametrize("start", [2.6, 6.7, 14.6])
def test_uncached_timeline_rms_matches_the_decoded_track_on_room_tone(
    tmp_path: Path, start: float
) -> None:
    """#1547: the timeline window readers low-pass too, so room tone reads the same either way."""
    project = _white_room_project(tmp_path)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    uncached = measure_timeline_rms_db(
        project, "host", start, start + 0.5, defaults=load_defaults()
    )
    cached = measure_timeline_rms_db(
        project, "host", start, start + 0.5, caches=caches, defaults=load_defaults()
    )
    assert uncached is not None and cached is not None
    assert uncached == pytest.approx(cached, abs=0.5)
