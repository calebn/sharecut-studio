"""Shared numpy DSP primitives (util/dsp.py)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.util.dsp import (
    DIGITAL_SILENCE_DB,
    LOW_BAND,
    SPEECH_BAND,
    GaussianBand,
    autocorr_peak,
    band_filter,
    bool_runs,
    bridge_short_dips,
    db_to_amplitude,
    frame_band_db,
    frame_band_filtered_db,
    frame_db_stream,
    frame_level_noise_db,
    frame_peak_db,
    frame_rms_db,
    frame_rms_db_stream,
    high_band_energy_fraction,
    is_valley,
    next_fast_len,
    rms_db,
    valley_basins,
    valley_depth_db,
    valley_depths_db,
    voicing_pitch_probes,
    voicing_probes,
)


def test_rms_db_levels_and_floor() -> None:
    assert rms_db(np.full(100, 0.1)) == pytest.approx(-20.0)
    assert rms_db(np.array([])) == DIGITAL_SILENCE_DB
    assert rms_db(np.zeros(10), floor_db=-120.0) == -120.0


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


def test_autocorr_peak_interior_ignores_a_correlation_that_only_falls() -> None:
    sr = 16_000
    t = np.arange(640) / sr
    rumble = np.sin(2 * np.pi * 30 * t) + 0.3 * np.sin(2 * np.pi * 45 * t + 1.0)
    voice = np.sin(2 * np.pi * 200 * t)

    plain = autocorr_peak(rumble, sr, fmin=70, fmax=350)
    assert plain is not None
    assert plain[0] == pytest.approx(sr // int(sr / 350), rel=0.01)
    assert plain[1] > 0.55
    assert autocorr_peak(rumble, sr, fmin=70, fmax=350, interior=True) is None
    interior = autocorr_peak(voice, sr, fmin=70, fmax=350, interior=True)
    assert interior is not None
    assert interior[0] == pytest.approx(200.0, rel=0.02)
    assert (
        voicing_probes(
            rumble, sr, probe_sec=0.04, hop_sec=0.01, fmin=70, fmax=350, interior=True
        ).max()
        == 0.0
    )


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

    assert rms_db(band_filter(rumble, rate, SPEECH_BAND)) < rms_db(rumble) - 40.0
    assert rms_db(band_filter(voice, rate, SPEECH_BAND)) == pytest.approx(rms_db(voice), abs=0.5)
    gated = np.concatenate([np.zeros(4000), voice, np.zeros(4000)])
    assert not band_filter(gated, rate, SPEECH_BAND)[:4000].any()
    assert band_filter(np.zeros(8), rate, SPEECH_BAND).tolist() == [0.0] * 8


def test_speech_band_of_an_awkward_length_matches_the_same_signal_padded_by_hand() -> None:
    # 176003 samples is prime-ish for the FFT: the band pads to a fast length, and the
    # answer for the samples that exist is the same either way.
    rate = 16_000
    x = (0.1 * np.sin(2 * np.pi * 400.0 * np.arange(176_003) / rate)).astype(np.float32)

    padded = band_filter(np.concatenate([x, np.zeros(5)]).astype(np.float32), rate, SPEECH_BAND)

    assert band_filter(x, rate, SPEECH_BAND) == pytest.approx(padded[: x.size], abs=1e-3)


@pytest.mark.parametrize(
    ("n", "fast"),
    [(1, 1), (7, 8), (100, 100), (176_001, 177_147), (131_073, 131_220), (2**17, 2**17)],
)
def test_next_fast_len_is_the_next_length_of_2_3_and_5(n: int, fast: int) -> None:
    assert next_fast_len(n) == fast


def _tone(hz: float, rate: int = 16_000) -> np.ndarray:
    return (0.05 * np.sin(2 * np.pi * hz * np.arange(rate) / rate)).astype(np.float32)


@pytest.mark.parametrize(
    ("hz", "loss_db"),
    [(100.0, None), (110.0, 23.5), (120.0, 12.0), (130.0, 6.0), (140.0, 2.5), (150.0, 0.6)],
)
def test_the_band_fades_in_from_100_to_160_hz(hz: float, loss_db: float | None) -> None:
    # Mains hum's 100 Hz harmonic is gone, 60 Hz mains' 120 Hz one is 12 dB down, and
    # 150 Hz is all but passed: a raised cosine from 100 Hz (stopped) to 160 Hz.
    tone = _tone(hz)

    got = rms_db(band_filter(tone, 16_000, SPEECH_BAND), floor_db=-300.0) - rms_db(tone)

    if loss_db is None:
        assert got < -100.0
    else:
        assert got == pytest.approx(-loss_db, abs=0.1)


def test_a_flat_rumble_up_to_110_hz_is_38_db_down_and_frame_levels_never_read_louder_than_raw():
    # Room rumble with a flat spectrum from 25 to 110 Hz is 38 dB down: only its 100 to
    # 110 Hz sliver passes, and that 23 dB down or more. A band from 50 Hz let it through
    # 7 dB down. A rumble that is not flat is not: its energy near 100 Hz passes (the low
    # band reads it, below).
    rate = 16_000
    spectrum = np.fft.rfft(np.random.default_rng(9).standard_normal(rate * 4))
    freqs = np.fft.rfftfreq(rate * 4, d=1.0 / rate)
    spectrum[(freqs < 25.0) | (freqs > 110.0)] = 0.0
    rumble = np.fft.irfft(spectrum, rate * 4).astype(np.float32)

    got = rms_db(band_filter(rumble, rate, SPEECH_BAND)) - rms_db(rumble)

    assert got == pytest.approx(-38.5, abs=0.5)
    for x in (rumble, _tone(150.0)):
        assert np.all(
            frame_band_filtered_db(x, rate, 160, SPEECH_BAND) <= frame_rms_db(x, 160, 160) + 1e-9
        )


@pytest.mark.parametrize(
    ("hz", "loss_db"),
    [
        (120.0, 0.0),
        (100.0, 1.9),
        (110.0, 0.5),
        (140.0, 1.9),
        (80.0, 7.7),
        (160.0, 7.7),
        (60.0, 17.4),
    ],
)
def test_the_low_band_passes_a_tonal_tail_at_100_to_140_hz_the_speech_band_stops(
    hz: float, loss_db: float
) -> None:
    # A room mode ringing after a word, or two hums beating, sit at 100 to 140 Hz, where
    # the speech band is stopped or half stopped. The low band is a Gaussian around 120 Hz.
    tone = _tone(hz)

    got = rms_db(band_filter(tone, 16_000, LOW_BAND), floor_db=-300.0) - rms_db(tone)

    assert got == pytest.approx(-loss_db, abs=0.2)


def test_a_gaussian_band_is_a_bell_around_its_centre() -> None:
    band = GaussianBand(center=120.0, sigma=30.0)

    gain = band.gain(np.array([120.0, 150.0, 60.0]))

    assert gain == pytest.approx([1.0, np.exp(-0.5), np.exp(-2.0)])


def test_a_bands_noise_bandwidth_is_the_width_of_a_flat_band_that_passes_as_much_noise() -> None:
    rate = 16_000
    white = np.random.default_rng(5).standard_normal(rate * 20).astype(np.float64)
    for band in (SPEECH_BAND, LOW_BAND, GaussianBand(120.0, 30.0)):
        filtered = band_filter(white, rate, band)
        measured = float(np.mean(filtered**2)) / float(np.mean(white**2)) * rate / 2.0
        assert measured == pytest.approx(band.noise_bandwidth(rate), rel=0.05)


def test_frame_level_noise_is_what_stationary_noise_reads() -> None:
    # The std of white noise's 10 ms frame levels is what frame_level_noise_db says it
    # is for that frame length; a 50 ms average of five such frames reads a fifth of the
    # variance.
    rate = 16_000
    noise = np.random.default_rng(3).standard_normal(rate * 60).astype(np.float32) * 0.01
    levels = frame_band_filtered_db(noise, rate, 160, SPEECH_BAND)
    power = 10.0 ** (levels / 10.0)
    averaged = 10.0 * np.log10(np.convolve(power, np.ones(5) / 5.0, mode="valid"))

    assert float(levels.std()) == pytest.approx(
        frame_level_noise_db(SPEECH_BAND, rate, 0.01), rel=0.08
    )
    assert float(averaged.std()) == pytest.approx(
        frame_level_noise_db(SPEECH_BAND, rate, 0.05), rel=0.08
    )


def test_valley_depth_is_the_shallower_climb_before_the_level_falls_under() -> None:
    levels = np.array([-10.0, -12.0, -30.0, -22.0, -14.0, -40.0, -9.0])

    # Left climbs 20 dB to -10; right climbs 16 dB to -14 before -40 falls under.
    assert valley_depth_db(levels, 2) == pytest.approx(16.0)
    assert is_valley(levels, 2, 15.0)
    assert not is_valley(levels, 2, 17.0)
    # The ends have no side to climb on; a dip into a deeper dip is a ripple.
    assert valley_depth_db(levels, 0) == 0.0
    assert valley_depth_db(levels, 6) == 0.0
    assert valley_depth_db(levels, 1) == pytest.approx(0.0)


def test_valley_basin_is_the_lower_half_of_the_valley_in_every_recording_level() -> None:
    levels = np.array([-10.0, -10.0, -14.0, -20.0, -26.0, -30.0, -26.0, -20.0, -14.0, -10.0, -10.0])

    basin = valley_basins(levels, 10.0)

    # 20 dB deep: the lower half is -20 dB and under, frames 3 to 7.
    assert np.flatnonzero(basin).tolist() == [3, 4, 5, 6, 7]
    assert np.array_equal(valley_basins(levels + 40.0, 10.0), basin)
    assert not valley_basins(levels, 21.0).any()


def _reference_autocorr_peak(
    samples: np.ndarray, sample_rate: int, *, fmin: float, fmax: float, interior: bool = False
) -> tuple[float, float] | None:
    x = samples.astype(np.float64, copy=True)
    x -= np.mean(x) if x.size else 0.0
    energy = float(np.dot(x, x))
    if energy <= 1e-12:
        return None
    min_lag = max(1, int(sample_rate / fmax))
    max_lag = min(int(sample_rate / fmin), x.size // 2)
    if max_lag <= min_lag + 2:
        return None
    corr = np.correlate(x, x, mode="full")[x.size - 1 :]
    seg = corr[min_lag:max_lag]
    if interior:
        around = corr[min_lag - 1 : max_lag + 1]
        seg = np.where((seg > around[:-2]) & (seg >= around[2:]), seg, -np.inf)
        if not np.isfinite(seg).any():
            return None
    lag = int(np.argmax(seg)) + min_lag
    return float(sample_rate) / float(lag), float(corr[lag]) / energy


def _reference_voicing_probes(
    samples: np.ndarray,
    sample_rate: int,
    *,
    probe_sec: float,
    hop_sec: float,
    fmin: float,
    fmax: float,
    interior: bool = False,
) -> np.ndarray:
    if samples.size == 0:
        return np.empty(0, dtype=np.float64)
    frame = min(samples.size, max(1, round(sample_rate * probe_sec)))
    hop = max(1, round(sample_rate * hop_sec))
    scores = []
    for start in range(0, samples.size - frame + 1, hop):
        peak = _reference_autocorr_peak(
            samples[start : start + frame], sample_rate, fmin=fmin, fmax=fmax, interior=interior
        )
        scores.append(peak[1] if peak is not None else 0.0)
    return np.asarray(scores, dtype=np.float64)


def _voiced(seconds: float, sr: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(round(seconds * sr)) / sr
    f0 = 140 + 40 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / sr
    voiced = sum(np.sin(h * phase) / h for h in range(1, 9))
    gate = np.clip(np.sin(2 * np.pi * 1.3 * t), 0, 1)
    return (0.3 * gate * voiced + 0.02 * rng.normal(size=t.size)).astype(np.float32)


def _single_frame_cases(sr: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(7)
    t = np.arange(round(sr * 0.04)) / sr
    return {
        "random": rng.normal(size=t.size),
        "tone": np.sin(2 * np.pi * 200 * t),
        "harmonic": np.sin(2 * np.pi * 120 * t) + 0.5 * np.sin(2 * np.pi * 240 * t + 0.4),
        "rumble": np.sin(2 * np.pi * 30 * t) + 0.3 * np.sin(2 * np.pi * 45 * t + 1.0),
        "dc_offset": 0.5 + 0.1 * np.sin(2 * np.pi * 150 * t),
        "silent": np.zeros(t.size),
        "constant": np.full(t.size, 0.25),
        "too_short": np.sin(2 * np.pi * 200 * t[:40]),
        "float32": _voiced(0.04, sr, 3),
        "empty": np.zeros(0),
    }


@pytest.mark.parametrize("interior", [False, True])
@pytest.mark.parametrize("sr", [8_000, 16_000, 44_100, 48_000])
def test_autocorr_peak_matches_full_correlation_reference(sr: int, interior: bool) -> None:
    for name, frame in _single_frame_cases(sr).items():
        expected = _reference_autocorr_peak(frame, sr, fmin=70, fmax=350, interior=interior)
        actual = autocorr_peak(frame, sr, fmin=70, fmax=350, interior=interior)
        if expected is None:
            assert actual is None, name
            continue
        assert actual is not None, name
        assert actual[0] == expected[0], name
        assert actual[1] == pytest.approx(expected[1], abs=1e-9), name


@pytest.mark.parametrize("interior", [False, True])
@pytest.mark.parametrize("seed", range(6))
def test_autocorr_peak_matches_reference_on_random_frames(seed: int, interior: bool) -> None:
    rng = np.random.default_rng(seed)
    sr = 16_000
    for size in (37, 150, 640, 641, 1000):
        frame = rng.normal(size=size)
        expected = _reference_autocorr_peak(frame, sr, fmin=70, fmax=400, interior=interior)
        actual = autocorr_peak(frame, sr, fmin=70, fmax=400, interior=interior)
        assert (actual is None) == (expected is None)
        if expected is not None and actual is not None:
            assert actual[0] == expected[0]
            assert actual[1] == pytest.approx(expected[1], abs=1e-9)


@pytest.mark.parametrize("interior", [False, True])
@pytest.mark.parametrize("sr", [16_000, 48_000])
def test_voicing_probes_match_per_frame_reference(sr: int, interior: bool) -> None:
    kwargs = {"probe_sec": 0.04, "hop_sec": 0.01, "fmin": 70.0, "fmax": 350.0}
    silent = np.zeros(sr // 4, dtype=np.float32)
    mixed = np.concatenate([_voiced(1.2, sr, 1), silent, _voiced(0.3, sr, 2)])
    for samples in (mixed, _voiced(0.03, sr, 4), silent, np.zeros(0, dtype=np.float32)):
        actual = voicing_probes(samples, sr, interior=interior, **kwargs)
        expected = _reference_voicing_probes(samples, sr, interior=interior, **kwargs)
        assert actual.shape == expected.shape
        np.testing.assert_allclose(actual, expected, rtol=0.0, atol=1e-9)


def test_voicing_probes_span_more_than_one_chunk() -> None:
    sr = 16_000
    samples = _voiced(5.0, sr, 5)
    kwargs = {"probe_sec": 0.04, "hop_sec": 0.01, "fmin": 70.0, "fmax": 350.0}
    actual = voicing_probes(samples, sr, **kwargs)
    assert actual.size > 256
    np.testing.assert_allclose(
        actual, _reference_voicing_probes(samples, sr, **kwargs), rtol=0.0, atol=1e-9
    )


def test_voicing_pitch_probes_report_each_frames_f0_and_peak() -> None:
    sr = 16_000
    t = np.arange(sr // 5) / sr
    samples = np.concatenate([np.sin(2 * np.pi * 200 * t), np.zeros(sr // 10)])
    kwargs = {"probe_sec": 0.04, "hop_sec": 0.02, "fmin": 70.0, "fmax": 350.0}
    f0, peak = voicing_pitch_probes(samples, sr, **kwargs)
    frame = round(sr * 0.04)
    hop = round(sr * 0.02)
    for index, start in enumerate(range(0, samples.size - frame + 1, hop)):
        expected = _reference_autocorr_peak(
            samples[start : start + frame], sr, fmin=70.0, fmax=350.0
        )
        assert (f0[index], peak[index]) == pytest.approx(expected or (0.0, 0.0), abs=1e-9)
    assert peak[-1] == 0.0
    assert f0[-1] == 0.0
    assert voicing_pitch_probes(np.zeros(0), sr, **kwargs)[0].size == 0


@pytest.mark.parametrize("quantized", [False, True])
def test_valley_depths_db_matches_the_per_frame_walk(quantized):
    rng = np.random.default_rng(11)
    for size in (0, 1, 2, 3, 7, 40, 90):
        levels = rng.normal(-40.0, 10.0, size)
        if quantized:
            levels = np.round(levels / 4.0) * 4.0
        expected = [valley_depth_db(levels, k) for k in range(size)]
        assert valley_depths_db(levels).tolist() == expected
