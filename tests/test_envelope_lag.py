"""Envelope lag estimator (#1068): a peak on the search boundary is no evidence of a lag."""

from __future__ import annotations

import numpy as np

from podcast_mcp.engines.envelope_lag import envelope_lag

HOP_SEC = 0.005
REACH = 100
SIZE = 40000
SMOOTH = 120


def _smooth_noise(seed: int) -> np.ndarray:
    """Level-like series whose correlation falls off smoothly with lag."""
    noise = np.random.default_rng(seed).standard_normal(SIZE + SMOOTH)
    return np.convolve(noise, np.ones(SMOOTH) / SMOOTH, mode="valid")[:SIZE] * 10


def _copy(own: np.ndarray, lag: int) -> np.ndarray:
    """``peer[t + lag] == own[t]``, plus a little noise."""
    return np.roll(own, lag) + 0.02 * np.random.default_rng(9).standard_normal(own.size)


def _estimate(own: np.ndarray, peer: np.ndarray):
    frames = np.arange(REACH, SIZE - REACH)
    return envelope_lag(own, peer, frames, reach=REACH, hop_sec=HOP_SEC, min_frames=100)


def test_lag_beyond_the_window_abstains_instead_of_returning_the_edge() -> None:
    own = _smooth_noise(1)

    assert _estimate(own, _copy(own, REACH + 30)) is None


def test_lag_beyond_the_window_on_the_negative_side_abstains() -> None:
    own = _smooth_noise(2)

    assert _estimate(own, _copy(own, -(REACH + 30))) is None


def test_lag_one_step_inside_the_window_is_found() -> None:
    own = _smooth_noise(3)

    found = _estimate(own, _copy(own, REACH - 1))

    assert found is not None and found.lag == REACH - 1 and found.supported


def test_negative_lag_one_step_inside_the_window_is_found() -> None:
    own = _smooth_noise(4)

    found = _estimate(own, _copy(own, -(REACH - 1)))

    assert found is not None and found.lag == -(REACH - 1) and found.supported


def test_lag_inside_the_window_is_found() -> None:
    own = _smooth_noise(5)

    found = _estimate(own, _copy(own, 28))

    assert found is not None and found.lag == 28 and found.supported


def test_flat_correlation_abstains() -> None:
    own = _smooth_noise(6)

    assert _estimate(own, np.full(SIZE, -40.0)) is None
    assert _estimate(np.full(SIZE, -40.0), own) is None
