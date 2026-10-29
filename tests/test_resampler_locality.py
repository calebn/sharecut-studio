from __future__ import annotations

import itertools
import os
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import ungated_audio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.ungated_audio import (
    load_mono_full,
    resampler_grid,
    resampler_locality,
)

SOURCE_RATE = 48000
SOURCE_RATES = (48000, 44100)
RATES = (8000, 16000)
CASES = [(source, rate) for source in SOURCE_RATES for rate in RATES]
SECONDS = 4
SPEECH_WAV = os.environ.get("PODCAST_LAB_SPEECH_WAV")
SPEECH_SECONDS = 30

real_speech = pytest.mark.skipif(
    not SPEECH_WAV, reason="set PODCAST_LAB_SPEECH_WAV to a speech recording"
)


def _noise(seed: int, source: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(SECONDS * source) * 0.1).astype(np.float32)


def _chirp(source: int) -> np.ndarray:
    t = np.arange(SECONDS * source) / source
    sweep = np.sin(2 * np.pi * (50 * t + (source / 2 - 50) / (2 * SECONDS) * t**2))
    return (sweep * 0.5).astype(np.float32)


def _speech_like(seed: int, source: int) -> np.ndarray:
    """Noise under a syllable-rate envelope with silences."""
    rng = np.random.default_rng(seed)
    t = np.arange(SECONDS * source) / source
    envelope = np.clip(np.sin(2 * np.pi * 4 * t) * np.sin(2 * np.pi * 0.7 * t), 0, None)
    return (rng.standard_normal(t.size) * envelope * 0.3).astype(np.float32)


SIGNALS = {
    source: {
        "noise": _noise(3, source),
        "chirp": _chirp(source),
        "speech_like": _speech_like(5, source),
    }
    for source in SOURCE_RATES
}


def _resample(samples: np.ndarray, source: int, rate: int) -> np.ndarray:
    return FFmpegEngine.resample_streams(iter([samples]), source, [rate])[rate]


def _same_bits(got: np.ndarray, want: np.ndarray) -> bool:
    return got.shape == want.shape and np.array_equal(got.view(np.uint32), want.view(np.uint32))


