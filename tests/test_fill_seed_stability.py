"""The room-tone fill noise does not depend on the last bit of its measured spectrum (#2556).

A PSD is floating-point math over decoded samples, so two runs of one project can differ by an
ulp. The fill seed must not turn that into a different noise over every muted span.
"""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines.bleed_fill import BleedFill
from podcast_mcp.engines.gate_fill import synthesise_noise

NFFT = 1024
RATE = 16_000
BINS = NFFT // 2 + 1
KEY = "host:comfort_noise"


def _psd() -> np.ndarray:
    """A coloured room: a tilt over a hum, so no bin sits on a round value."""
    freqs = np.linspace(0.0, 1.0, BINS)
    return 1e-6 * (1.0 + 3.0 * np.exp(-4.0 * freqs)) * (1.0 + 0.2 * np.sin(40.0 * freqs))


def _one_ulp(psd: np.ndarray, index: int, direction: float) -> np.ndarray:
    nudged = psd.copy()
    nudged[index] = np.nextafter(nudged[index], direction * np.inf)
    assert nudged[index] != psd[index]
    return nudged


def _fill(psd: np.ndarray) -> BleedFill:
    return BleedFill(
        "comfort_noise", -60.0, -60.0, None, RATE, NFFT, tuple(float(x) for x in psd), KEY
    )


def _same_noise(a: np.ndarray, b: np.ndarray) -> bool:
    """Equal to float32 rounding of the shaping, far below any audible or 16-bit difference."""
    return bool(np.max(np.abs(a - b)) <= 1e-5 * float(np.sqrt(np.mean(a.astype(np.float64) ** 2))))


@pytest.mark.parametrize("direction", [-1.0, 1.0])
@pytest.mark.parametrize("index", [0, 1, 37, BINS // 2, BINS - 1])
def test_synthesised_noise_ignores_a_one_ulp_difference_in_any_bin(
    index: int, direction: float
) -> None:
    psd = _psd()

    assert _same_noise(
        synthesise_noise(psd, NFFT, RATE, seed_key=KEY),
        synthesise_noise(_one_ulp(psd, index, direction), NFFT, RATE, seed_key=KEY),
    )


@pytest.mark.parametrize("index", [0, 37, BINS - 1])
def test_a_bleed_fill_reads_the_same_noise_after_a_one_ulp_spectrum_difference(
    index: int,
) -> None:
    psd = _psd()
    a = _fill(psd).noise(12_345, 40_000, RATE)
    b = _fill(_one_ulp(psd, index, 1.0)).noise(12_345, 40_000, RATE)

    assert _same_noise(a, b)


def test_a_bleed_fill_realised_at_another_rate_ignores_a_one_ulp_difference() -> None:
    psd = _psd()
    a = _fill(psd).noise(0, 40_000, 48_000)
    b = _fill(_one_ulp(psd, 100, -1.0)).noise(0, 40_000, 48_000)

    assert _same_noise(a, b)


def test_clearly_different_spectra_give_different_noise() -> None:
    psd = _psd()
    tilted = psd * np.linspace(4.0, 0.25, BINS)

    a = synthesise_noise(psd, NFFT, RATE, seed_key=KEY)
    b = synthesise_noise(tilted, NFFT, RATE, seed_key=KEY)

    assert not _same_noise(a, b)
    assert not np.allclose(np.abs(np.fft.rfft(a)), np.abs(np.fft.rfft(b)), rtol=0.1)


def test_synthesis_is_deterministic_for_one_spectrum() -> None:
    psd = _psd()

    first = synthesise_noise(psd, NFFT, RATE, seed_key=KEY)

    assert np.array_equal(first, synthesise_noise(psd.copy(), NFFT, RATE, seed_key=KEY))


def test_two_tracks_with_one_spectrum_do_not_share_one_noise() -> None:
    """Two lanes with one spectrum never get the same fill sequence."""
    psd = _psd()
    host = BleedFill(
        "comfort_noise", -60.0, -60.0, None, RATE, NFFT, tuple(psd), seed_key="host"
    ).noise(0, 40_000, RATE)
    guest = BleedFill(
        "comfort_noise", -60.0, -60.0, None, RATE, NFFT, tuple(psd), seed_key="guest"
    ).noise(0, 40_000, RATE)

    assert abs(float(np.corrcoef(host, guest)[0, 1])) < 0.05


def test_digest_still_tells_clearly_different_spectra_apart() -> None:
    psd = _psd()

    assert _fill(psd).digest != _fill(psd * 1.5).digest


def test_the_bleed_and_recorder_gate_keys_of_one_track_give_different_loops() -> None:
    psd = _psd()
    bleed = synthesise_noise(psd, NFFT, RATE, seed_key="host:comfort_noise")
    gate = synthesise_noise(psd, NFFT, RATE, seed_key="recorder-gate:host:comfort_noise")

    assert abs(float(np.corrcoef(bleed, gate)[0, 1])) < 0.05
