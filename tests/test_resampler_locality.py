"""Restarting the ffmpeg resampler at a grid point reproduces the continuous run bit for bit (#1958).

``resample_streams`` is a polyphase FIR with an integer ratio, so an output sample depends
on a finite window of input. ``resampler_warm_up_and_guard`` measures that window on the
running build; these tests check what it reports on other signals, at a start, an end and
across back-to-back blocks.
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
    resampler_warm_up_and_guard,
)

SOURCE_RATE = 48000
RATES = {8000: 6, 16000: 3}
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
    """Noise under a syllable-rate envelope with silences, as speech is gated."""
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


def _first_difference(got: np.ndarray, want: np.ndarray) -> int | None:
    if got.size != want.size:
        return min(got.size, want.size)
    differing = np.flatnonzero(got != want)
    return int(differing[0]) if differing.size else None


def _restart(samples: np.ndarray, rate: int, start: int, warm_up: int) -> np.ndarray:
    """Output from input index ``start`` on, from a run begun ``warm_up`` samples earlier."""
    grid = RATES[rate]
    return _resample(samples[start - warm_up :], rate)[warm_up // grid :]


def _check_locality(samples: np.ndarray, rate: int) -> None:
    grid = RATES[rate]
    found = resampler_warm_up_and_guard(SOURCE_RATE, rate)
    assert found is not None
    warm_up, guard = found
    whole = _resample(samples, rate)

    for start in (warm_up, 6 * grid * 100, 6 * grid * 1001, 6 * grid * 4999):
        got = _restart(samples, rate, start, warm_up)
        want = whole[start // grid :]
        assert _first_difference(got, want) is None, f"restart at {start}"

    for end in (6 * grid * 2000, 6 * grid * 6001, samples.size - 6 * grid * 7):
        cut = _resample(samples[:end], rate)
        kept = (end - guard) // grid
        assert _first_difference(cut[:kept], whole[:kept]) is None, f"truncation at {end}"

    edges = [6 * grid * 150, 6 * grid * 1500, 6 * grid * 1501, 6 * grid * 4000, samples.size - 600]
    edges = [edge // grid * grid for edge in edges]
    joined = [
        _resample(samples[begin - warm_up : end + guard], rate)[
            warm_up // grid : warm_up // grid + (end - begin) // grid
        ]
        for begin, end in itertools.pairwise(edges)
    ]
    assert (
        _first_difference(np.concatenate(joined), whole[edges[0] // grid : edges[-1] // grid])
        is None
    )


@pytest.mark.parametrize("rate", sorted(RATES))
@pytest.mark.parametrize("name", sorted(SIGNALS))
def test_restarting_at_a_grid_point_gives_the_continuous_samples(name, rate):
    _check_locality(SIGNALS[name], rate)


@pytest.mark.parametrize("rate", sorted(RATES))
def test_the_widths_are_whole_grids_and_short(rate):
    warm_up, guard = resampler_warm_up_and_guard(SOURCE_RATE, rate)

    assert warm_up % RATES[rate] == 0 and guard % RATES[rate] == 0
    assert 0 < warm_up <= 1024 and 0 < guard <= 1024
    assert resampler_locality(SOURCE_RATE, rate) == max(warm_up, guard)


@pytest.mark.parametrize("rate", sorted(RATES))
def test_one_grid_less_warm_up_differs(rate):
    """The measured width is the smallest that works, not a loose bound the signals never test."""
    grid = RATES[rate]
    warm_up, _guard = resampler_warm_up_and_guard(SOURCE_RATE, rate)
    samples = SIGNALS["noise"]
    start = 6 * grid * 1001

    got = _restart(samples, rate, start, warm_up - grid)
    assert _first_difference(got, _resample(samples, rate)[start // grid :]) is not None


@pytest.mark.parametrize(("source", "rate"), [(44100, 8000), (44100, 16000), (48000, 12345)])
def test_other_grids_have_no_locality(source, rate):
    assert resampler_locality(source, rate) is None


def test_a_build_is_calibrated_once(monkeypatch):
    resampler_warm_up_and_guard(SOURCE_RATE, 8000)
    calls = []
    monkeypatch.setattr(
        ungated_audio,
        "resample_streams",
        lambda *args, **kwargs: calls.append(args) or {},
    )

    resampler_warm_up_and_guard(SOURCE_RATE, 8000)

    assert calls == []


def test_a_different_build_is_calibrated_again(monkeypatch):
    resampler_warm_up_and_guard(SOURCE_RATE, 8000)
    build = ungated_audio._ffmpeg_build_id()
    monkeypatch.setattr(ungated_audio, "_ffmpeg_build_id", lambda: (*build, "other"))
    calls = []
    real = ungated_audio.resample_streams
    monkeypatch.setattr(
        ungated_audio,
        "resample_streams",
        lambda *args, **kwargs: calls.append(args) or real(*args, **kwargs),
    )

    resampler_warm_up_and_guard(SOURCE_RATE, 8000)

    assert calls


@real_speech
@pytest.mark.parametrize("rate", sorted(RATES))
def test_real_speech_restarts_exactly(rate):
    """The Mac lab check: a recording's speech, with its silences and plosives, at the calibrated width."""
    assert SPEECH_WAV is not None
    samples = load_mono_full(Path(SPEECH_WAV), sample_rate=SOURCE_RATE)[
        : SPEECH_SECONDS * SOURCE_RATE
    ]
    found = resampler_warm_up_and_guard(SOURCE_RATE, rate)
    print(f"ffmpeg build {ungated_audio._ffmpeg_build_id()} {rate}: W, G = {found}")
    _check_locality(samples, rate)