def _restart(samples: np.ndarray, source: int, rate: int, start: int, warm_up: int) -> np.ndarray:
    inputs, outputs = resampler_grid(source, rate)
    return _resample(samples[start - warm_up :], source, rate)[warm_up // inputs * outputs :]


def _check_locality(samples: np.ndarray, source: int, rate: int) -> None:
    inputs, outputs = resampler_grid(source, rate)
    found = resampler_locality(source, rate)
    assert found is not None
    warm_up, guard = found
    whole = _resample(samples, source, rate)

    def out(index: int) -> int:
        return index // inputs * outputs

    for start in (600, 6006, 36036, 150000):
        start = start // inputs * inputs
        got = _restart(samples, source, rate, start, warm_up)
        assert _same_bits(got, whole[out(start) :]), f"restart at {start}"

    for end in (12000, 36006, samples.size - 42):
        cut = _resample(samples[:end], source, rate)
        kept = out(end - guard)
        assert _same_bits(cut[:kept], whole[:kept]), f"truncation at {end}"

    edges = (
        900 // inputs * inputs,
        9000 // inputs * inputs,
        9000 // inputs * inputs + inputs,
        24000 // inputs * inputs,
        (samples.size - 600) // inputs * inputs,
    )
    joined = [
        _resample(samples[begin - warm_up : end + guard], source, rate)[
            out(warm_up) : out(warm_up) + out(end - begin)
        ]
        for begin, end in itertools.pairwise(edges)
    ]
    assert _same_bits(np.concatenate(joined), whole[out(edges[0]) : out(edges[-1])])


@pytest.mark.parametrize(("source", "rate"), CASES)
@pytest.mark.parametrize("name", sorted(SIGNALS[SOURCE_RATE]))
def test_restarting_at_a_grid_point_gives_the_continuous_samples(name, source, rate):
    _check_locality(SIGNALS[source][name], source, rate)


@pytest.mark.parametrize(("source", "rate"), CASES)
def test_the_widths_are_whole_grids_and_short(source, rate):
    warm_up, guard = resampler_locality(source, rate)
    inputs, _ = resampler_grid(source, rate)

    assert warm_up % inputs == 0 and guard % inputs == 0
    assert 0 < warm_up <= 1024 and 0 < guard <= 1024


@pytest.mark.parametrize(("source", "rate"), CASES)
def test_warm_up_is_minimal(source, rate):
    inputs, outputs = resampler_grid(source, rate)
    warm_up, _guard = resampler_locality(source, rate)
    samples = SIGNALS[source]["noise"]
    start = 36036 // inputs * inputs

    got = _restart(samples, source, rate, start, warm_up - inputs)
    assert not _same_bits(got, _resample(samples, source, rate)[start // inputs * outputs :])


@pytest.mark.parametrize(("source", "rate"), CASES)
def test_guard_is_minimal(source, rate):
    inputs, outputs = resampler_grid(source, rate)
    _warm_up, guard = resampler_locality(source, rate)
    samples = SIGNALS[source]["noise"]
    end = 60000 // inputs * inputs

    cut = _resample(samples[:end], source, rate)
    kept = (end - guard + inputs) // inputs * outputs
    assert not _same_bits(cut[:kept], _resample(samples, source, rate)[:kept])


@pytest.mark.parametrize(
    ("source", "rate", "grid"),
    [
        (48000, 8000, (6, 1)),
        (48000, 16000, (3, 1)),
        (44100, 8000, (441, 80)),
        (44100, 16000, (441, 160)),
    ],
)
def test_a_resampling_period_is_the_reduced_ratio(source, rate, grid):
    assert resampler_grid(source, rate) == grid


def test_bit_identity_tells_signed_zeros_apart():
    positive = np.zeros(4, dtype=np.float32)

    assert not _same_bits(positive, -positive)
    assert _same_bits(positive, positive.copy())


def test_a_warm_up_before_the_start_of_the_signal_is_refused():
    samples = SIGNALS[SOURCE_RATE]["noise"]
    whole = _resample(samples, SOURCE_RATE, 8000)

    with pytest.raises(AssertionError, match="before the start"):
        ungated_audio._restart_matches(samples, whole, SOURCE_RATE, 8000, 12006)


def test_a_truncation_that_keeps_nothing_proves_nothing():
    samples = SIGNALS[44100]["noise"]
    whole = _resample(samples, 44100, 8000)

    assert ungated_audio._truncation_matches(samples, whole, 44100, 8000, 441)
    assert not ungated_audio._truncation_matches(samples, whole, 44100, 8000, 8 * 8192)


def test_the_search_reaches_the_documented_ceiling():
    assert ungated_audio._smallest_passing(441, lambda width: width >= 7938) == 7938
    assert ungated_audio._smallest_passing(441, lambda width: False) is None
    assert ungated_audio._smallest_passing(6, lambda width: width >= 8190) == 8190
    assert ungated_audio._smallest_passing(3, lambda width: width >= 8190) == 8190
    assert ungated_audio._smallest_passing(6, lambda width: False) is None


@pytest.mark.parametrize(
    ("source", "rate"), [(22050, 8000), (96000, 16000), (44100, 12345), (48000, 12345)]
)
def test_other_grids_have_no_locality(source, rate):
    assert resampler_locality(source, rate) is None


def test_a_build_is_calibrated_once(monkeypatch):
    resampler_locality(SOURCE_RATE, 8000)
    calls = []
    monkeypatch.setattr(
        FFmpegEngine,
        "resample_streams",
        staticmethod(lambda *args, **kwargs: calls.append(args) or {}),
    )

    resampler_locality(SOURCE_RATE, 8000)

    assert calls == []


def test_a_different_build_is_calibrated_again(monkeypatch):
    resampler_locality(SOURCE_RATE, 8000)
    build = ungated_audio._ffmpeg_build_id()
    monkeypatch.setattr(ungated_audio, "_ffmpeg_build_id", lambda: (*build, "other"))
    calls = []
    real = FFmpegEngine.resample_streams
    monkeypatch.setattr(
        FFmpegEngine,
        "resample_streams",
        staticmethod(lambda *args, **kwargs: calls.append(args) or real(*args, **kwargs)),
    )

    resampler_locality(SOURCE_RATE, 8000)

    assert calls


@real_speech
@pytest.mark.parametrize(("source", "rate"), CASES)
def test_real_speech_restarts_exactly(source, rate):
    """Real speech restarts exactly at the calibrated width."""
    samples = load_mono_full(Path(os.environ["PODCAST_LAB_SPEECH_WAV"]), sample_rate=source)[
        : SPEECH_SECONDS * source
    ]
    _check_locality(samples, source, rate)
