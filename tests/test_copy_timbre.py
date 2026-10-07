"""A copy lag is confirmed by the copy's timbre against the peer's other speech (#1070).

These pin the case the nulls a second or two away cannot judge: a peer who speaks in
short bursts far apart, so it is silent at every near null.
"""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines import copy_timbre
from podcast_mcp.engines.copy_timbre import confirmed_likeness
from podcast_mcp.engines.envelope_lag import COPY_HOP_SEC, copy_levels_db

RATE = 8000
LAG_SEC = 0.14
LAG = round(LAG_SEC / COPY_HOP_SEC)
DURATION = 120.0
BURST_SEC = 0.5


def _bursts(gaps: tuple[float, float], seed: int) -> list[float]:
    """Burst starts from 5 s on, ``gaps`` apart (min, max) after each burst ends."""
    rng = np.random.default_rng(seed)
    starts, start = [], 5.0
    while start < DURATION - 5.0:
        starts.append(start)
        start += BURST_SEC + rng.uniform(*gaps)
    return starts


def _voice(starts: list[float], pitches: list[float], seed: int) -> np.ndarray:
    """One harmonic burst per start at its pitch, each with its own phases."""
    rng = np.random.default_rng(seed)
    out = np.zeros(round(DURATION * RATE))
    clock = np.arange(round(BURST_SEC * RATE)) / RATE
    shape = np.sin(np.pi * clock / BURST_SEC) ** 2
    for start, pitch in zip(starts, pitches, strict=True):
        tone = sum(
            np.sin(2 * np.pi * h * pitch * clock + rng.uniform(0, 2 * np.pi)) / h
            for h in range(1, int(3000 / pitch))
        )
        first = round(start * RATE)
        out[first : first + clock.size] += 0.1 * tone * shape
    return out


def _check(own: np.ndarray, peer: np.ndarray) -> float | None:
    """The gate's call: frames where the peer's direct track talks, at the 140 ms lag."""
    noise = np.random.default_rng(5).normal(0, 1e-4, (2, own.size))
    own, peer = own + noise[0], peer + noise[1]
    levels = copy_levels_db(peer, sample_rate=RATE)
    at = np.arange(levels.size - LAG)
    talking = levels[at + LAG] > -40.0
    loud_db = float(np.median(levels[at[talking] + LAG]))
    frames = at[talking & (levels[at + LAG] >= loud_db)]
    return confirmed_likeness(own, peer, frames, LAG, levels, loud_db, sample_rate=RATE)


def _copy_of(peer: np.ndarray) -> np.ndarray:
    """The peer's voice on another mic, ``LAG_SEC`` ahead of the peer's own track."""
    lead = round(LAG_SEC * RATE)
    return 0.15 * np.concatenate([peer[lead:], np.zeros(lead)])


def test_a_copy_of_a_peer_speaking_in_sparse_bursts_is_confirmed() -> None:
    """Bursts 3 to 6 s apart: the near nulls are silent, the peer's farther speech judges."""
    starts = _bursts((2.5, 5.5), seed=1)
    pitches = list(np.random.default_rng(2).uniform(100, 250, len(starts)))
    peer = _voice(starts, pitches, seed=3)

    assert _check(_copy_of(peer), peer) is not None


def test_own_hum_with_a_sparse_peer_at_one_pitch_is_no_copy() -> None:
    """Own bursts start and stop with the peer's at the same steady pitch, each its own phase.

    They match the peer at the lag as a copy would, but they match its other bursts as
    well, so the timbre does not prove the lag.
    """
    starts = _bursts((2.5, 5.5), seed=1)
    peer = _voice(starts, [150.0] * len(starts), seed=3)
    own = _voice([start - LAG_SEC for start in starts], [150.0] * len(starts), seed=4)

    assert _check(own, peer) is None


def test_no_peer_speech_to_compare_against_is_no_copy() -> None:
    """A peer silent for more than 10 s around every burst leaves nothing to compare with.

    Even a true copy then goes unconfirmed: no comparison, no copy.
    """
    starts = _bursts((12.0, 15.0), seed=1)
    pitches = list(np.random.default_rng(2).uniform(100, 250, len(starts)))
    peer = _voice(starts, pitches, seed=3)

    assert _check(_copy_of(peer), peer) is None


def _confirmed_with(
    monkeypatch: pytest.MonkeyPatch, likeness: float, null: float, frame_count: int
) -> float | None:
    """``confirmed_likeness`` when every frame matches the peer ``likeness`` at any lag
    and ``null`` at every null."""
    monkeypatch.setattr(
        copy_timbre,
        "copy_similarity",
        lambda _own, _peer, frames, *_a, **_k: np.full(frames.size, likeness),
    )
    monkeypatch.setattr(
        copy_timbre,
        "_null_similarities",
        lambda *_a, **_k: [np.full(5, null), np.full(5, null - 0.2)],
    )
    frames = np.arange(frame_count)
    return confirmed_likeness(
        np.zeros(1), np.zeros(1), frames, 14, np.zeros(20), -30.0, sample_rate=RATE
    )


@pytest.mark.parametrize(("likeness", "confirmed"), [(0.149, False), (0.151, True)])
def test_a_null_under_zero_counts_as_zero(
    monkeypatch: pytest.MonkeyPatch, likeness: float, confirmed: bool
) -> None:
    """Own frames that anti-match the peer elsewhere still need a likeness of the margin."""
    got = _confirmed_with(monkeypatch, likeness, -0.1, 60)

    assert (got is not None) is confirmed


@pytest.mark.parametrize(("frame_count", "confirmed"), [(49, False), (50, True)])
def test_the_timbre_needs_half_a_second_of_copy_frames(
    monkeypatch: pytest.MonkeyPatch, frame_count: int, confirmed: bool
) -> None:
    """A percentile of a few frames against nulls of fewer still is chance: a co-timed
    own voice once passed on 6 frames."""
    got = _confirmed_with(monkeypatch, 0.9, 0.0, frame_count)

    assert (got is not None) is confirmed
