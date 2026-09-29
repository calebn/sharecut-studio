"""Small shared numpy DSP primitives (level, pitch-lag autocorrelation, runs).

Callers keep their own thresholds and policy; these helpers only measure, so
level floors and pitch ranges cannot silently drift between private copies.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

import numpy as np

# Below this linear RMS a frame is treated as digital silence (-200 dBFS).
_SILENCE_RMS = 1e-10


def clamp01(value: float) -> float:
    """Clamp a scalar to the unit interval."""
    return float(max(0.0, min(1.0, value)))


def clamp(value: float, lo: float | None = None, hi: float | None = None) -> float:
    """Clamp ``value`` to ``[lo, hi]``; a ``None`` bound is open and ``lo`` wins if ``hi < lo``."""
    if hi is not None:
        value = min(value, hi)
    if lo is not None:
        value = max(value, lo)
    return value


def linear_rms(samples: np.ndarray, *, epsilon: float = 0.0) -> float:
    """Linear RMS with caller-selected squared-amplitude floor."""
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)) + epsilon))


def rms_db(samples: np.ndarray, *, floor_db: float = -80.0) -> float:
    """RMS level in dBFS; empty or digitally silent input returns ``floor_db``."""
    if samples.size == 0:
        return floor_db
    rms = linear_rms(samples)
    if rms < _SILENCE_RMS:
        return floor_db
    return 20.0 * math.log10(rms)


def db_to_amplitude(db: float) -> float:
    """Linear amplitude factor for a level in dB (0 dB -> 1.0, -6 dB -> ~0.501)."""
    return float(10.0 ** (db / 20.0))


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


def frame_rms_db_stream(
    chunks: Iterable[np.ndarray], frame: int, hop: int, *, floor_db: float = -200.0
) -> np.ndarray:
    """:func:`frame_rms_db` over a forward-only chunk stream.

    Same frames and values as on the concatenated samples, holding one chunk plus
    fewer than ``frame`` carried samples. The carry-buffer loop has the same shape as
    ``engines.asr_silence.peak_envelope`` and ``engines.waveform_pyramid.build_levels``;
    the reductions differ (overlapping RMS frames, block max, min/max/sum-of-squares
    bins), so they stay separate. If a fourth streaming reducer appears, fold all of
    them into one shared ``util.dsp`` helper instead of adding another copy.
    """
    if frame <= 0 or hop <= 0:
        return np.empty(0, dtype=np.float64)
    parts: list[np.ndarray] = []
    carry = np.zeros(0, dtype=np.float32)
    for chunk in chunks:
        buf = np.concatenate([carry, np.asarray(chunk).reshape(-1)])
        levels = frame_rms_db(buf, frame, hop, floor_db=floor_db)
        if levels.size:
            parts.append(levels)
        carry = buf[levels.size * hop :]
    return np.concatenate(parts) if parts else np.empty(0, dtype=np.float64)


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


def voicing_probes(
    samples: np.ndarray,
    sample_rate: int,
    *,
    probe_sec: float,
    hop_sec: float,
    fmin: float,
    fmax: float,
) -> np.ndarray:
    """Normalized speech-pitch autocorrelation peak of each ``probe_sec`` frame every ``hop_sec``.

    A frame :func:`autocorr_peak` cannot score (silent, or too short for the lag
    range) scores 0.0. Input shorter than one probe is scored as a single frame;
    empty input yields an empty array.
    """
    if samples.size == 0:
        return np.empty(0, dtype=np.float64)
    frame = min(samples.size, max(1, round(sample_rate * probe_sec)))
    hop = max(1, round(sample_rate * hop_sec))
    scores = []
    for start in range(0, samples.size - frame + 1, hop):
        peak = autocorr_peak(samples[start : start + frame], sample_rate, fmin=fmin, fmax=fmax)
        scores.append(peak[1] if peak is not None else 0.0)
    return np.asarray(scores, dtype=np.float64)


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
