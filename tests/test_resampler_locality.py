"""Restarting the ffmpeg resampler at a grid point reproduces the continuous run bit for bit.

``resample_streams`` is a polyphase FIR with an integer ratio, so an output sample depends
on a finite window of input. ``resampler_locality`` measures that window on the running
build; these tests check what it reports on other signals, at a start, an end and across
back-to-back blocks.
"""

from __future__ import annotations

import itertools
import os
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import ungated_audio
from podcast_mcp.engines.ungated_audio import (
    load_mono_full,
    resample_streams,
    resampler_locality,
)

SOURCE_RATE = 48000
RATES = (8000, 16000)
SECONDS = 4
SPEECH_WAV = os.environ.get("PODCAST_LAB_SPEECH_WAV")
SPEECH_SECONDS = 30

real_speech = pytest.mark.skipif(
    not SPEECH_WAV, reason="set PODCAST_LAB_SPEECH_WAV to a speech recording"
)


def _noise(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(SECONDS * SOURCE_RATE) * 0.1).astype(np.float32)


def _chirp() -> np.ndarray:
    t = np.arange(SECONDS * SOURCE_RATE) / SOURCE_RATE
    sweep = np.sin(2 * np.pi * (50 * t + (23950 - 50) / (2 * SECONDS) * t**2))
    return (sweep * 0.5).astype(np.float32)


def _speech_like(seed: int) -> np.ndarray:
    """Noise under a syllable-rate envelope with silences."""
    rng = np.random.default_rng(seed)
    t = np.arange(SECONDS * SOURCE_RATE) / SOURCE_RATE
    envelope = np.clip(np.sin(2 * np.pi * 4 * t) * np.sin(2 * np.pi * 0.7 * t), 0, None)
    return (rng.standard_normal(t.size) * envelope * 0.3).astype(np.float32)


SIGNALS = {
    "noise": _noise(3),
    "chirp": _chirp(),
    "speech_like": _speech_like(5),
}


def _resample(samples: np.ndarray, rate: int) -> np.ndarray:
    return resample_streams(iter([samples]), SOURCE_RATE, [rate])[rate]


def _same_bits(got: np.ndarray, want: np.ndarray) -> bool:
    return got.shape == want.shape and np.array_equal(got.view(np.uint32), want.view(np.uint32))


def _restart(samples: np.ndarray, rate: int, start: int, warm_up: int) -> np.ndarray:
    grid = SOURCE_RATE // rate
    return _resample(samples[start - warm_up :], rate)[warm_up // grid :]


def _check_locality(samples: np.ndarray, rate: int) -> None:
    grid = SOURCE_RATE // rate
    found = resampler_locality(SOURCE_RATE, rate)
    assert found is not None
    warm_up, guard = found
    whole = _resample(samples, rate)

    for start in (600, 6006, 36036, 150000):
        got = _restart(samples, rate, start, warm_up)
        assert _same_bits(got, whole[start // grid :]), f"restart at {start}"

    for end in (12000, 36006, samples.size - 42):
        cut = _resample(samples[:end], rate)
        kept = (end - guard) // grid
        assert _same_bits(cut[:kept], whole[:kept]), f"truncation at {end}"

    edges = (900, 9000, 9006, 24000, samples.size - 600)
    joined = [
        _resample(samples[begin - warm_up : end + guard], rate)[
            warm_up // grid : warm_up // grid + (end - begin) // grid
        ]
        for begin, end in itertools.pairwise(edges)
    ]
    assert _same_bits(np.concatenate(joined), whole[edges[0] // grid : edges[-1] // grid])


@pytest.mark.parametrize("rate", RATES)
@pytest.mark.parametrize("name", sorted(SIGNALS))
def test_restarting_at_a_grid_point_gives_the_continuous_samples(name, rate):
    _check_locality(SIGNALS[name], rate)


@pytest.mark.parametrize("rate", RATES)
def test_the_widths_are_whole_grids_and_short(rate):
    warm_up, guard = resampler_locality(SOURCE_RATE, rate)

    assert warm_up % (SOURCE_RATE // rate) == 0 and guard % (SOURCE_RATE // rate) == 0
    assert 0 < warm_up <= 1024 and 0 < guard <= 1024


@pytest.mark.parametrize("rate", RATES)
def test_warm_up_is_minimal(rate):
    grid = SOURCE_RATE // rate
    warm_up, _guard = resampler_locality(SOURCE_RATE, rate)
    samples = SIGNALS["noise"]
    start = 36036

    got = _restart(samples, rate, start, warm_up - grid)
    assert not _same_bits(got, _resample(samples, rate)[start // grid :])


@pytest.mark.parametrize("rate", RATES)
def test_guard_is_minimal(rate):
    grid = SOURCE_RATE // rate
    _warm_up, guard = resampler_locality(SOURCE_RATE, rate)
    samples = SIGNALS["noise"]
    end = 60000

    cut = _resample(samples[:end], rate)
    kept = (end - guard + grid) // grid
    assert not _same_bits(cut[:kept], _resample(samples, rate)[:kept])


def test_bit_identity_tells_signed_zeros_apart():
    positive = np.zeros(4, dtype=np.float32)

    assert not _same_bits(positive, -positive)
    assert _same_bits(positive, positive.copy())


def test_a_warm_up_before_the_start_of_the_signal_is_refused():
    samples = SIGNALS["noise"]
    whole = _resample(samples, 8000)

    with pytest.raises(ValueError, match="before the start"):
        ungated_audio._restart_matches(samples, whole, 6, 8000, 12006)


def test_the_search_reaches_the_documented_ceiling():
    assert ungated_audio._smallest_passing(6, lambda width: width >= 8190) == 8190
    assert ungated_audio._smallest_passing(3, lambda width: width >= 8190) == 8190
    assert ungated_audio._smallest_passing(6, lambda width: False) is None


@pytest.mark.parametrize(("source", "rate"), [(44100, 8000), (44100, 16000), (48000, 12345)])
def test_other_grids_have_no_locality(source, rate):
    assert resampler_locality(source, rate) is None


def test_a_build_is_calibrated_once(monkeypatch):
    resampler_locality(SOURCE_RATE, 8000)
    calls = []
    monkeypatch.setattr(
        ungated_audio,
        "resample_streams",
        lambda *args, **kwargs: calls.append(args) or {},
    )

    resampler_locality(SOURCE_RATE, 8000)

    assert calls == []


def test_a_different_build_is_calibrated_again(monkeypatch):
    resampler_locality(SOURCE_RATE, 8000)
    build = ungated_audio._ffmpeg_build_id()
    monkeypatch.setattr(ungated_audio, "_ffmpeg_build_id", lambda: (*build, "other"))
    calls = []
    real = ungated_audio.resample_streams
    monkeypatch.setattr(
        ungated_audio,
        "resample_streams",
        lambda *args, **kwargs: calls.append(args) or real(*args, **kwargs),
    )

    resampler_locality(SOURCE_RATE, 8000)

    assert calls


@real_speech
@pytest.mark.parametrize("rate", RATES)
def test_real_speech_restarts_exactly(rate):
    """Real speech restarts exactly at the calibrated width."""
    samples = load_mono_full(Path(os.environ["PODCAST_LAB_SPEECH_WAV"]), sample_rate=SOURCE_RATE)[
        : SPEECH_SECONDS * SOURCE_RATE
    ]
    _check_locality(samples, rate)
