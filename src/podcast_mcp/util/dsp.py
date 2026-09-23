"""Small shared numpy DSP primitives (level, pitch-lag autocorrelation, runs).

Callers keep their own thresholds and policy; these helpers only measure, so
level floors and pitch ranges cannot silently drift between private copies.
"""

from __future__ import annotations

import math

import numpy as np

# Below this linear RMS a frame is treated as digital silence (-200 dBFS).
_SILENCE_RMS = 1e-10


def rms_db(samples: np.ndarray, *, floor_db: float = -80.0) -> float:
    """RMS level in dBFS; empty or digitally silent input returns ``floor_db``."""
    if samples.size == 0:
        return floor_db
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    if rms < _SILENCE_RMS:
        return floor_db
    return 20.0 * math.log10(rms)


def frame_rms_db(
    samples: np.ndarray,
    frame: int,
    hop: int,
    *,
    max_frames: int | None = None,
    floor_db: float = -200.0,
) -> np.ndarray:
    """Vectorized per-frame RMS dB for overlapping ``frame``-sample windows every ``hop``."""
    if frame <= 0 or hop <= 0 or samples.size < frame:
        return np.empty(0, dtype=np.float64)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop]
    if max_frames is not None:
        windows = windows[:max_frames]
    rms = np.sqrt(np.mean(np.square(windows, dtype=np.float64), axis=1))
    out = np.full(rms.shape, floor_db, dtype=np.float64)
    loud = rms >= _SILENCE_RMS
    out[loud] = 20.0 * np.log10(rms[loud])
    return out


def autocorr_peak(
    samples: np.ndarray,
    sample_rate: int,
    *,
    fmin: float,
    fmax: float,
) -> tuple[float, float] | None:
    """Strongest normalized autocorrelation peak over pitch lags ``[sr/fmax, sr/fmin)``.

    Returns ``(f0_hz, normalized_peak)`` where the peak is divided by the
    zero-lag energy of the mean-removed frame, or ``None`` when the frame has no
    energy or is too short to cover the lag range (lags are capped at half the
    frame so the estimate always has at least two periods of support).
    """
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
    lag = int(np.argmax(seg)) + min_lag
    return float(sample_rate) / float(lag), float(corr[lag]) / energy


def bool_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Half-open ``(start, end)`` index spans of contiguous ``True`` values."""
    flags = np.asarray(mask, dtype=bool)
    if flags.size == 0:
        return []
    edges = np.diff(np.concatenate(([False], flags, [False])).astype(np.int8))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    return [(int(s), int(e)) for s, e in zip(starts, ends, strict=True)]


def bridge_short_dips(mask: np.ndarray, max_dip: int) -> np.ndarray:
    """Copy of ``mask`` with interior ``False`` runs of at most ``max_dip`` filled."""
    out = np.asarray(mask, dtype=bool).copy()
    if max_dip <= 0:
        return out
    for start, end in bool_runs(~out):
        if start > 0 and end < out.size and end - start <= max_dip:
            out[start:end] = True
    return out
