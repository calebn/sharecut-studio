"""Long recorded-path delay evidence; these measurements never authorize a speech edit."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines import bleed_echo
from podcast_mcp.engines.bleed_echo import EchoConfig, echo_pair_profile

RATE = 8000


def _voice(seed: int, seconds: float = 24.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    clock = np.arange(round(seconds * RATE)) / RATE
    envelope = 0.4 + 0.6 * np.sin(2 * np.pi * 3.7 * clock) ** 2
    noise = rng.normal(0, 0.08, clock.size)
    return (np.convolve(noise, [0.7, 0.3], mode="same") * envelope).astype(np.float32)


def _copy(source: np.ndarray, delay_ms: float, gain: float) -> np.ndarray:
    offset = round(delay_ms * RATE / 1000)
    out = np.zeros_like(source)
    if offset > 0:
        out[offset:] = source[:-offset] * gain
    elif offset < 0:
        out[:offset] = source[-offset:] * gain
    else:
        out[:] = source * gain
    return out


def _measure(source: np.ndarray, target: np.ndarray):
    return bleed_echo.measure_long_delay_regions(
        source,
        target,
        sample_rate=RATE,
        t0=100.0,
        source_track_id="direct",
        bleed_track_id="retained",
    )


@pytest.mark.parametrize("delay_ms", [-150.0, 150.0, 350.0])
def test_network_scale_copies_have_signed_local_evidence(delay_ms: float) -> None:
    source = _voice(11)
    target = _copy(source, delay_ms, 0.15)
    rows = _measure(source, target)
    supported = [row for row in rows if row.supported]
    assert len(supported) >= 10
    assert np.median([row.lag_ms for row in supported]) == pytest.approx(delay_ms, abs=0.5)
    assert all(row.peak_ncc >= row.null_ncc + 0.2 for row in supported)
    assert all(100.0 <= row.start < row.end <= 124.0 for row in supported)
    assert all(row.source_track_id == "direct" for row in supported)
    assert all(row.bleed_track_id == "retained" for row in supported)


def test_existing_profile_surfaces_long_delay_without_changing_short_scale_rates() -> None:
    source = _voice(12)
    target = _copy(source, 150.0, 0.15)
    cfg = EchoConfig()
    profile = echo_pair_profile(
        source,
        target,
        sample_rate=RATE,
        t0=0.0,
        source_track_id="direct",
        bleed_track_id="retained",
        config=cfg,
    )
    assert profile.copy_frames == 0
    assert profile.echo_risk(cfg) is False
    evidence = profile.to_dict(cfg)["long_delay_regions"]
    assert len([row for row in evidence if row["supported"]]) >= 10
    assert np.median([row["lag_ms"] for row in evidence if row["supported"]]) == pytest.approx(
        150.0, abs=0.5
    )


@pytest.mark.parametrize("gain", [0.1, 0.3])
def test_different_microphone_eq_and_noise_still_measure_copy_delay(gain: float) -> None:
    source = _voice(13)
    colored = np.convolve(source, [0.65, 0.3, 0.05], mode="same")
    target = _copy(colored, -170.0, gain)
    target += np.random.default_rng(14).normal(0, gain * 0.002, target.size)
    supported = [row for row in _measure(source, target) if row.supported]
    assert len(supported) >= 10
    assert np.median([row.lag_ms for row in supported]) == pytest.approx(-170.0, abs=1.0)


def test_periodic_similarity_is_rejected_by_shifted_null() -> None:
    clock = np.arange(24 * RATE) / RATE
    source = (0.1 * np.sin(2 * np.pi * 200 * clock)).astype(np.float32)
    target = _copy(source, 150.0, 0.15)
    rows = _measure(source, target)
    assert rows
    assert not any(row.supported for row in rows)
    assert any(row.reason == "periodic_or_null_similarity" for row in rows)


def test_unrelated_co_speech_is_not_a_recorded_path() -> None:
    assert not any(row.supported for row in _measure(_voice(15), _voice(16) * 0.3))


def test_measuring_copy_during_owner_overlap_does_not_authorize_owner_absence() -> None:
    source = _voice(17)
    target = _copy(source, 150.0, 0.15) + _voice(18) * 0.015
    before_source, before_target = source.copy(), target.copy()
    supported = [row for row in _measure(source, target) if row.supported]
    assert supported
    assert all(row.owner_absence_proven is False for row in supported)
    np.testing.assert_array_equal(source, before_source)
    np.testing.assert_array_equal(target, before_target)


def test_local_delay_change_is_exposed_instead_of_collapsed_to_global_offset() -> None:
    source = _voice(19)
    first, second = _copy(source, 150.0, 0.15), _copy(source, 210.0, 0.15)
    target = first.copy()
    target[12 * RATE :] = second[12 * RATE :]
    rows = [row for row in _measure(source, target) if row.supported]
    early = [row.lag_ms for row in rows if row.end <= 110.0]
    late = [row.lag_ms for row in rows if row.start >= 114.0]
    assert len(early) >= 3 and len(late) >= 3
    assert np.median(early) == pytest.approx(150.0, abs=0.5)
    assert np.median(late) == pytest.approx(210.0, abs=0.5)


def test_short_or_silent_input_has_no_supported_delay() -> None:
    short = np.zeros(round(0.08 * RATE), dtype=np.float32)
    assert not any(row.supported for row in _measure(short, short))
    silent = np.zeros(24 * RATE, dtype=np.float32)
    assert not any(row.supported for row in _measure(silent, silent))
