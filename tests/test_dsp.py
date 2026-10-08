"""Shared numpy DSP primitives (util/dsp.py)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.util.dsp import (
    autocorr_peak,
    bool_runs,
    bridge_short_dips,
    db_to_amplitude,
    frame_band_db,
    frame_db_stream,
    frame_level_noise_db,
    frame_peak_db,
    frame_rms_db,
    frame_rms_db_stream,
    frame_speech_band_db,
    high_band_energy_fraction,
    next_fast_len,
    rms_db,
    speech_band,
    voicing_probes,
)


def test_rms_db_levels_and_floor() -> None:
    assert rms_db(np.full(100, 0.1)) == pytest.approx(-20.0)
    assert rms_db(np.array([])) == -80.0
    assert rms_db(np.zeros(10), floor_db=-200.0) == -200.0


def test_frame_rms_db_matches_scalar_rms_and_caps_frames() -> None:
    x = np.concatenate([np.zeros(400), np.full(400, 0.1)]).astype(np.float32)

    levels = frame_rms_db(x, 400, 400)

    assert levels.tolist() == [-200.0, pytest.approx(-20.0)]
    assert frame_rms_db(x, 400, 100, max_frames=2).size == 2
    assert frame_rms_db(x[:10], 400, 100).size == 0
    assert frame_rms_db(x, 0, 100).size == 0


def test_frame_band_db_reads_only_the_band_above_its_cutoff() -> None:
    rate = 16_000
    noise = np.random.default_rng(5).standard_normal(rate) * 10 ** (-30 / 20)
    hum = 0.1 * np.sin(2 * np.pi * 500.0 * np.arange(rate) / rate)

    noise_db = frame_band_db(noise, rate, 320, 160, lo_hz=2000.0)
    hum_db = frame_band_db(hum, rate, 320, 160, lo_hz=2000.0)

    assert float(np.median(noise_db)) == pytest.approx(-31.25, abs=0.5)
    assert float(np.max(hum_db)) < -90.0
    assert frame_band_db(np.zeros(320), rate, 320, 160, lo_hz=2000.0).tolist() == [-200.0]
    assert frame_band_db(noise[:10], rate, 320, 160, lo_hz=2000.0).size == 0


@pytest.mark.parametrize("chunk_size", [1, 7, 399, 400, 401, 1000, 5000])
def test_frame_rms_db_stream_matches_whole_array(chunk_size):
    rng = np.random.default_rng(11)
    x = rng.uniform(-1, 1, 4321).astype(np.float32)
    chunks = [x[i : i + chunk_size] for i in range(0, x.size, chunk_size)]

    np.testing.assert_array_equal(frame_rms_db_stream(chunks, 400, 160), frame_rms_db(x, 400, 160))


def test_frame_peak_db_reads_a_click_the_rms_averages_away() -> None:
    x = np.zeros(800, dtype=np.float32)
    x[500] = 0.01

    assert frame_peak_db(x, 400, 400).tolist() == [-200.0, pytest.approx(-40.0)]
    assert frame_rms_db(x, 400, 400)[1] == pytest.approx(-66.0, abs=0.1)
    assert frame_peak_db(x[:10], 400, 100).size == 0


@pytest.mark.parametrize("chunk_size", [1, 399, 401, 5000])
def test_frame_db_stream_runs_every_reducer_in_one_pass(chunk_size):
    x = np.random.default_rng(3).uniform(-1, 1, 4321).astype(np.float32)
    chunks = [x[i : i + chunk_size] for i in range(0, x.size, chunk_size)]

    rms, peak = frame_db_stream(chunks, 400, 160, (frame_rms_db, frame_peak_db))

    np.testing.assert_array_equal(rms, frame_rms_db(x, 400, 160))
    np.testing.assert_array_equal(peak, frame_peak_db(x, 400, 160))


def test_frame_rms_db_stream_empty_and_zero_frame():
    assert frame_rms_db_stream([], 400, 160).size == 0
    assert frame_rms_db_stream([np.zeros(1000, dtype=np.float32)], 0, 160).size == 0


def test_autocorr_peak_finds_pitch_and_rejects_degenerate_frames() -> None:
    sr = 16_000
    t = np.arange(640) / sr
    peak = autocorr_peak(np.sin(2 * np.pi * 200 * t), sr, fmin=70, fmax=400)

    assert peak is not None
    assert peak[0] == pytest.approx(200.0, rel=0.02)
    assert peak[1] > 0.8
    assert autocorr_peak(np.zeros(640), sr, fmin=70, fmax=400) is None
    # Too short to cover the lag range.
    assert autocorr_peak(np.sin(2 * np.pi * 200 * t[:40]), sr, fmin=70, fmax=400) is None


def test_bool_runs_and_dip_bridging() -> None:
    mask = np.array([1, 1, 0, 1, 0, 0, 0, 1, 0], dtype=bool)

    assert bool_runs(mask) == [(0, 2), (3, 4), (7, 8)]
    assert bool_runs(np.array([], dtype=bool)) == []
    # Interior dips of <= 1 frame are filled; longer dips and edge runs are not.
    assert bridge_short_dips(mask, 1).tolist() == [1, 1, 1, 1, 0, 0, 0, 1, 0]
    assert bridge_short_dips(mask, 3).tolist() == [1, 1, 1, 1, 1, 1, 1, 1, 0]
    assert bridge_short_dips(mask, 0).tolist() == mask.tolist()


def test_db_to_amplitude() -> None:
    assert db_to_amplitude(0.0) == 1.0
    assert db_to_amplitude(-20.0) == pytest.approx(0.1)
    assert db_to_amplitude(6.0) == pytest.approx(1.9953, rel=1e-4)
    assert db_to_amplitude(-6.0) * db_to_amplitude(6.0) == pytest.approx(1.0)


def test_voicing_probes_score_periodic_frames_high_and_noise_low() -> None:
    sr = 16_000
    t = np.arange(sr // 10) / sr
    kwargs = {"probe_sec": 0.04, "hop_sec": 0.01, "fmin": 70, "fmax": 400}

    tone = voicing_probes(np.sin(2 * np.pi * 200 * t), sr, **kwargs)
    assert tone.shape == (7,)
    assert tone.min() > 0.8
    noise = voicing_probes(np.random.default_rng(1).normal(0.0, 1.0, t.size), sr, **kwargs)
    assert noise.max() < 0.3
    # Silent frames score 0; input shorter than one probe is scored as a single frame.
    assert voicing_probes(np.zeros(640), sr, **kwargs).tolist() == [0.0]
    assert voicing_probes(np.sin(2 * np.pi * 200 * t[:320]), sr, **kwargs).shape == (1,)
    assert voicing_probes(np.zeros(0), sr, **kwargs).size == 0


def test_high_band_energy_fraction_splits_low_and_high_tones() -> None:
    sr = 16_000
    t = np.arange(1600) / sr
    kwargs = {"split_hz": 4000, "lo_hz": 100, "hi_hz": 8000}

    assert high_band_energy_fraction(np.sin(2 * np.pi * 500 * t), sr, **kwargs) < 0.01
    assert high_band_energy_fraction(np.sin(2 * np.pi * 6000 * t), sr, **kwargs) > 0.99
    mixed = np.sin(2 * np.pi * 500 * t) + np.sin(2 * np.pi * 6000 * t)
    assert high_band_energy_fraction(mixed, sr, **kwargs) == pytest.approx(0.5, abs=0.02)
    assert high_band_energy_fraction(np.zeros(1600), sr, **kwargs) == 0.0
    assert high_band_energy_fraction(np.zeros(1), sr, **kwargs) == 0.0


def test_speech_band_drops_rumble_keeps_voice_and_a_gates_silence() -> None:
    rate = 16_000
    t = np.arange(rate) / rate
    rumble = 0.1 * np.sin(2 * np.pi * 30.0 * t)
    voice = 0.1 * np.sin(2 * np.pi * 400.0 * t)

    assert rms_db(speech_band(rumble, rate)) < rms_db(rumble) - 40.0
    assert rms_db(speech_band(voice, rate)) == pytest.approx(rms_db(voice), abs=0.5)
    gated = np.concatenate([np.zeros(4000), voice, np.zeros(4000)])
    assert not speech_band(gated, rate)[:4000].any()
    assert speech_band(np.zeros(8), rate).tolist() == [0.0] * 8


def test_speech_band_of_an_awkward_length_matches_the_same_signal_padded_by_hand() -> None:
    # 176003 samples is prime-ish for the FFT: the band pads to a fast length, and the
    # answer for the samples that exist is the same either way.
    rate = 16_000
    x = (0.1 * np.sin(2 * np.pi * 400.0 * np.arange(176_003) / rate)).astype(np.float32)

    padded = speech_band(np.concatenate([x, np.zeros(5)]).astype(np.float32), rate)[: x.size]

    assert speech_band(x, rate) == pytest.approx(padded, abs=1e-3)


@pytest.mark.parametrize(
    ("n", "fast"),
    [(1, 1), (7, 8), (100, 100), (176_001, 177_147), (131_073, 131_220), (2**17, 2**17)],
)
def test_next_fast_len_is_the_next_length_of_2_3_and_5(n: int, fast: int) -> None:
    assert next_fast_len(n) == fast


def test_speech_band_passes_mains_harmonics_and_frame_levels_never_read_louder_than_raw() -> None:
    rate = 16_000
    t = np.arange(rate) / rate
    fundamental = np.float32(0.05) * np.sin(2 * np.pi * 60.0 * t)
    harmonics = np.float32(0.05) * (
        np.sin(2 * np.pi * 100.0 * t)
        + np.sin(2 * np.pi * 120.0 * t)
        + np.sin(2 * np.pi * 150.0 * t)
    )

    # The 60 Hz fundamental is more than 20 dB down; 100 Hz is passed 2 dB down, and 120
    # and 150 Hz untouched.
    assert rms_db(speech_band(fundamental, rate)) < rms_db(fundamental) - 20.0
    assert rms_db(speech_band(harmonics, rate)) == pytest.approx(rms_db(harmonics), abs=0.7)
    for x in (fundamental, harmonics):
        assert np.all(frame_speech_band_db(x, rate, 160) <= frame_rms_db(x, 160, 160) + 1e-9)


def test_frame_level_noise_is_what_stationary_noise_reads() -> None:
    # The std of white noise's 10 ms frame levels is what frame_level_noise_db says it
    # is for that frame length; a 50 ms average of five such frames reads a fifth of the
    # variance.
    rate = 16_000
    noise = np.random.default_rng(3).standard_normal(rate * 60).astype(np.float32) * 0.01
    levels = frame_speech_band_db(noise, rate, 160)
    power = 10.0 ** (levels / 10.0)
    averaged = 10.0 * np.log10(np.convolve(power, np.ones(5) / 5.0, mode="valid"))

    assert float(levels.std()) == pytest.approx(frame_level_noise_db(rate, 0.01), rel=0.08)
    assert float(averaged.std()) == pytest.approx(frame_level_noise_db(rate, 0.05), rel=0.08)
