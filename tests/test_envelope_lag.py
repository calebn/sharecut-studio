"""Envelope lag estimator: a boundary peak abstains (#1068); scoring matches the per-lag loop (#1092).

A copy path under 30 s of the peer's speech needs a stronger level match (#1070).
"""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines import envelope_lag as envelope_lag_module
from podcast_mcp.engines.envelope_lag import NULL_SHIFTS_SEC, EnvelopeLag, copy_lag, envelope_lag

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


def _reference_envelope_lag(
    own: np.ndarray,
    peer: np.ndarray,
    frames: np.ndarray,
    *,
    reach: int,
    hop_sec: float,
    min_frames: int,
) -> EnvelopeLag | None:
    """The per-lag loop ``envelope_lag`` replaced: one masked ``np.corrcoef`` per shift."""

    def correlation(shift: int) -> float | None:
        usable = frames[(frames + shift >= 0) & (frames + shift < peer.size)]
        if usable.size < min_frames:
            return None
        x, y = own[usable], peer[usable + shift]
        if x.std() == 0 or y.std() == 0:
            return 0.0
        return float(np.corrcoef(x, y)[0, 1])

    scored = [
        (value, lag) for lag in range(-reach, reach + 1) if (value := correlation(lag)) is not None
    ]
    if not scored:
        return None
    best, lag = max(scored)
    around = (correlation(lag - 1), correlation(lag + 1))
    if abs(lag) >= reach or any(side is None or side >= best for side in around):
        return None
    nulls = [
        value
        for shift in NULL_SHIFTS_SEC
        if (value := correlation(lag + round(shift / hop_sec))) is not None
    ]
    return EnvelopeLag(lag, best, max(nulls, default=1.0))


