from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.word_onset import OnsetKind, next_onset, voice_end, voice_onset
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


def _ramp(n: int, *, from_db: float, to_db: float, seed: int = 5) -> np.ndarray:
    """White noise whose level moves linearly in dB: the shape of a fricative's rise."""
    gain = np.power(10.0, np.linspace(from_db, to_db, n) / 20.0)
    return np.random.default_rng(seed).standard_normal(n) * gain


def _voice_envelope(*knots: tuple[float, float]) -> tuple[float, np.ndarray]:
    """One unbroken voice whose level follows ``(sec, dB)`` knots; no phase clicks."""
    (t_first, _), (t_last, _) = knots[0], knots[-1]
    times = np.arange(round((t_last - t_first) * RATE)) / RATE + t_first
    db = np.interp(times, [t for t, _ in knots], [level for _, level in knots])
    return t_first, _voice(times.size, level_db=0.0) * np.power(10.0, db / 20.0)


# A filler that decays 16 dB into a low, dark stretch with no quiet in it. The stretch
# creeps up by a dB, so its trough is where it begins (1.38).
_FILLER_DECAY = ((1.0, -20.0), (1.3, -20.0), (1.38, -36.6), (1.45, -35.4))


def test_plosive_out_of_quiet_is_a_burst_even_below_the_audibility_floor():
    burst_at = 1.42
    cache = _cache(
        (1.0, _voice(round(0.3 * RATE))),
        (burst_at, _burst(-50.0)),
        (1.45, _voice(round(0.3 * RATE), level_db=-18.0)),
    )
    onset = next_onset(cache, 1.3, 1.62, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.41)
    assert onset.kind is OnsetKind.BURST


def test_fricative_out_of_quiet_ramps_and_is_gradual():
    # "she" at 1441.71: the high band climbs about 4 dB per frame, not in one jump.
    ramp = _ramp(round(0.1 * RATE), from_db=-90.0, to_db=-50.0)
    cache = _cache(
        (1.0, _voice(round(0.3 * RATE))),
        (1.42, ramp),
        (1.52, _ramp(4000, from_db=-50.0, to_db=-35.0)),
    )
    onset = next_onset(cache, 1.3, 1.7, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.47, abs=0.03)
    assert onset.kind is OnsetKind.GRADUAL


def test_onset_in_continuous_voice_is_the_foot_of_the_rise_not_the_trough():
    # "uh, we" at 706.3-706.5: the level falls into a low, dark stretch and the vowel
    # climbs out of it. The owner still heard "uh" with the cut at the trough.
    cache = _cache(_voice_envelope(*_FILLER_DECAY, (1.48, -18.0), (1.68, -18.0)))
    onset = next_onset(cache, 1.3, 1.6, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.43, abs=0.011)
    assert onset.kind is OnsetKind.GRADUAL


@pytest.mark.parametrize("seconds", [0.1, 0.04])
def test_continuous_voice_into_a_ramp_is_gradual(seconds):
    # 0.04 s is a 14 dB per frame climb, the pace of "we" out of its dark stretch
    # (lab 706.45): a new sound, but one a fade-in can cover.
    ramp = _ramp(round(seconds * RATE), from_db=-80.0, to_db=-40.0)
    cache = _cache(_voice_envelope(*_FILLER_DECAY, (1.65, -35.4)), (1.45, ramp))
    onset = next_onset(cache, 1.3, 1.6, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.44, abs=0.02)
    assert onset.kind is OnsetKind.GRADUAL


def test_plosive_in_continuous_voice_is_a_burst():
    cache = _cache(_voice_envelope(*_FILLER_DECAY, (1.65, -35.4)), (1.5, _burst(-30.0)))
    onset = next_onset(cache, 1.3, 1.6, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.kind is OnsetKind.BURST


def test_no_onset_before_the_planned_end():
    cache = _cache((1.0, _voice(round(0.3 * RATE))), (2.0, _voice(round(0.3 * RATE))))
    assert next_onset(cache, 1.3, 1.9, quiet_db=QUIET_DB) is None
    onset = next_onset(cache, 1.3, 2.1, quiet_db=QUIET_DB)
    assert onset is not None
    assert onset.sec == pytest.approx(1.99)


@pytest.mark.parametrize(
    ("voice_until", "expected"),
    [
        # The voice runs 80 ms past the word end: it ends with its last audible frame,
        # as a voiced run does (lab "So" at 230.78 voices until 230.98).
        (1.08, 1.09),
        # A voice that stops at the word end reports the word end.
        (1.0, 1.0),
    ],
)
def test_voice_end_walks_forward_to_the_first_quiet_frame(voice_until, expected):
    cache = _cache((0.6, _voice(round((voice_until - 0.6) * RATE))))

    assert voice_end(cache, 1.0, 1.5, quiet_db=QUIET_DB) == pytest.approx(expected, abs=1e-6)


def test_voice_end_is_none_when_the_voice_runs_through_the_ceiling():
    cache = _cache((0.6, _voice(round(0.8 * RATE))))

    assert voice_end(cache, 1.0, 1.3, quiet_db=QUIET_DB) is None
    assert voice_end(cache, 1.0, 1.5, quiet_db=QUIET_DB) == pytest.approx(1.41, abs=1e-6)


def test_voice_onset_walks_back_to_the_last_quiet_frame():
    # The next word voices 110 ms before its word start.
    cache = _cache((1.49, _voice(round(0.4 * RATE))))

    assert voice_onset(cache, 1.6, 1.0, quiet_db=QUIET_DB) == pytest.approx(1.48, abs=1e-6)
    assert voice_onset(cache, 1.6, 1.55, quiet_db=QUIET_DB) is None
