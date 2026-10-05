from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.word_onset import next_onset_sec
from podcast_mcp.engines.audio_audit import TrackRmsCache

RATE = 16_000
QUIET_DB = -42.0


def _db(level_db: float) -> float:
    return float(10 ** (level_db / 20))


def _voice(n: int, *, f0: float = 150.0, level_db: float = -20.0) -> np.ndarray:
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 6))
    return tone / np.sqrt(np.mean(tone**2)) * _db(level_db)


def _cache(*segments: tuple[float, np.ndarray]) -> TrackAudioCache:
    """Room noise at -95 dB with each ``(start_sec, samples)`` segment added on top."""
    rng = np.random.default_rng(7)
    samples = rng.standard_normal(3 * RATE) * _db(-95.0)
    for start, segment in segments:
        i = round(start * RATE)
        samples[i : i + segment.size] += segment
    track = TrackRmsCache(samples.astype(np.float32), RATE)
    return TrackAudioCache(track, track)


def _burst(level_db: float) -> np.ndarray:
    return np.random.default_rng(3).standard_normal(round(0.008 * RATE)) * _db(level_db)


def test_onset_is_the_plosive_burst_even_below_the_audibility_floor():
    burst_at = 1.42
    cache = _cache(
        (1.0, _voice(round(0.3 * RATE))),
        (burst_at, _burst(-50.0)),
        (1.45, _voice(round(0.3 * RATE), level_db=-18.0)),
    )
    assert next_onset_sec(cache, 1.3, 1.62, quiet_db=QUIET_DB) == pytest.approx(1.41)


def test_onset_in_continuous_voice_is_the_bottom_of_the_dip():
    # The owner hears the filler's vowel run down the dip until the next word rises
    # out of it (lab "uh, we" at 706.32-706.44, 2026-10-05).
    filler = _voice(round(0.3 * RATE))
    n = round(0.08 * RATE)
    decay = _voice(n) * np.power(10.0, np.linspace(0.0, -16.0, n) / 20.0)
    vowel = _voice(round(0.2 * RATE), level_db=-18.0)
    cache = _cache((1.0, filler), (1.3, decay), (1.38, vowel))
    assert next_onset_sec(cache, 1.3, 1.6, quiet_db=QUIET_DB) == pytest.approx(1.37, abs=0.011)


def test_no_onset_before_the_planned_end():
    cache = _cache((1.0, _voice(round(0.3 * RATE))), (2.0, _voice(round(0.3 * RATE))))
    assert next_onset_sec(cache, 1.3, 1.9, quiet_db=QUIET_DB) is None
    assert next_onset_sec(cache, 1.3, 2.1, quiet_db=QUIET_DB) == pytest.approx(1.99)
