"""Lag between a voice's direct track and its copy on another mic, from level envelopes.

A room colours the copy and Zoom-style processing reshapes its waveform, so sample
cross-correlation is weak (the lab tape peaks near 0.1). Level envelopes keep the
syllable rhythm both tracks share; the best lag is tested against shifted nulls.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from podcast_mcp.util.dsp import frame_rms_db_stream

LEVEL_FLOOR_DB = -90.0
NULL_SHIFTS_SEC = (-2.0, -1.0, 1.0, 2.0)
MIN_CORRELATION = 0.4
MIN_NULL_MARGIN = 0.15


def level_envelope_db(
    samples: np.ndarray, *, sample_rate: int, frame_sec: float, hop_sec: float
) -> np.ndarray:
    """Frame RMS in dB on a ``hop_sec`` grid, floored so gated digital silence is one value."""
    frame, hop = round(frame_sec * sample_rate), round(hop_sec * sample_rate)
    levels = frame_rms_db_stream(
        (samples[first : first + sample_rate] for first in range(0, samples.size, sample_rate)),
        frame,
        hop,
    )
    return np.maximum(levels, LEVEL_FLOOR_DB)


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

    None when too few frames stay in range. A lag without at least one shifted null
    in range is reported with null correlation 1.0, so it is never supported.
    """

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
    nulls = [
        value
        for shift in NULL_SHIFTS_SEC
        if (value := correlation(lag + round(shift / hop_sec))) is not None
    ]
    return EnvelopeLag(lag, best, max(nulls, default=1.0))
