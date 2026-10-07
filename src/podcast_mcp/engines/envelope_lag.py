"""Lag between a voice's direct track and its copy on another mic, from level envelopes.

A room colours the copy and Zoom-style processing reshapes its waveform, so sample
cross-correlation is weak (the lab tape peaks near 0.1). Level envelopes keep the
syllable rhythm both tracks share; the best lag is tested against shifted nulls.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import numpy as np

from podcast_mcp.util.dsp import frame_db_stream, frame_peak_db, frame_rms_db, frame_rms_db_stream

LEVEL_FLOOR_DB = -90.0
NULL_SHIFTS_SEC = (-2.0, -1.0, 1.0, 2.0)
MIN_CORRELATION = 0.4
MIN_NULL_MARGIN = 0.15
# A peer's copy on another mic (``copy_lag``): levels on a COPY_HOP_SEC grid, searched
# within MAX_COPY_LAG_SEC over frames where the peer's track is open above PEER_OPEN_DB,
# with MIN_COPY_SEC of them.
COPY_FRAME_SEC = 0.1
COPY_HOP_SEC = 0.01
MAX_COPY_LAG_SEC = 0.3
MIN_COPY_SEC = 30.0
CONTOUR_SEC = 0.5
PEER_OPEN_DB = -60.0
_BLOCK_ELEMENTS = 1 << 18


def level_envelope_db(
    samples: np.ndarray, *, sample_rate: int, frame_sec: float, hop_sec: float
) -> np.ndarray:
    """Frame RMS in dB on a ``hop_sec`` grid, floored so gated digital silence is one value."""
    return stream_level_envelope_db(
        (samples[first : first + sample_rate] for first in range(0, samples.size, sample_rate)),
        sample_rate=sample_rate,
        frame_sec=frame_sec,
        hop_sec=hop_sec,
    )


def stream_level_envelope_db(
    chunks: Iterable[np.ndarray], *, sample_rate: int, frame_sec: float, hop_sec: float
) -> np.ndarray:
    """:func:`level_envelope_db` over a forward-only chunk stream (a whole track at full rate)."""
    frame, hop = round(frame_sec * sample_rate), round(hop_sec * sample_rate)
    return np.maximum(frame_rms_db_stream(chunks, frame, hop), LEVEL_FLOOR_DB)


def stream_level_and_peak_db(
    chunks: Iterable[np.ndarray], *, sample_rate: int, frame_sec: float, hop_sec: float
) -> tuple[np.ndarray, np.ndarray]:
    """:func:`stream_level_envelope_db` and each frame's sample peak (dB), in one pass."""
    frame, hop = round(frame_sec * sample_rate), round(hop_sec * sample_rate)
    level, peak = frame_db_stream(chunks, frame, hop, (frame_rms_db, frame_peak_db))
    return np.maximum(level, LEVEL_FLOOR_DB), np.maximum(peak, LEVEL_FLOOR_DB)


@dataclass(frozen=True)
class EnvelopeLag:
    """Best lag in hops; positive means ``peer`` trails ``own``."""

    lag: int
    correlation: float
    null_correlation: float

    @property
    def supported(self) -> bool:
        return (
            self.correlation >= MIN_CORRELATION
            and self.correlation - self.null_correlation >= MIN_NULL_MARGIN
        )