def _random_case(seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, float, int]:
    """A random envelope pair, frame subset, reach, hop and ``min_frames`` for one seed."""
    rng = np.random.default_rng(seed)
    own_size = int(rng.integers(150, 1200))
    peer_size = own_size + int(rng.integers(-60, 60))
    smooth = int(rng.integers(1, 30))
    own = np.convolve(rng.standard_normal(own_size + smooth), np.ones(smooth), mode="valid")[
        :own_size
    ]
    reach = int(rng.integers(1, 40))
    kind = int(rng.integers(0, 6))
    if kind == 0:
        peer = rng.standard_normal(peer_size)
    elif kind == 1:
        lag = int(rng.integers(-reach - 5, reach + 6))
        peer = np.roll(np.resize(own, peer_size), lag) + 0.05 * rng.standard_normal(peer_size)
    elif kind == 2:
        peer = np.full(peer_size, -40.0)
    elif kind == 3:
        peer = np.resize(own, peer_size) * 1.0
        peer[: int(rng.integers(0, peer_size))] = -90.0
    elif kind == 4:
        peer = np.resize(np.round(own), peer_size)
    else:
        peer = np.full(peer_size, -90.0)
        peer[rng.integers(0, peer_size, size=int(rng.integers(1, 6)))] = rng.uniform(-60, -20)
    if rng.random() < 0.15:
        own = np.full(own_size, -90.0)
    layout = int(rng.integers(0, 4))
    if layout == 0:
        frames = np.sort(rng.choice(own_size, size=int(rng.integers(2, own_size)), replace=False))
    elif layout == 1:
        first = int(rng.integers(0, own_size // 2))
        frames = np.arange(first, int(rng.integers(first + 2, own_size + 1)))
    elif layout == 2:
        frames = np.concatenate(
            [np.arange(0, int(rng.integers(2, 30))), np.arange(own_size - 25, own_size)]
        )
    else:
        frames = rng.permutation(
            rng.choice(own_size, size=int(rng.integers(2, 150)), replace=False)
        )
    shifts = np.arange(-reach - 1, reach + 2)
    counts = [int(((frames + s >= 0) & (frames + s < peer_size)).sum()) for s in shifts]
    min_frames = max(1, int(rng.choice(counts)) + int(rng.integers(-1, 2)))
    hop_sec = float(rng.choice([0.005, 0.05, 0.2, 0.5, 1.0]))
    return own, peer, frames, reach, hop_sec, min_frames


def _both(seed: int) -> tuple[EnvelopeLag | None, EnvelopeLag | None]:
    own, peer, frames, reach, hop_sec, min_frames = _random_case(seed)
    return (
        envelope_lag(own, peer, frames, reach=reach, hop_sec=hop_sec, min_frames=min_frames),
        _reference_envelope_lag(
            own, peer, frames, reach=reach, hop_sec=hop_sec, min_frames=min_frames
        ),
    )


CASES = 400


@pytest.mark.parametrize("seed", range(CASES))
def test_scoring_matches_the_per_lag_reference(seed: int) -> None:
    got, want = _both(seed)

    if want is None:
        assert got is None
        return
    assert got is not None
    assert got.lag == want.lag
    assert got.correlation == pytest.approx(want.correlation, abs=1e-9)
    assert got.null_correlation == pytest.approx(want.null_correlation, abs=1e-9)


def test_random_cases_reach_every_branch_of_the_estimator() -> None:
    wants = [_both(seed)[1] for seed in range(CASES)]
    found = [want for want in wants if want is not None]

    assert len(found) > 30 and len(wants) - len(found) > 30
    assert any(want.supported for want in found)
    assert any(want.null_correlation == 1.0 for want in found)
    assert any(want.lag < 0 for want in found) and any(want.lag > 0 for want in found)


def test_equal_correlations_resolve_to_the_larger_lag() -> None:
    own = np.tile([0.0, 1.0], 50)
    frames = np.arange(20, 80)

    for estimate in (envelope_lag, _reference_envelope_lag):
        found = estimate(own, own, frames, reach=5, hop_sec=0.5, min_frames=10)

        assert found == EnvelopeLag(lag=4, correlation=1.0, null_correlation=1.0)


def test_too_few_frames_in_range_abstain() -> None:
    own = _smooth_noise(7)
    peer = _copy(own, 0)
    frames = np.arange(0, 150)

    assert envelope_lag(own, peer, frames, reach=30, hop_sec=HOP_SEC, min_frames=151) is None
    assert envelope_lag(own, peer, frames[:0], reach=30, hop_sec=HOP_SEC, min_frames=1) is None


def _copy_lag_with_match(
    monkeypatch: pytest.MonkeyPatch, frame_count: int, correlation: float
) -> int | None:
    """``copy_lag`` over ``frame_count`` frames when the level match is ``correlation``.

    The estimate itself is pinned above, so it is replaced by a supported 120 ms lag
    with that correlation and a null well under it: only the evidence floor decides.
    """
    found = EnvelopeLag(lag=14, correlation=correlation, null_correlation=0.0)
    monkeypatch.setattr(envelope_lag_module, "envelope_lag", lambda *_args, **_kwargs: found)
    levels = np.zeros(frame_count + 100)
    return copy_lag(levels, levels, np.arange(frame_count))


@pytest.mark.parametrize(
    ("frame_count", "correlation"),
    [
        pytest.param(2000, 0.40, id="20s-at-the-30s-floor"),
        pytest.param(2000, 0.47, id="20s-just-under-0.48"),
        pytest.param(2250, 0.45, id="22.5s"),
        pytest.param(2500, 0.43, id="25s"),
    ],
)
def test_a_short_stretch_with_a_weaker_match_than_its_floor_abstains(
    monkeypatch: pytest.MonkeyPatch, frame_count: int, correlation: float
) -> None:
    """Under 30 s the match must carry 30 s worth of evidence at 0.4: 0.48 over 20 s."""
    assert _copy_lag_with_match(monkeypatch, frame_count, correlation) is None


@pytest.mark.parametrize(
    ("frame_count", "correlation", "trusted"),
    [
        pytest.param(2000, 0.4768, False, id="20s-just-under"),
        pytest.param(2000, 0.4769, True, id="20s-at-the-floor"),
        pytest.param(2500, 0.4333, False, id="25s-just-under"),
        pytest.param(2500, 0.4335, True, id="25s-at-the-floor"),
        pytest.param(3000, 0.40, True, id="30s-at-0.4"),
        pytest.param(6000, 0.40, True, id="60s-at-0.4"),
        pytest.param(6000, 0.39, False, id="60s-under-0.4"),
    ],
)
def test_the_evidence_floor_at_its_boundaries(
    monkeypatch: pytest.MonkeyPatch, frame_count: int, correlation: float, trusted: bool
) -> None:
    got = _copy_lag_with_match(monkeypatch, frame_count, correlation)

    assert got == (14 if trusted else None)
