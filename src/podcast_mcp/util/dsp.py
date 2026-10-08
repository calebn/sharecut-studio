"""Small shared numpy DSP primitives (level, pitch-lag autocorrelation, runs).

Callers keep their own thresholds and policy; these helpers only measure, so
level floors and pitch ranges cannot silently drift between private copies.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence

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


# The speech band: a raised-cosine high-pass, stopped at 50 Hz and passed from 120 Hz.
_BAND_STOP_HZ = 50.0
_BAND_PASS_HZ = 120.0


def next_fast_len(n: int) -> int:
    """The smallest length ``>= n`` whose only prime factors are 2, 3 and 5.

    The FFT is fast at such a length and slow at a prime one (a pause plus 10 s is any
    sample count at all), so callers pad to it.
    """
    best = 1 << max(0, n - 1).bit_length()
    five = 1
    while five < best:
        smooth = five
        while smooth < best:
            length = smooth
            while length < n:
                length *= 2
            best = min(best, length)
            smooth *= 3
        five *= 5
    return best


def speech_band(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """``samples`` with the rumble below the speech band removed.

    A raised-cosine high-pass from 50 Hz (stopped) to 120 Hz (passed), applied zero-phase
    over the whole array. A noise gate's digital silence stays digital silence: the
    filter's ringing is not let into the gate's zeros.
    """
    if samples.size < 64:
        return samples
    size = next_fast_len(samples.size)
    spectrum = np.fft.rfft(samples, n=size)
    freqs = np.fft.rfftfreq(size, d=1.0 / sample_rate)
    ramp = np.clip((freqs - _BAND_STOP_HZ) / (_BAND_PASS_HZ - _BAND_STOP_HZ), 0.0, 1.0)
    spectrum *= (1.0 - np.cos(np.pi * ramp)) / 2.0
    filtered = np.fft.irfft(spectrum, n=size)[: samples.size]
    return np.where(samples != 0.0, filtered, 0.0).astype(samples.dtype, copy=False)


def frame_speech_band_db(
    samples: np.ndarray, sample_rate: int, frame: int, *, floor_db: float = -200.0
) -> np.ndarray:
    """Per-frame dB level of ``samples`` in the speech band, on :func:`frame_rms_db`'s grid.

    Room rumble, desk thumps and the mains fundamental sit below the band and can be
    10 dB over a room tone's broadband air, hiding every breath and fade that rides on
    them. Mains hum's harmonics at 100, 120 and 150 Hz pass the band (100 Hz 2 dB down,
    the rest untouched), so a hum shows in the levels and is the room's own spread to
    read, not removed here. A frame reads no louder than it does unfiltered: the filter spreads a loud neighbour's energy a few frames each way, and
    that ringing is no sound of the frame's own.
    """
    full = frame_rms_db(samples, frame, frame, floor_db=floor_db)
    heard = frame_rms_db(speech_band(samples, sample_rate), frame, frame, floor_db=floor_db)
    return np.minimum(full, heard)


def frame_level_noise_db(sample_rate: int, frame_sec: float) -> float:
    """The std, in dB, of one frame's level over stationary Gaussian noise in the speech band.

    A frame of band-limited noise estimates its power from ``2 * bandwidth * frame_sec``
    independent samples, so even a perfectly steady room reads a few tenths of a dB
    apart from frame to frame. No room is steadier than this, which makes it the least
    spread a measured room can have.
    """
    bandwidth = sample_rate / 2.0 - _BAND_PASS_HZ
    return (10.0 / math.log(10.0)) / math.sqrt(bandwidth * frame_sec)


def frame_band_db(
    samples: np.ndarray,
    sample_rate: int,
    frame: int,
    hop: int,
    *,
    lo_hz: float,
    floor_db: float = -200.0,
) -> np.ndarray:
    """Per-frame dB level of the signal's content at or above ``lo_hz``.

    Same frame grid as :func:`frame_rms_db`; a frame of full-band white noise reads
    about its RMS level plus ``10 * log10(1 - 2 * lo_hz / sample_rate)``.
    """
    if frame <= 0 or hop <= 0 or samples.size < frame:
        return np.empty(0, dtype=np.float64)
    window = np.hanning(frame)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop] * window
    power = np.abs(np.fft.rfft(windows, axis=1)) ** 2
    band = np.fft.rfftfreq(frame, d=1.0 / sample_rate) >= lo_hz
    mean_square = 2.0 * np.sum(power[:, band], axis=1) / (frame * float(np.sum(window**2)))
    out = np.full(mean_square.shape, floor_db, dtype=np.float64)
    loud = mean_square >= _SILENCE_RMS**2
    out[loud] = 10.0 * np.log10(mean_square[loud])
    return out


def frame_peak_db(
    samples: np.ndarray, frame: int, hop: int, *, floor_db: float = -200.0
) -> np.ndarray:
    """Per-frame sample peak in dB on the :func:`frame_rms_db` frame grid."""
    if frame <= 0 or hop <= 0 or samples.size < frame:
        return np.empty(0, dtype=np.float64)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop]
    peak = np.abs(windows).max(axis=1).astype(np.float64)
    out = np.full(peak.shape, floor_db, dtype=np.float64)
    loud = peak >= _SILENCE_RMS
    out[loud] = 20.0 * np.log10(peak[loud])
    return out


def frame_db_stream(
    chunks: Iterable[np.ndarray],
    frame: int,
    hop: int,
    reducers: Sequence[Callable[[np.ndarray, int, int], np.ndarray]],
) -> tuple[np.ndarray, ...]:
    """Per-frame reductions (:func:`frame_rms_db`, :func:`frame_peak_db`) over a chunk stream.

    Same frames and values as on the concatenated samples, holding one chunk plus
    fewer than ``frame`` carried samples, in one pass for every reducer. The carry-buffer
    loop has the same shape as ``engines.asr_silence.peak_envelope`` and
    ``engines.waveform_pyramid.build_levels``; those reduce whole blocks or bins, not
    overlapping frames, so they stay separate. A new overlapping-frame reduction is a
    reducer here, not another loop.
    """
    if frame <= 0 or hop <= 0:
        return tuple(np.empty(0, dtype=np.float64) for _ in reducers)
    parts: list[list[np.ndarray]] = [[] for _ in reducers]
    carry = np.zeros(0, dtype=np.float32)
    for chunk in chunks:
        buf = np.concatenate([carry, np.asarray(chunk).reshape(-1)])
        levels = [reduce(buf, frame, hop) for reduce in reducers]
        for part, level in zip(parts, levels, strict=True):
            if level.size:
                part.append(level)
        carry = buf[levels[0].size * hop :] if levels else buf
    return tuple(np.concatenate(part) if part else np.empty(0, dtype=np.float64) for part in parts)


def frame_rms_db_stream(
    chunks: Iterable[np.ndarray], frame: int, hop: int, *, floor_db: float = -200.0
) -> np.ndarray:
    """:func:`frame_rms_db` over a forward-only chunk stream (see :func:`frame_db_stream`)."""
    return frame_db_stream(
        chunks, frame, hop, (lambda buf, f, h: frame_rms_db(buf, f, h, floor_db=floor_db),)
    )[0]


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


def high_band_energy_fraction(
    samples: np.ndarray,
    sample_rate: int,
    *,
    split_hz: float,
    lo_hz: float,
    hi_hz: float,
) -> float:
    """Share of the ``[lo_hz, hi_hz]`` spectral energy that lies at or above ``split_hz``.

    One Hann-windowed spectrum over the whole input; silent or too-short input
    scores 0.0.
    """
    if samples.size < 2:
        return 0.0
    x = samples.astype(np.float64, copy=True)
    x -= np.mean(x)
    power = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    freqs = np.fft.rfftfreq(x.size, d=1.0 / sample_rate)
    band = (freqs >= lo_hz) & (freqs <= hi_hz)
    total = float(np.sum(power[band]))
    if total <= 1e-20:
        return 0.0
    return float(np.sum(power[band & (freqs >= split_hz)]) / total)


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