def _pearson_rows(
    x: np.ndarray, peer: np.ndarray, frames: np.ndarray, shifts: np.ndarray
) -> np.ndarray:
    """Pearson correlation of ``x`` with ``peer[frames + shift]`` per shift, 0.0 when flat.

    Every ``frames + shift`` must be in range. Shifts go in blocks so the (shifts x frames)
    work arrays hold about ``_BLOCK_ELEMENTS`` values however many frames a window has.
    """
    scores = np.zeros(shifts.size)
    dx = x - x.mean()
    var_x = float(dx @ dx)
    if var_x == 0:
        return scores
    block = max(1, _BLOCK_ELEMENTS // frames.size)
    for first in range(0, shifts.size, block):
        y = peer[frames[None, :] + shifts[first : first + block, None]]
        y -= y.mean(axis=1, keepdims=True)
        var_y = np.einsum("ij,ij->i", y, y)
        live = var_y > 0
        r = (y @ dx) / np.sqrt(var_x * np.where(live, var_y, 1.0))
        scores[first : first + block] = np.where(live, np.clip(r, -1.0, 1.0), 0.0)
    return scores


def _correlations(
    own: np.ndarray, peer: np.ndarray, frames: np.ndarray, shifts: np.ndarray, min_frames: int
) -> np.ndarray:
    """Correlation of ``own[frames]`` with ``peer[frames + shift]`` per shift.

    NaN where fewer than ``min_frames`` frames stay in range. Shifts that keep every frame
    in range, which is every lag within reach of a window, are scored in one batch; the
    rare shift that clips frames (a null near the track end) is scored on its usable frames.
    """
    own, peer = np.asarray(own, dtype=float), np.asarray(peer, dtype=float)
    scores = np.full(shifts.size, np.nan)
    if frames.size == 0:
        return scores
    whole = (shifts >= -frames.min()) & (shifts < peer.size - frames.max())
    if frames.size >= min_frames and whole.any():
        scores[whole] = _pearson_rows(own[frames], peer, frames, shifts[whole])
    for i in np.flatnonzero(~whole):
        usable = frames[(frames + shifts[i] >= 0) & (frames + shifts[i] < peer.size)]
        if usable.size >= min_frames and usable.size > 0:
            scores[i] = _pearson_rows(own[usable], peer, usable, shifts[i : i + 1])[0]
    return scores


def envelope_lag(
    own: np.ndarray,
    peer: np.ndarray,
    frames: np.ndarray,
    *,
    reach: int,
    hop_sec: float,
    min_frames: int,
) -> EnvelopeLag | None:
    """Correlate ``own[frames]`` with ``peer[frames + lag]`` for ``|lag| <= reach`` hops.

    None when too few frames stay in range, or when the best lag is not a peak: it
    sits on the search boundary (the true lag is probably outside it) or a neighbouring
    lag correlates as well (flat). A lag without at least one shifted null in range is
    reported with null correlation 1.0, so it is never supported. Equal best
    correlations resolve to the larger lag.
    """
    scores = _correlations(own, peer, frames, np.arange(-reach, reach + 1), min_frames)
    if np.isnan(scores).all():
        return None
    best = float(np.nanmax(scores))
    index = int(np.flatnonzero(scores == best)[-1])
    lag = index - reach
    if abs(lag) >= reach or not (scores[index - 1] < best and scores[index + 1] < best):
        return None
    null_shifts = np.array([lag + round(shift / hop_sec) for shift in NULL_SHIFTS_SEC])
    nulls = _correlations(own, peer, frames, null_shifts, min_frames)
    return EnvelopeLag(lag, best, float(np.nanmax(nulls)) if not np.isnan(nulls).all() else 1.0)


def copy_levels_db(samples: np.ndarray, *, sample_rate: int) -> np.ndarray:
    """Level envelope on the copy grid: 100 ms frames, long enough to span a syllable."""
    return level_envelope_db(
        samples, sample_rate=sample_rate, frame_sec=COPY_FRAME_SEC, hop_sec=COPY_HOP_SEC
    )


def syllable_contour(levels: np.ndarray) -> np.ndarray:
    """Levels less their half-second mean: syllables, not when someone talks."""
    clipped = np.maximum(levels, PEER_OPEN_DB)
    width = round(CONTOUR_SEC / COPY_HOP_SEC) | 1
    padded = np.pad(clipped, width // 2, mode="edge")
    return clipped - np.convolve(padded, np.ones(width) / width, mode="valid")


def copy_lag(own: np.ndarray, peer: np.ndarray, frames: np.ndarray) -> int | None:
    """Hops by which the peer's own track trails its copy in ``own``, if levels prove a copy.

    ``own`` and ``peer`` are :func:`copy_levels_db` envelopes and ``frames`` the ``own``
    frames around the peer's speech. Zoom delivers a remote speaker's track well after
    the same voice reaches a mic in the room (about 140 ms on the lab tape), and the
    room colours the copy, so the copy is found in the level envelope at the best lag,
    against shifted nulls.

    Two voices that start and stop together also correlate in level, so only the
    syllable contour is compared, and a path needs 30 s of frames around the peer's
    words. In synthetic trials of 200 pairs each, independent voices and voices that
    start and stop together never passed with 30 s, whether the words were scattered
    or one long phrase, and true copies always did. At 20 s, 8 in 200 co-timed long
    phrases still passed. Below the minimum the estimate abstains, as it does when the
    best lag is not a peak inside the search (#1068).
    """
    found = envelope_lag(
        syllable_contour(own),
        syllable_contour(peer),
        frames,
        reach=round(MAX_COPY_LAG_SEC / COPY_HOP_SEC),
        hop_sec=COPY_HOP_SEC,
        min_frames=round(MIN_COPY_SEC / COPY_HOP_SEC),
    )
    return found.lag if found is not None and found.supported else None
